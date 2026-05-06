# Web companion: cookie-auth migration

The `web/` SPA shifts off the public Spotify Web API onto Spotify's internal
endpoints (the same ones `open.spotify.com` uses), authenticated by reusing
the user's `sp_dc` browser cookie. PKCE remains as fallback. Reference port:
[`openclaw/spogo`](https://github.com/openclaw/spogo). See repo-root
`PLAN.md` for the parallel TUI plan; this doc covers `web/` only.

## Why the web companion goes first

- Same TypeScript stack as the SPA — no language switch.
- HMR + DevTools network tab give a 5-second feedback loop.
- The Node sidecar architecture this requires also tells us what shape the
  Rust `Backend` trait should take, so the TUI port lands cleaner afterward.

## The CORS / same-origin constraint

A pure-browser implementation is not possible:

- Cookies on `.spotify.com` are unreadable from `127.0.0.1` (same-origin
  policy, no API to bypass).
- `fetch('https://open.spotify.com/api/token', { credentials: 'include' })`
  from `127.0.0.1` is CORS-blocked: Spotify returns
  `Access-Control-Allow-Origin: https://open.spotify.com` (specific), and the
  browser refuses to attach cookies cross-origin to a non-allowlisted caller.
- Pathfinder, spclient, and dealer are similarly locked down.

Therefore: **a Node sidecar holds the cookie and proxies the calls.** Vite's
dev server is already a Node process; we extend it with middleware.

## Architecture

```
web/
  server/                            NEW (Node, runs inside Vite)
    index.ts                         Vite plugin entry; registers routes
    cookies/
      index.ts                       dispatch: safari → file → paste
      safari.ts                      ~/Library/Cookies/Cookies.binarycookies
      file.ts                        ~/Library/Application Support/spotui/web-cookies.json
      paste.ts                       in-memory + persists to file
      types.ts                       SpotifyCookie type, helpers
    spotify/
      totp.ts                        port of spogo totp.go               [phase 1]
      token.ts                       /api/token mint                     [phase 1]
      session.ts                     bearer + clientToken + clientVer    [phase 2]
      pathfinder.ts                  GraphQL persisted-query client      [phase 2]
      hash.ts                        runtime sha256Hash resolver         [phase 2]
      connect.ts                     connect-state/v1 commands           [phase 3]
      dealer.ts                      wss://dealer.spotify.com/           [phase 3]
      lyrics.ts                      spclient color-lyrics/v2            [phase 4]
    routes/
      auth.ts                        /api/auth/*: status, paste, clear   [phase 1]
      proxy.ts                       /api/proxy/*: pathfinder, spclient  [phase 2-4]
  src/                               (existing SPA — surface mostly unchanged)
    api/
      client.ts                      now points at /api (sidecar) by default
      ...
```

The SPA's existing `auth/auth.ts` PKCE flow stays. The sidecar exposes a
unified base URL (`/api`) so `api/client.ts` becomes a thin "talk to sidecar"
layer that doesn't care which backend is in use.

## Auto-discovery (this is part of phase 1)

Goal: opening `http://127.0.0.1:8888` while logged into Spotify on Safari
should Just Work — no copy-paste step.

Discovery order on macOS:

1. **Safari** — read `~/Library/Cookies/Cookies.binarycookies`. Documented
   binary format, parser is ~150 LoC. No permissions prompts; the file is
   under the user's own home dir.
2. **Persisted file** — `~/Library/Application Support/spotui/web-cookies.json`
   (mode 0600). Written by previous paste / discovery runs.
3. **Paste** — interactive form in the SPA; user pastes `sp_dc` (and
   optionally `sp_t`, `sp_key`) from DevTools. We persist to (2).

The dispatcher tries each in order and returns the first source that yields
a non-empty `sp_dc`. If discovery succeeds, we silently persist the
discovered cookies to (2) so re-runs don't depend on Spotify being open in
Safari at that moment.

Failure modes worth surfacing in the SPA:

- Safari has never logged in → no cookies, fall through silently.
- Safari binarycookies format changed → log + fall through.
- All sources empty → SPA shows the paste form.

Other browsers (Chrome, Firefox, Brave) are explicitly out of scope. Users
on those browsers fall through to the paste flow.

## Routes (phase 1)

```
GET  /api/auth/status
  → { mode: "cookie" | "pkce" | "none",
      source: "safari" | "chrome" | "file" | "paste" | null,
      tokenExpiresAt: number | null,
      clientId: string | null }

POST /api/auth/discover
  → triggers automatic discovery; returns same shape as /status

POST /api/auth/paste
  body: { lines: string }   // free-form paste from DevTools or Cookie Editor
  → parses sp_dc / sp_t / sp_key, persists to file, mints token

DELETE /api/auth/clear
  → wipes persisted cookies + cached token

GET  /api/auth/token
  → { accessToken: string, expiresAt: number }
  (used internally by future proxy routes; exposed for debugging)
```

For phase 1, the SPA still talks directly to `api.spotify.com/v1` for
everything else. The sidecar only proves auth works.

## Phases

### Phase 1 — sidecar + Safari auto-discovery + token mint  *(this commit)*

- Vite plugin scaffold (`server/index.ts`).
- Cookie sources: Safari, file, paste.
- TOTP module (port of `spogo/totp.go`).
- `/api/auth/*` routes.
- SPA dev banner: small status pill that shows "cookie mode (safari)" or
  "PKCE" with a click-to-paste fallback.

**Done when:** running `npm run dev` while logged into Safari mints a token
without any user interaction; status shows `mode: "cookie", source: "safari"`.

### Phase 2 — Pathfinder GraphQL proxy

- `spotify/session.ts` (bearer + clientToken + clientVersion).
- `spotify/hash.ts` (live JS-bundle scrape, hash cache).
- `spotify/pathfinder.ts` + `/api/proxy/pathfinder?op=...` route.
- Replace `src/api/spotify.ts` callers one at a time:
  - `searchDesktop` → drops the dev-mode 10-result cap
  - `libraryV3` → replaces `/me/playlists`, `/me/tracks`
  - `fetchPlaylist` → editorial playlists (Today's Top Hits) start working

### Phase 3 — connect-state + dealer

- `spotify/connect.ts` for play/pause/seek/volume/etc.
- `spotify/dealer.ts` — proxy a WebSocket from sidecar to SPA, replaces the
  `store/player.ts` polling.
- Drop the polling timers from `App.tsx`.

### Phase 4 — lyrics

- `spotify/lyrics.ts` and a new pane in `RightPanel.tsx`.
- Cache by track id under `~/Library/Caches/spotui/web-lyrics/`.

## Out of scope (deferred)

- **Spotify Jam** — server-side state inside Spotify; needs more research
  before we touch it.
- **Friend activity** — works trivially via cookie auth, no UI surface yet.
- **Production-mode build** — all of this is dev-only via Vite middleware.
  If we later want a `vite preview` or static-build path, the sidecar
  becomes a separate `node server.js` binary. Not phase 1.
- **Cross-browser cookie discovery on Linux/Windows** — macOS-first to
  match the TUI's existing platform.

## Risk mitigations specific to web

| Risk | Mitigation |
|---|---|
| Sidecar runs only during `vite dev` | Document it; ship a tiny `node server.js` entrypoint later if we need preview/build |
| User on Chrome / Firefox / Brave | Discovery falls through to paste; only Safari is auto-discovered |
| Cookie file readable by other local apps | Persisted file is mode 0600 under user dir; same as TUI plan |
| Spotify rotates TOTP secret | `SPOTUI_TOTP_SECRET_URL` env override + mirror list (same as TUI) |
| `clientVersion` ages out | `SPOTUI_CONNECT_VERSION` env override + scrape from live `open.spotify.com` (same as TUI) |
| Pathfinder hash changes | Runtime resolution from JS bundle, cached by `clientVersion` |

## Reference

- spogo source (cloned): `/tmp/spogo-research/spogo/internal/spotify/`
- Safari binarycookies format: well-documented; see e.g.
  `https://github.com/libyal/dtformats/blob/main/documentation/Safari%20Cookies.asciidoc`
- License: spogo is MIT; this port preserves attribution in module docstrings.
