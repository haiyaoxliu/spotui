# Webapp documentation — full snapshot

This document inventories every module, function, route, store, and component
in `web/`. Use it as a map for cleanup / unification work. The "Cleanup
candidates" sections call out duplication, dead code, and patterns that can be
consolidated.

> Snapshot date: 2026-05-06. Branch: `explore/cookie-auth-bypass`.

---

## 1. Architecture at a glance

```
Browser SPA  (web/src, Vite + React + Tailwind + Zustand)
  │
  │  fetch / EventSource → /api/*
  ▼
Vite dev server middleware = "sidecar"  (web/server)
  │
  │  attach sp_dc cookie + bearer + client-token
  ▼
Spotify endpoints
  ├── api.spotify.com/v1/*           (public Web API; PKCE OR cookie bearer)
  ├── api-partner.spotify.com/...    (Pathfinder GraphQL persisted queries)
  ├── *-spclient.spotify.com/...     (connect-state, lyrics, jam, buddylist)
  ├── open.spotify.com/api/token     (cookie → web bearer mint)
  ├── clienttoken.spotify.com/...    (client-token mint)
  ├── wss://dealer.spotify.com/      (push notifications)
  └── www.spotify.com/api/...        (degraded /v1/me fallback)
```

Two parallel auth paths exist:

- **PKCE** — classic OAuth using `VITE_SPOTIFY_CLIENT_ID` (a private dev app).
  Bearer issued by `accounts.spotify.com/api/token`. Stored in `localStorage`.
  Used only for `/v1/*` calls. Separate rate-limit pool.
- **Cookie** — `sp_dc` from Safari (or pasted) → mint web-player bearer at
  `open.spotify.com/api/token`. Held by sidecar in memory. Carries elevated
  scopes (Pathfinder, spclient, connect-state). Same client_id pool as
  Spotify's web player, so heavily rate-limited.

Both can be active at once. When PKCE tokens exist, the SPA prefers PKCE for
`/v1` (`api/client.ts`) because of the rate-limit difference; cookie bearers
are otherwise used for everything else.

---

## 2. Top-level files

### `web/index.html`
- Loads `/src/main.tsx`.
- Inline pre-paint script reads `localStorage.ui_theme` and toggles `<html
  class="dark">` to avoid a light-mode flash before React hydrates.

### `web/vite.config.ts`
- Registers `@vitejs/plugin-react` and the local `spotuiSidecar()` plugin from
  `server/index.ts`.
- Dev server pinned to `127.0.0.1:8888`, `strictPort: true`.

### `web/package.json`
- Deps: `react`, `react-dom`, `zustand`, `ws`, `@types/ws`.
- Devdeps: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`,
  `autoprefixer`, `typescript`.
- Scripts: `dev`, `build` (typecheck both tsconfigs + vite build), `preview`,
  `typecheck`.

### `web/tsconfig.json` / `web/tsconfig.server.json`
- Two project files: SPA vs. sidecar. The sidecar's `include` is restricted to
  `server/**`; the SPA's includes only `src/**`. `state.ts` on the server
  duplicates a few types from `src/api/spotify.ts` for this reason.

### `web/WEB_PLAN.md`
- Original migration plan: cookie-auth bypass, sidecar architecture, phasing.
  Mostly historical now — phases 1–4 are all in.

### `web/src/main.tsx`
- React root mount. Wraps `<App />` in `StrictMode`.

### `web/src/styles.css`
- Tailwind entrypoint. (Not separately reviewed here.)

---

## 3. Server (`web/server/`) — sidecar

The sidecar is a Vite plugin that registers Connect-style middlewares on the
dev server. Production builds skip it (`apply: 'serve'`).

### 3.1 `server/index.ts` — plugin entry

#### Exports
- `spotuiSidecar(): Plugin` — Vite plugin factory. Mounts every route in the
  `ROUTES` table and `/api/health`.
- Default export = `spotuiSidecar`.

#### Internals
- `ROUTES: Route[]` — the routing table. Maps `path` + `method` to the
  imported handlers from `routes/auth.ts` and `routes/proxy.ts`.
- A wrapper inside `configureServer` runs each handler in a try/catch, emits
  500 + JSON on failure.

#### Notes
- ⚠️ Order matters for `/api/proxy/state*`: the `state/stream` and `state/raw`
  paths must come before `state` because Connect uses prefix matching.
- The handler-table approach is a small reinvention of express-style routing.

### 3.2 `server/cookies/`

#### `types.ts`
- `interface SpotifyCookie` — `{ name, value, domain?, path?, expires? }`.
- `type CookieSourceName = 'safari' | 'file' | 'paste'`.
- `interface CookieReadResult` — `{ cookies, source }`.
- `findCookie(cookies, name): string | null` — first-match by name.
- `hasSpDc(cookies): boolean` — true if any cookie named `sp_dc` has a value.
- `toCookieHeader(cookies): string` — de-dupes by name and joins
  `name=value` pairs; used as the literal `Cookie:` header.

#### `index.ts` (dispatcher)
- `discoverCookies()`: try Safari → file. On Safari hit, mirrors cookies to
  the file store so subsequent boots don't depend on Safari. Returns
  `{ found, diagnostics }`.
- `persistPastedCookies(cookies)` — proxy to `writeFileCookies`.
- `clearAllCookies()` — proxy to `clearFileCookies`.
- Emits `DiscoveryDiagnostic[]` for every source attempted (including
  `permission_denied` with the offending path).
- Re-exports `CookieReadResult`, `CookieSourceName`, `SpotifyCookie`.

#### `safari.ts`
- `readSafariSpotifyCookies(): Promise<SafariReadResult>` — tries the
  sandboxed path then the legacy path.
- `parseBinaryCookies(buf)`, `pickWebPlayerBundle`/etc. — exported for tests.
- Distinguishes `no_file`, `not_logged_in`, `permission_denied` (Full Disk
  Access prompt material), `parse_failed`.
- Cookie record parser handles the ~150 LoC binarycookies format — magic +
  pages + per-cookie offsets + Mac-epoch expiry.

#### `file.ts`
- `COOKIE_FILE_PATH` — `~/Library/Application Support/spotui/web-cookies.json`.
- `readFileCookies()`, `writeFileCookies()`, `clearFileCookies()`.
- `writeFileCookies` refuses to persist a cookie set without `sp_dc`. Atomic
  write via `.tmp` + rename. Mode 0600.

#### `paste.ts`
- `parsePaste(raw): { cookies, warnings }` — splits on newlines+semicolons,
  strips a leading `Cookie:`, picks `=` vs `:` separator. Each entry gets
  `domain: '.spotify.com'` synthesized.

### 3.3 `server/routes/`

#### `auth.ts`
All handlers here own their own `json/error/readJson` helpers (duplicated
from `proxy.ts` — see Cleanup).
- `statusHandler` — peeks the file + cached token; returns
  `{ mode, source, tokenExpiresAt, clientId }`. Source is "file" if any
  on-disk cookies are present; doesn't actually consult discovery diagnostics.
- `discoverHandler` — runs the full discovery, mints token if found, returns
  the diagnostics + `needsFullDiskAccess` flag.
- `pasteHandler` — body `{ raw }` → `parsePaste` → `persistPastedCookies` →
  mint. Rejects without `sp_dc`.
- `clearHandler` — `clearAllCookies()` + `clearCachedToken()`.
- `tokenHandler` — returns the cached/just-minted bearer + expiry. Used
  internally by SPA's `getCookieToken`.
- `mintAndCache(read)` — thin wrapper around `getToken` (token caching is
  already in `token.ts`).

#### `proxy.ts`
- `pathfinderHandler` — generic `POST /api/proxy/pathfinder` for arbitrary
  ops (used by SPA's `getAlbum`, `addToPlaylist`).
- `searchHandler` — `GET /api/proxy/search?q=&limit=&offset=` →
  Pathfinder `searchDesktop`.
- `libraryHandler('Playlists' | 'Albums')` factory →
  `libraryPlaylistsHandler`, `libraryAlbumsHandler` (the Albums variant has
  no SPA caller right now). Wraps `libraryV3` with `expanded` folders param.
- `libraryTracksHandler` — Liked Songs via `fetchLibraryTracks`.
- `playlistTracksHandler` — `fetchPlaylist` for one playlist's items. URL
  shape is `/api/proxy/playlist/:id/items`, parsed manually because Connect
  prefix-strips the mount.
- `connectWriteHandler<T>(parseBody, invoke)` — factory for connect-state
  POSTs. Each `connectXxxHandler` is a one-line invocation.
  - `connectPlayHandler`, `connectPauseHandler`, `connectNextHandler`,
    `connectPrevHandler`, `connectSeekHandler`, `connectVolumeHandler`,
    `connectShuffleHandler`, `connectRepeatHandler`, `connectQueueHandler`,
    `connectTransferHandler`.
- `jamGetHandler`, `jamStartHandler`, `jamLeaveHandler`.
- `stateRawHandler` — diagnostic; raw cluster + mapped output.
- `stateSnapshotHandler` — `/api/proxy/state` mapped one-shot snapshot.
- `meHandler` — `/api/me`. Surfaces `MeRateLimitedError` as 429 + Retry-After.
- `friendsHandler` — `/api/proxy/friends`.
- `lyricsHandler` — `/api/proxy/lyrics/:trackId`. 404s on `LyricsNotFoundError`.
- `stateStreamHandler` — SSE for `/api/proxy/state/stream`. Proxies dealer
  events as `tick`/`open`/`close`. 20s heartbeat comments.
- Helpers: `loadCookies()`, `clampInt`, `json`, `noContent`, `error`,
  `readJson`, `errMsg`.

### 3.4 `server/spotify/`

#### `token.ts`
- `getToken(read): Promise<WebToken>` — module-level cache with 60s slack.
  Refreshes on demand.
- `clearCachedToken()`, `peekCachedToken()`.
- `mintToken(read)` — POSTs to `open.spotify.com/api/token` with TOTP query
  params + `Cookie:` header.
- `WebToken = { accessToken, expiresAt, isAnonymous, clientId }`.

#### `totp.ts`
- `generateTotp(now=new Date()): { code, version }`.
- Loads the obfuscated secret from public mirrors with a 15-min cache; falls
  back to a hardcoded version. `SPOTUI_TOTP_SECRET_URL` env override.
- `parseSecretDict`, `totpFromSecret`, `hotp`, `_resetCache` exported for
  tests.
- Direct port of spogo's `totp.go`. Algorithm: XOR each secret byte with
  `(i%33)+9`, ASCII-decimal-stringify the bytes, HMAC-SHA1 against the
  30s-step counter, RFC6238 6-digit truncation.

#### `session.ts`
- `getSessionAuth(read): Promise<SessionAuth>` — bundles bearer + clientToken
  + clientVersion + deviceId + clientId. Used by every spclient/Pathfinder
  call.
- `clearSessionCaches()` — wipes the in-memory clientToken + appConfig.
- `extractClientVersion(html)` — exported helper, scrapes
  `<script id="appServerConfig">` from the live `open.spotify.com` HTML.
- `_fetchText(url)` exported for `hash.ts`.
- Internal: `ensureClientVersion`, `ensureDeviceId` (synthesizes & persists
  `sp_t` if missing), `ensureClientToken`, `mintClientToken`, `runtimeOs`.
- Caches: `cachedClientToken`, `cachedAppConfig` (process-lifetime).

#### `pathfinder.ts`
- `pathfinderQuery(read, operation, variables): Promise<PathfinderResponse>`.
  Resolves SHA256 hash via `hash.ts`, builds the query-string URL
  (operationName/variables/extensions), throws on non-2xx OR `errors[]`.
- Variable builders for the four ops in use:
  - `searchDesktopVariables(query, limit, offset)`
  - `libraryV3Variables(filter, limit, offset, expandedFolders)`
  - `fetchLibraryTracksVariables(limit, offset)`
  - `fetchPlaylistVariables(playlistId, limit, offset)`
- `addToPlaylist` and `getAlbum` are called via the generic
  `pathfinderHandler` directly from the SPA — their variables are inlined in
  `src/api/pathfinder.ts`. (See Cleanup — split surface for "wrapped" vs
  "raw" ops.)

#### `hash.ts`
- `resolveHash(operation, clientVersion)`, `resolveHashes(operations,
  clientVersion)` — runtime SHA256 resolver. Memory + disk cache keyed by
  clientVersion at `~/Library/Caches/spotui/web-pathfinder-hashes.json`.
- Internal: `tryLookup`, `readDiskCache`, `mergeIntoCache`,
  `scrapeFromWebPlayer`, `findOperationHashes` (two regex patterns for
  inline-string vs `("op","query","hash")` triple), `parseChunkUrls`
  (heuristic webpack chunk-map decoder), `pickWebPlayerBundle`,
  `bundleBaseURL`, `escapeRegex`, `parseMapLiteral`, `scoreHashMap`,
  `scoreNameMap`, `allFound`.
- Direct port of spogo's `connect_hash.go`.

#### `connect.ts`
- Singleton `session: ConnectSession` ({ deviceId, connectionId,
  connectionIdAt, registeredAt }).
- `connectClient: ConnectClient` exposes:
  - `state(read)` — GET cluster.
  - `play(read, args)` — handles resume vs context vs single track vs
    `positionMs`.
  - `pause`, `next`, `previous`, `seek`, `volume`, `shuffle`, `repeat`,
    `queueAdd`, `transfer`.
- Internal: `ensureConnectionId` (reuses dealer's id if open), `ensureRegistered`
  (registers a hidden virtual device), `getConnectionIdOnce` (one-shot WS),
  `fromTo` (resolves source/target device ids), `detectActive`, `sendCommand`,
  `baseCommand`, `connectHeaders`, `randomHex`, `runtimeOs`, `truncate`.
- Re-exports `toCookieHeader` as `_cookieHeaderForConnect` (placeholder; not
  actually used). Direct port of spogo's `connect_*.go`.

#### `dealer.ts`
- Singleton `DealerClient` (EventEmitter). Lifecycle:
  - Lazy: opens on first `subscribe`, closes when subscriber count drops to 0.
  - Pong on dealer ping frames; reschedules a refresh-and-reconnect 60s
    before token expiry.
  - Exponential backoff on close (1s → 30s).
- `getDealer(): DealerClient`.
- `DealerEvent = { kind, raw? }`.
- Public methods: `subscribe(handler)`, `isConnected()`,
  `connectionIdOrNull()`. Used by both the SSE handler and `connect.ts` to
  reuse the connection id.
- Internal `loadCookies()` mirrors `routes/proxy.ts:loadCookies` (Cleanup).

#### `state.ts`
- `fetchClusterSnapshot(read)` and `fetchRawCluster(read)` — wrap
  `connectClient.state` and reshape into the SPA's PlaybackState/Queue/Device
  shape.
- Server-side **duplicates** of `Track`, `Episode`, `Album`, `Artist`,
  `Device`, `PlaybackState`, `Queue` types (cannot import from `src/`).
- Mappers:
  - `mapDevices`, `mapPlayback`, `mapQueue`, `mapTrack`, `mapEpisodeShape`.
  - `mapArtists` — three encoding strategies (flat metadata / top-level
    `artists` array / Pathfinder containers).
  - `extractArtistList` + `walk` — recursive container probe.
  - `mapAlbumImages`, `normalizeImageUrl` (handles `spotify:image:...` →
    `https://i.scdn.co/...`).
- Helpers: `derivePlaying`, `deriveProgress` (advances by wall-clock when
  playing), `deriveRepeat`, `volumeToPercent`, `parseIntStr`, `idFromUri`,
  `typeFromUri`.

#### `me.ts`
- `getMe(read): Promise<MeProfile>` — memory + disk cache + 60s
  rate-limit cooldown. Falls back to `www.spotify.com/api/account-settings`
  when `/v1/me` 429s. Persists only `/v1/me` results to disk.
- `MeRateLimitedError` (with `retryAfterMs`).
- `clearMeCache()` — wipes mem + cooldown + `me.json`.
- Internal: `mintFromApi`, `fetchFromWww`, `readDisk`, `writeDisk`,
  `isNotFound`.
- Synthesizes `display_name` from email local-part when www fallback fires;
  marks the response with `_source: 'www-fallback'`.

#### `lyrics.ts`
- `fetchLyrics(read, trackId): Promise<unknown>` — spclient
  `color-lyrics/v2/track/{id}`. 404 → `LyricsNotFoundError`. Track id format
  is regex-validated.

#### `jam.ts`
- `getCurrentSession(read)` — `GET /sessions/current`. 404 → null.
- `startSession(read)` — `GET /sessions/current_or_new`. Side-effect creates.
- `leaveSession(read, sessionId)` — `DELETE /sessions/{id}`. Validates id
  with `/^[a-zA-Z0-9]+$/`.
- `jamHeaders(auth)` — local helper.

#### `buddylist.ts`
- `fetchBuddylist(read): Promise<unknown>` — single GET to
  `guc-spclient.spotify.com/presence-view/v1/buddylist`. Spotify's response
  shape passes through unchanged; SPA does its own shape-checking.

---

## 4. SPA (`web/src/`)

### 4.1 Entry / shell

#### `App.tsx`
- `App()` — top-level component.
  - Bootstraps auth (PKCE callback handling, then `bootstrapAuth()`).
  - Picks `/v1/me` path: PKCE → `api<Me>('/me')`, cookie → sidecar `fetchMe`.
  - Renders `<Player>` once `me` is set.
  - Module-level `callbackInflight` dedupes the OAuth callback under
    StrictMode double-mount.
- `Player({ me })` — main shell. Wires:
  - `refresh()` — async; `Promise.allSettled` of `getPlaybackState()` +
    `getQueue()` with per-field suppression imported from `commands.ts`.
  - Initial fetch + `subscribeState` (SSE-driven refresh).
  - Per-track Liked re-check on `playingTrackUri` change.
  - Global keyboard listener (skip when modal open / inputs focused).
  - Layout: `<ConsoleBar>` + `<LibraryPanel>` + `<SelectedPlaylist>` +
    `<RightPanel>` + optional bottom `<TransportBar>` + overlays
    (DevicePicker, HelpOverlay, ColorPicker, ControlPane, FriendsOverlay,
    JamOverlay).
- `ConsoleBar({ me, onOpenDevices, onOpenHelp, onToggleControls,
   onToggleFriends, onToggleJam })` — top status strip.
- `ConsoleStatus()` — subscribes to `useUI.consoleMessage`, auto-clears after
  6s/12s based on level. Resets on each new id.
- `ConsoleButton({ onClick, title, children, ...rest })` — square icon button.

##### Keybinds (in `App.tsx`'s global `onKey`)
| Key | Action |
|---|---|
| Space | togglePlayPause |
| j / → | skipNext |
| k / ← | skipPrevious |
| s | toggleShuffle |
| r | cycleRepeat |
| , / . | adjustSeek ∓10s |
| - / = / + | adjustVolume ∓5 |
| l | toggleLikeCurrent |
| q | queueFocused |
| p | playFocusedTrackOnly |
| a | addFocusedToOpenPlaylist |
| Enter | playFocused |
| d | openDevicePicker |
| / | focusSearch |
| ? | openHelp |
| c | openColorPicker |
| Shift+S | toggleControlPane |
| f | toggleFriends |
| Shift+J | toggleJam |
| b | goBack |

#### `console.ts`
- `notify(text, level='info')` — wraps `useUI.pushConsoleMessage`. Used by
  api/* modules to surface fallbacks/errors without importing the store
  directly at call sites.

#### `commands.ts`
The single source of "user actions that change playback or library state."
- Module-level `suppress = { isPlaying, shuffle, repeat, volume, position }`
  keyed timestamps, plus `isXxxSuppressed()` getters consumed by
  `App.refresh()`.
- `Refresh = () => void | Promise<void>`.
- `togglePlayPause(refresh)`, `skipNext(refresh)`, `skipPrevious(refresh)`,
  `toggleShuffle(refresh)`, `cycleRepeat(refresh)`,
  `adjustVolume(delta, refresh)`, `adjustSeek(deltaMs, refresh)`,
  `seekTo(positionMs, refresh)`.
- `queueFocused()`, `playFocused(refresh)`, `playFocusedTrackOnly(refresh)`,
  `playContext(uri, refresh)`, `addFocusedToOpenPlaylist()`.
- `toggleLikeCurrent()`, `toggleLikeFocused(uri)` (private).
- Pattern: optimistic store patch → `setTimeout(refresh, PROPAGATION_DELAY_MS)`.
  Suppress timer prevents the post-refresh from clobbering the optimistic
  value.

### 4.2 `src/auth/`

#### `auth.ts`
- Module state: `cookieMode: boolean`, `cookieToken: { accessToken, expiresAt
  } | null`.
- `bootstrapAuth(): Promise<AuthKind>` — calls `/api/auth/status`, falls
  through to `/api/auth/discover` if `none`, then to localStorage PKCE.
- `getCookieToken()` — fetches `/api/auth/token` with 60s slack cache.
- `isCookieMode()`, `clearCookieToken()`, `hasPkce()`, `tokenKind()`,
  `isLoggedIn()`, `logout()`.
- PKCE flow: `login()`, `handleCallback()`, `refresh()`, internal
  `saveTokens` / `loadTokens` against localStorage `spotify_tokens`.
- `getAccessToken()` — bearer dispatcher; PKCE preferred when present (split
  rate-limit pool), cookie otherwise.
- `requireClientId()` — surfaces a clean error when env var is missing.

#### `pkce.ts`
- `generateCodeVerifier()`, `generateCodeChallenge(verifier)`,
  `generateState()`. Crypto subtle / random + base64url helper.

### 4.3 `src/api/` — SPA → sidecar/Spotify

#### `client.ts`
- `api<T>(path, init?): Promise<T | null>` — single chokepoint for all
  `api.spotify.com/v1/*` calls.
- 401 retry: PKCE → `refresh()`, cookie → `clearCookieToken()` + re-mint.
- 204 → `null`. Non-2xx → throws `Error("Spotify {METHOD} {path}: {status}
  {body}")`.

#### `spotify.ts` — the public surface for components/stores
Types: `SpotifyImage`, `Artist`, `Album`, `Track`, `Episode`, `PlayingItem`,
`Device`, `PlaybackState`, `Queue`, `Playlist`, `PlaylistItem`,
`SavedTrack`, `PlayHistoryItem`, `SearchResults`, `SearchTab`,
`SimplifiedAlbum`, `ArtistObject`, `PageSlice`, `PlayOptions`,
`QueueProvider`.

Reads:
- `getPlaybackState()` — cookie → `fetchClusterSnapshot().playback`,
  fallback `/v1/me/player`.
- `getQueue()` — cookie → cluster's queue, fallback `/v1/me/player/queue`.
- `getDevices()` — cookie → cluster's devices, fallback
  `/v1/me/player/devices`.
- `fetchPage<T>(path)` — cookie → `fetchPageViaPathfinder<T>` for `/me/playlists`,
  `/me/tracks`, `/playlists/{id}/items`. Fallback `/v1` only on 429/transport.
- `fetchAllPages<T>(initialPath, max=1000)` — internal; Liked is the only
  user.
- `getAlbumTracks(albumId, max=200)` — cookie → `fetchAlbumTracksViaPathfinder`,
  fallback `/v1/albums/{id}/tracks`.
- `getRecentlyPlayed()` — `/v1/me/player/recently-played?limit=50` (no
  cookie path; spogo also doesn't implement one).
- `search(q)` — cookie → `searchViaPathfinder` (limit 50) → synthesize
  pathfinder next URLs. Fallback `/v1/search?type=...&limit=10`.
- `searchMore<K>(nextUrl)` — handles both `pathfinder:search?...` synthetic
  URLs and real `https://api.spotify.com/v1` URLs.
- `synthesizeNexts(q, results)` + `withNext` — produce per-tab
  `pathfinder:search?...` next URLs.
- `checkLibraryContains(uris)` — module Map cache; missing slots batched into
  one `/me/library/contains` call.

Writes (all wrapped via `tryConnect`):
- `addToQueue`, `transferPlayback`, `play(opts)`, `pause`, `next`, `previous`,
  `setShuffle`, `setRepeat`, `setVolume`, `seek`.
- `play()` sniff: connect-state path for resume / single track / context+offset
  / contextUri+positionMs; `/v1` for multi-URI / numeric `offsetPosition`.
- `publicPlay(opts)` — `/v1/me/player/play` builder.
- `saveToLibrary(uris)`, `removeFromLibrary(uris)` — write through to the
  contains-cache.
- `addItemsToPlaylist(playlistId, uris)` — cookie path
  `addToPlaylistViaPathfinder`, fallback `/v1/playlists/{id}/items?uris=`.

Constants: `PLAYLISTS_PAGE_PATH`, `PLAYLIST_ITEMS_PAGE_PATH(id)`,
`SAVED_TRACKS_PAGE_PATH`, `SEARCH_LIMIT = 50`.

#### `connect.ts`
- `tryConnect(primary, fallback)` — try cookie path, fall back on any
  exception (with `console.warn`).
- One-liners around `postJson({ path, body? })`:
  `connectPlay(args?)`, `connectPause()`, `connectNext()`, `connectPrev()`,
  `connectSeek(positionMs)`, `connectVolume(percent)`,
  `connectShuffle(state)`, `connectRepeat(mode)`, `connectQueueAdd(uri)`,
  `connectTransfer(deviceId, play=false)`.

#### `events.ts`
- `subscribeState({ onTick, onReconnect?, fallbackIntervalMs=30_000 })`:
  `EventSource('/api/proxy/state/stream')` listener for `tick`/`open`/
  `hello`/`close`. Returns `{ close, isLive }`. EventSource auto-reconnects;
  fallback timer fires regardless.

#### `friends.ts`
- Types: `FriendUser`, `FriendTrackContext`, `FriendTrack`, `FriendActivity`.
- `fetchFriendActivity()` — single `GET /api/proxy/friends`.
- `truncate(s)` — local copy of the standard 200-char truncator.

#### `jam.ts`
- Types: `JamMember`, `JamSession` (camelCase) + private snake_case `RawSession`/
  `RawMember`.
- `adapt(raw)` — snake → camel mapping.
- `fetchCurrentJam()`, `startJam()`, `leaveJam(sessionId)`,
  `jamShareLink(token)`.

#### `lyrics.ts`
- Types: `LyricsLine`, `LyricsResult`.
- Module-scoped `lyricsCache` (TTL 30 min) + `inflight` dedupe map.
- `fetchLyrics(trackId)` — adapts spclient response (string ms → numeric).

#### `me.ts`
- `fetchMe()` — calls `/api/me`, surfaces `notify(...)` on 429 + on
  `_source: 'www-fallback'`.

#### `state.ts`
- `fetchClusterSnapshot()` — caches an `inflight` promise so parallel callers
  share one round trip; clears on next microtask.
- Re-exports `ClusterSnapshot` shape.

#### `pathfinder.ts`
SPA-side adapters from Spotify's GraphQL shapes back into the public
Web-API-shaped types in `spotify.ts`.

- `class PathfinderError extends Error` — `{ status }`.
- `isRetryablePathfinderError(e)` — true for `PathfinderError` 0/429/5xx and
  any `TypeError` (transport).

Search:
- `searchViaPathfinder(q, limit, offset)` — `/api/proxy/search`.
- `buildPathfinderNextUrl(q, tab, nextOffset, limit=10)` —
  `pathfinder:search?...` synthetic URL.
- `isPathfinderNextUrl(url)`.
- `searchMoreViaPathfinder(url)` — parses + re-fetches + re-synthesizes.

Library / playlist (paged):
- `fetchPageViaPathfinder<T>(path)` — routes `/me/playlists`, `/me/tracks`,
  `/playlists/{id}/items` into the right helper. Returns `null` for unknown
  paths so callers know to fall back.
- `matchPagedPath(path)` — discriminated union match.
- `clampInt(raw, fallback, min, max)`.
- `nextPath(basePath, fetched, offset, total, limit)`.
- `fetchLibraryEntries({ limit?, offset?, expandedFolders? })` — folder-aware,
  used by `useLibrary`. Returns `LibraryEntry[]`.
- `LibraryEntry` discriminated union: `playlist | folder` + `depth`/`pinned`.
- `libraryPlaylistsViaPathfinder(limit, offset)` — flat-Playlist-only view
  for the legacy fetchPage interceptor.
- `libraryTracksViaPathfinder` — Liked Songs.
- `playlistTracksViaPathfinder(playlistId, limit, offset)` — invokes the
  `playlistMetaObserver` with `{ playlistId, ownerId, ownerDisplayName }`.

Playlist meta observer:
- `setPlaylistMetaObserver(fn)` — single-slot callback. Wired by the library
  store's `updatePlaylistOwner` action. Side-channel rather than store
  import to avoid a cycle.

Album:
- `fetchAlbumTracksViaPathfinder(albumId, max=200)` — pages internally with
  `getAlbum`. Returns `SimplifiedAlbumTrack[]` (no album field; the caller
  hydrates).

Mutations:
- `addToPlaylistViaPathfinder(playlistId, uris)` — `addToPlaylist` mutation
  with `BOTTOM_OF_PLAYLIST`.

Mappers (private): `mapImages`, `mapArtistsContainer`, `mapTrack`,
`mapAlbum`, `mapArtist`, `mapPlaylist`, `mapSavedTrack`, `mapPlaylistItem`,
`mapEpisode`, `mapAlbumTrack`, `idFromUri`, `formatReleaseDate`, `truncate`,
plus `adaptTracks`/`adaptAlbums`/`adaptArtists`/`adaptPlaylists` for the
search-V2 envelope.

### 4.4 `src/store/` — Zustand stores

#### `player.ts` — current playback
State: `playback`, `queue`, `liked`. Actions: `setPlayback`, `setQueue`,
`setLiked`, `optimisticIsPlaying(playing)`, `patchPlayback(patch)`,
`patchDevice(patch)`. The `patch*` mutations are what `commands.ts` uses for
optimistic updates that get reconciled on the next `refresh()`.

#### `library.ts` — playlists + folders
- Persisted: `library_pinned_ids`, `library_expanded_folders` in
  localStorage (read once on init, written on each mutation).
- State: `baseEntries` (depth=0 entries), `folderChildren[uri]`,
  `expandedFolders: Set<string>`, derived `playlists: Playlist[]`,
  `loaded`/`loading`/`loadingMore`/`error`/`nextPath`/`total`,
  `pinnedIds: string[]`.
- Actions: `load()`, `loadMore()`, `toggleFolder(uri)`, `pin(id)`/`unpin(id)`,
  `updatePlaylistOwner({ playlistId, ownerId, ownerDisplayName })`.
- Helpers: `indexEntries(flat)` splits the depth-aware list into base +
  per-folder children. `deriveAllPlaylists(base, children)` flattens to
  `Playlist[]` for callers that don't care about folders.
- `load()` falls back to legacy `fetchPage('/me/playlists?limit=50')` when
  libraryV3 throws (PKCE-only mode).
- Side-channel: `setPlaylistMetaObserver(...)` wired at module init so a
  fetchPlaylist response patches owner metadata into the matching entry.

#### `selection.ts` — open playlist/album/liked/recent pane
- `SelectedKind = 'playlist' | 'album' | 'liked' | 'recent'`.
- State: `kind`, `contextUri`, `contextId`, `name`, `owner`, `trackCount`,
  `totalDurationMs`, `minAddedAt`, `canEdit`, `tracks`, `loading`, `error`,
  `tracksNextPath`, `loadingMoreTracks`, `lastPlaylist`, `lastAlbum`,
  `prior` (one-step undo target), all the `selectXxx` actions, `loadMoreTracks`,
  `goBack`.
- Actions: `selectPlaylist(p, canEdit)`, `selectAlbum(a)`, `selectLiked()`,
  `selectRecent()`, `loadMoreTracks()`, `goBack()`.
- Module-scoped `playlistTracksCache` (5-min TTL) keyed by playlist id.
  Hits are rendered immediately, then an in-flight refresh refills the cache
  in the background.
- `snapshotOf(s)` + `maybeCaptureprior` (sic) capture undo state; an internal
  `restoring` flag suppresses a second snapshot inside `goBack`.

#### `ui.ts` — UI prefs + transient state
- Persisted (localStorage): `ui_transport_position`, `ui_search_position`,
  `ui_detail_layout`, `ui_theme`, `ui_accent_color_dark/light`,
  `ui_external_color_dark/light`, `library_pinned_ids` (lives in
  `library.ts`, listed here for completeness), with one-time legacy
  migrations from `ui_accent_color`/`ui_external_color`.
- Modal flags: `devicePickerOpen`, `helpOpen`, `colorPickerOpen`,
  `controlPaneOpen`, `friendsOpen`, `jamOpen` — all with `open`/`close`
  (and `toggle` for the last three) actions.
- Theme + colors: `theme` ('dark' | 'light'), `accentColorDark/Light`,
  `externalColorDark/Light`, `setTheme(t)`, `toggleTheme()`,
  `setAccentColor(theme, c)`, `setExternalColor(theme, c)`, `resetColors(theme)`.
  `applyTheme()` and `applyColors()` write CSS vars + class.
- `searchFocusTick: number` + `focusSearch()` — increments a counter the
  search input watches (decoupled from open/close state).
- `focusedRow: FocusedRow | null` + `setFocusedRow`.
- `userId: string | null` + `setUserId`.
- `consoleMessage: ConsoleMessage | null` + `pushConsoleMessage(text, level?)`,
  `clearConsoleMessage()`. `consoleMessageSeq` ensures repeated identical
  text still triggers a fresh render.
- Layout prefs: `transportPosition`, `searchPosition`, `detailLayout` +
  setters.
- Module-init side effect calls `applyTheme(initialTheme)` +
  `applyColors(...)` to set CSS vars before first paint.

#### `search.ts`
- State: `query`, `results: SearchResults`, `loading`,
  `loadingMore: Record<SearchTab, boolean>`, `error`.
- Actions: `setQuery(q)` (250ms debounce, monotonic `lastSearchId` ignores
  stale responses), `loadMore(tab)`.
- Helpers: `TABS` (= `SEARCH_TABS` reexport), `NO_LOADING` constant.

### 4.5 `src/components/`

| Component | Responsibility |
|---|---|
| `TransportBar` | Play controls + scrub + volume. `compact` prop swaps to a 2-col grid for the right-edge layout; volume swaps to `+`/`−` buttons under a `ResizeObserver` width threshold. |
| `ProgressBar` | Scrub bar with 250ms client-side interpolation, pointer-drag scrubbing (pointer capture), seek-on-release. Owns `localProgress`/`isDragging` state. |
| `NowPlaying` | Album art, track + artists, like heart, "from {context}" label resolved via `describeSource(playback, playlists, selectionContextUri, selectionName)`, device + state line. |
| `LyricsPanel` | Line-synced lyric scroll. `useExtrapolatedPosition(serverPos, playing)` smooths between dealer pushes via rAF. Binary-searches `activeIndex`. |
| `QueuePanel` | Filters `queue.queue` to `_provider === undefined || 'queue'` (user-added only). Two layouts via `detailLayout`. |
| `RightPanel` | Vertical stack: `<NowPlaying>` + optional compact `<TransportBar>` + `<LyricsPanel>` + `<QueuePanel>`. |
| `LibraryPanel` | Sidebar: Liked Songs + Recently Played + pinned + folders + top-level + (PKCE-fallback) flat list. Inline `PlaylistRow`/`FolderRow`/`renderChildEntry`. Pin/unpin with `★`/`☆`. `canEdit(p)` heuristic (libraryV3 owner gap). |
| `SelectedPlaylist` | Center pane. Dual-mode: shows the selected playlist/album/liked/recent OR (when `query` set) the search results tabs. `<ResultList>` is per-tab loop with `LoadMoreFooter`. Local substring filter on tracks. |
| `LoadMoreFooter` | Sentinel + button. IntersectionObserver auto-fires `onLoadMore` once when the element enters the viewport (rootMargin 120px). |
| `DevicePicker` | Modal listing `getDevices()`. j/k/Enter navigation. Fires `transferPlayback` on Enter or row-click. |
| `HelpOverlay` | Static keybind reference. Sections GLOBAL / ROW / SEARCH / DEVICE_PICKER / COLOR_PICKER. |
| `ColorPicker` | Two color rows (selection-accent, external-playlist), per-theme tabs. Hex input with regex validation (commit-on-valid). |
| `ControlPane` | Right-edge slide-in drawer. Layout/Appearance/Authentication/Account sections. `<Toggle>` + `<Section>` + `<AuthStatusRows>` + `<Row>` helpers. |
| `FriendsOverlay` | Friend feed. Auto-refreshes every 60s. Plays clicked track via `play({ contextUri?, offsetUri, uris })`. `formatAgo` for "5m"/"3h"/"2d". |
| `JamOverlay` | Group session start/leave/share. 15s refresh. `navigator.clipboard.writeText` for the share link. |

---

## 5. Data flow (selected operations)

### 5.1 Boot / login (cookie path)
1. `App` mounts → `bootstrapAuth()`.
2. SPA → `GET /api/auth/status`. Sidecar reads file cookies, peeks token.
3. If `mode === 'none'`, SPA → `POST /api/auth/discover`. Sidecar runs Safari
   read → mirrors to file → mints token.
4. Result `mode === 'cookie'` flips `cookieMode = true` (auth.ts module).
5. `App` calls `fetchMe()` → `GET /api/me`. Sidecar caches in mem + on disk.
6. `Player` mounts → `refresh()` + `subscribeState`. First `refresh()`
   triggers `getPlaybackState()` + `getQueue()`, both cookie-mode → one
   `/api/proxy/state` call (deduped via `state.ts` inflight).

### 5.2 Refresh tick
1. Dealer push arrives at sidecar's `DealerClient`.
2. `stateStreamHandler` SSE proxies it as a `tick` event.
3. SPA `subscribeState` → `onTick` → `refresh()`.
4. `refresh()` calls `getPlaybackState()` + `getQueue()` — both go through
   `fetchClusterSnapshot()` (single in-flight request).
5. Stale-suppression: if `isXxxSuppressed()` is true for a field, the
   refreshed value for that field is overridden with the locally optimistic
   value. Same for device volume.

### 5.3 Play action (Space)
1. `togglePlayPause(refresh)` reads `playback.is_playing`, optimistically
   flips it via `usePlayer.optimisticIsPlaying(!wasPlaying)`, sets
   `suppress.isPlaying`.
2. Calls `pause()` or `play()` from `api/spotify.ts` → `tryConnect(primary,
   fallback)`.
3. Primary: `connectPause()` → `POST /api/proxy/connect/pause` → sidecar
   `connectClient.pause(read)` → `connect-state/v1/player/command/from/X/to/Y`.
4. On failure, fallback: `api('/me/player/pause', { method: 'PUT' })`.
5. After `PROPAGATION_DELAY_MS=300`, `refresh()` runs; suppression keeps the
   optimistic value visible until Spotify catches up.

### 5.4 Search
1. User types → `useSearch.setQuery(q)` (250ms debounce, monotonic id).
2. `search(q)` → cookie path: `searchViaPathfinder(q, 50, 0)` →
   `GET /api/proxy/search`. `synthesizeNexts` builds `pathfinder:search?...`
   next URLs per tab.
3. Component renders. User scrolls → `LoadMoreFooter` IntersectionObserver
   fires `loadMore(tab)` → `searchMore(nextUrl)` → `searchMoreViaPathfinder`
   → next page.

### 5.5 Open a playlist
1. User clicks row → `LibraryPanel.PlaylistRow.onClick`:
   `setFocusedRow(...)` + `selectPlaylist(p, editable)`.
2. `selectPlaylist(p, canEdit)`:
   - Captures `prior` snapshot.
   - If `playlistTracksCache.get(p.id)` is fresh, sets state immediately and
     returns (no network).
   - Else: fetches `fetchPage<PlaylistItem>('/playlists/{id}/items?limit=100')`
     → cookie path → `playlistTracksViaPathfinder(...)` → invokes
     `playlistMetaObserver` with owner metadata → state set, cache written.
3. `library.updatePlaylistOwner` patches the entry's `owner` so `canEdit`
   becomes accurate next time.

### 5.6 Connect-state command pipeline
For any write in `api/connect.ts`:
1. SPA → `POST /api/proxy/connect/<verb>`.
2. Sidecar `connectWriteHandler` → `connectClient.<verb>(read, body)`.
3. `connectClient`:
   - `getSessionAuth` → bearer + clientToken + clientVersion.
   - `ensureConnectionId` (dealer or one-shot WS).
   - `ensureRegistered` (PUT a hidden virtual device to track-playback/v1).
   - `fromTo` derives `from = play_origin || sidecar deviceId`, `to =
     active_device_id || detect-active`.
   - `sendCommand(...)` POSTs to `connect-state/v1/player/command/from/X/to/Y`.

---

## 6. Cleanup / unification candidates

### 6.1 Duplication

1. **Server JSON helpers.** `routes/auth.ts` and `routes/proxy.ts` each
   define their own `json`, `error`, `readJson`, `noContent`, `errMsg`,
   `clampInt` (proxy only). One `server/routes/_http.ts` would let both files
   import the shared set.

2. **`truncate(s, n=200)`.** Defined seven times: `api/connect.ts`,
   `api/friends.ts`, `api/jam.ts`, `api/lyrics.ts`, `api/pathfinder.ts`,
   `server/spotify/buddylist.ts`, `server/spotify/connect.ts`,
   `server/spotify/jam.ts`, `server/spotify/lyrics.ts`,
   `server/spotify/me.ts`, `server/spotify/pathfinder.ts`,
   `server/spotify/session.ts`, `server/spotify/token.ts`. Pull into
   `src/util/truncate.ts` and `server/util/truncate.ts`.

3. **`SEC_CH_UA` user-agent header.** Every spotify/* server module hard-codes
   the same Chromium UA string. One `server/spotify/headers.ts` with
   `webPlayerHeaders(auth, opts?)` would replace ~60 lines of repeated
   header objects (buddylist, connect, jam, lyrics, pathfinder, session).
   `connectHeaders` already takes a `withContentType` flag — that's a good
   shape to copy.

4. **`loadCookies()`.** Defined in `server/routes/proxy.ts` and
   `server/spotify/dealer.ts` with identical bodies (file → discover). Move
   to `server/cookies/index.ts` and import.

5. **Server-side type duplication of SPA shapes.** `server/spotify/state.ts`
   duplicates `Track`, `Episode`, `Album`, `Device`, `PlaybackState`, `Queue`
   because the server tsconfig can't see `src/`. Two paths forward: (a)
   create `web/shared/types.ts` and add it to both `tsconfig.include` arrays,
   or (b) accept the duplication but keep them in sync via a comment +
   typecheck. Today's comment says "duplicated" but there's no enforcement.

6. **`runtimeOs()`.** `server/spotify/connect.ts` and
   `server/spotify/session.ts` each define their own. Hoist to
   `server/spotify/runtime.ts`.

7. **`isNotFound(e)`.** In `server/cookies/file.ts` and
   `server/spotify/me.ts`. Trivial helper, but worth pulling into
   `server/util/fs.ts`.

8. **`idFromUri` / `typeFromUri`.** In `server/spotify/state.ts` and
   `src/api/pathfinder.ts`. Same logic, separate copies. Belongs in a shared
   util.

### 6.2 Inconsistencies / smells

9. **`fetchPage` interception.** `src/api/spotify.ts:fetchPage` matches paths
   like `/me/playlists?limit=50` against `pathfinder.ts:matchPagedPath` and
   only routes the three known shapes. The "translate /v1 path → cookie
   call" abstraction mostly serves the legacy `selectLiked()` flow. Since
   library + playlist already have direct cookie helpers
   (`fetchLibraryEntries`, `playlistTracksViaPathfinder`), the indirection
   could be flattened: every store just calls the cookie helper directly
   and falls back per-store rather than per-path.

10. **Two layers of cookie/Pathfinder fallback.** `tryConnect` (api/connect)
    and `isRetryablePathfinderError` (api/pathfinder) implement subtly
    different fallback policies:
    - `tryConnect`: catches *any* exception and falls back.
    - Pathfinder: only retries on 429/5xx/transport; bails on GraphQL or 4xx
      so we notice schema drift.
    Worth picking one strategy and applying it consistently — connect-state
    schema drift would also benefit from "loud failure" rather than silent
    fallback.

11. **`api/spotify.ts` is 624 lines and doing four jobs**: type definitions,
    PlaybackState/Queue/Devices reads, Search reads, and write commands. A
    split (e.g. `api/types.ts`, `api/playback.ts`, `api/search.ts`,
    `api/library.ts`) would localize churn and let tests target individual
    surfaces.

12. **Per-action notify/console.warn pairs.** Almost every cookie-path
    fallback in `api/spotify.ts` does
    ```ts
    notify('pathfinder X failed; falling back to /v1/Y', 'warn')
    console.warn('[spotui] pathfinder X failed, falling back:', e)
    ```
    Wrap as `warnWithNotify(notifyMsg, consoleMsg, e)` and call once per
    fallback site.

13. **`Refresh` callback prop drilling.** `App.refresh()` is wired via
    `onAfterAction` / `onAfterTransfer` / `onAfterPlay` props through
    multiple components. A single `useRefresh()` hook (or a Zustand-stored
    refresh function) would let any component call it without prop drilling.
    Today the `refresh` parameter is threaded through *every* command
    function in `commands.ts` — pulling it into a shared place would
    simplify command signatures too.

14. **Suppression flags in `commands.ts`.** Module-level mutable state
    (`suppress = {...}`) plus `isXxxSuppressed()` getters. App.tsx imports
    six of these to use in `refresh()`. Wrapping in a tiny stateful module
    (`src/playback/suppress.ts` exposing `markSuppressed(field)` + `apply(state)`)
    would centralize the dance.

15. **Optimistic update pattern.** Nine commands in `commands.ts` follow the
    same shape: snapshot current value → optimistic patch → suppress → API
    call → settimeout-refresh / rollback on error. A higher-order
    `withOptimistic({ field, target, call, refresh })` helper would dedupe
    `togglePlayPause`/`toggleShuffle`/`cycleRepeat`/`adjustVolume`/`seekTo`
    bodies. (Care: `skipNext`/`skipPrevious` don't have a single
    field-flip — those would stay separate.)

16. **`applyTheme` / `applyColors` run twice on boot.** `index.html` has an
    inline `dark`-class boot script; `store/ui.ts` then runs `applyTheme` +
    `applyColors` again on module init. Pre-paint logic could move entirely
    into the store init OR an early script — pick one.

17. **`HelpOverlay` keybinds list duplicates the `App.tsx` switch.** Adding
    a binding requires editing two files. Hoist `BINDINGS` to a single
    `src/keybinds.ts` map and have both consume it (App reads `key →
    handler`, HelpOverlay reads display labels).

18. **`canEdit` heuristic appears in two places.**
    `LibraryPanel.canEdit(p)` and `SelectedPlaylist`'s search-results
    playlist render (`p.owner.id === ownerId || p.collaborative`). Make a
    single `isOwnedOrCollaborative(playlist, ownerId)` helper.

19. **Sometimes-typo: `maybeCaptureprior`.** `src/store/selection.ts` —
    should probably be `maybeCapturePrior`.

20. **Three different "compact" layout switches.** `TransportBar.compact`,
    `QueuePanel.detailLayout === 'right'`, and `SelectedPlaylist`'s
    `detailLayout === 'right'` ternaries each branch on a single layout
    flag. They're not exactly the same condition (the transport one is a
    separate prop), but the pattern of branching grid/flex layouts inline
    deserves either a `<Row>` primitive or CSS-only handling via container
    queries.

21. **`api/connect.ts:tryConnect` vs `api/spotify.ts:try-fallback inline`.**
    `tryConnect` is used for transport writes; `getDevices`/`fetchPage`/`search`
    do the cookie-path-then-fallback pattern inline with their own try/catch
    + `notify`. Extract a single helper:
    ```ts
    async function withCookieFallback<T>(label, primary, fallback, isRetryable=ANY)
    ```
    that handles both notify + console.warn + retryability.

22. **`server/index.ts` log line.** The list of mounted routes is hard-coded
    in the console.log and *not* derived from the `ROUTES` array — easy to
    drift. Generate from `ROUTES`.

### 6.3 Dead / placeholder code

23. **`_cookieHeaderForConnect` in `server/spotify/connect.ts`.** Re-exported
    "in case we later need raw cookie attachment" — currently unused.
    Either delete or drop the export.

24. **`libraryAlbumsHandler`** is wired in the route table and exported, but
    the SPA never calls `/api/proxy/library/albums`. Either start using it
    (saved albums = parallel surface to playlists) or drop the export +
    route.

25. **`connect.ts`'s `void read` line.** In `ensureRegistered`. Keeps the
    parameter referenced — a more honest signature would drop the param.

26. **`SEARCH_TABS` re-export comment.** `src/store/search.ts` ends with a
    comment saying "Keep the helper around so the type usage above is valid"
    — but the alias is never imported. Safe to delete.

27. **`CookieSourceName`** has `'paste'` listed but the discovery diagnostic
    union doesn't carry it; only routes that explicitly call
    `persistPastedCookies({...source: 'paste'})` use it. Worth auditing
    whether `source` distinctions still pay rent in the status payload —
    `statusHandler` already collapses everything to "file" once persisted.

28. **`LyricsPanel` accepts no props but `LyricsPanel`'s `containerRef` is
    set but never read** — only `activeRef.current.scrollIntoView` is used.
    Remove `containerRef` ref and the unused `useRef`.

29. **`server/spotify/jam.ts` doesn't share its `jamHeaders` with other
    spclient modules** even though buddylist/lyrics/connect all build the
    same headers. See Cleanup #3.

### 6.4 Minor

30. **`web/server/routes/proxy.ts` is 598 lines** and mixes route handlers
    with handler factories. Splitting into `proxy/connect.ts`,
    `proxy/library.ts`, `proxy/state.ts`, `proxy/jam.ts` etc. would make
    "find this route's handler" trivial.

31. **Sidecar uses `console.warn` for runtime issues** but the SPA forwards
    them to the user via `notify()`. Server-side warnings only show in the
    dev terminal — fine for development, but worth documenting that the SPA
    has no visibility into sidecar-internal errors except via HTTP status.

32. **No ESLint / Prettier config in the repo.** Code style is consistent
    (single quotes, no semicolons, narrow line widths) but enforced by
    convention only.

---

## 7. Decisions and confirmed scope (2026-05-06)

These were open questions in an earlier draft; here are the answers we're
operating under, so refactor work doesn't re-litigate them.

- **PKCE stays.** It's a load-bearing fallback for when the spogo-style
  cookie + Pathfinder strategy fails (Spotify rotates a hash, the TOTP
  secret moves, dealer rejects the bearer, etc.). Don't simplify
  `auth.ts` / `api/client.ts` / `ControlPane` by dropping it.
- **`getRecentlyPlayed` is in active use.** Library sidebar's "Recently
  Played" row → `LibraryPanel.tsx:259` → `selectRecent()` (selection.ts) →
  `getRecentlyPlayed()` → `/v1/me/player/recently-played?limit=50`. No
  cookie path exists for this; spogo doesn't implement one either. Risk:
  `/v1` is the rate-limited host, but this only fires on user click of the
  "Recently Played" entry, not on every page load — acceptable as-is.
- **Queue is intentionally user-queued-only.** `QueuePanel` filters
  `_provider === undefined || 'queue'` on purpose. The only future
  consumer of additional queue metadata is jam shared queue. Therefore:
  - **`_provider`** stays — it's what the filter relies on.
  - **`autoplay_context_uri`** can be dropped from `Queue`,
    `server/spotify/state.ts:mapQueue` (the autoplay-context scan loop),
    and the type in `src/api/spotify.ts`. No consumer exists; future jam
    queue work won't need it. This is a small additional cleanup item
    (call it #33).
- **Dev-only deployment.** Operate as if `vite dev` is the only entry
  point. No `node server.js` standalone, no production preview. Server
  utility code can freely depend on Vite/dev-mode behavior without
  worrying about a future split.

---

## 7.5 Pre-refactor safety check (2026-05-06)

After applying the answers above, I re-walked every cleanup candidate to
confirm it's safe to do without breaking the app. Findings:

### Verified-dead, safe to delete outright

These were claimed dead in §6.3; I grepped each. Confirmed nothing reads them:

- **`_cookieHeaderForConnect`** (§6.3 #23) — only its own export line
  references it. `connect.ts:496`. Safe to drop the re-export.
- **`libraryAlbumsHandler` + `/api/proxy/library/albums` route** (§6.3 #24)
  — handler exists, mounted, no SPA caller. Safe to remove the export and
  the row in `server/index.ts:ROUTES`. (Or keep if you plan to add a Saved
  Albums sidebar section soon — it's a one-line route table entry.)
- **`SEARCH_TABS` re-export** (§6.3 #26) — only the export line. Drop both
  the export and the trailing comment in `src/store/search.ts`.
- **`LyricsPanel.containerRef`** (§6.3 #28) — `useRef` + `ref={...}`
  attached to the outer `<div>` but never read. The lyrics scroll-into-view
  logic uses `activeRef` only. Safe to remove the `containerRef` declaration
  and the `ref={containerRef}` attribute.
- **`Queue.autoplay_context_uri` plumbing** (new #33, per user answer #3) —
  field defined in `src/api/spotify.ts:104`, populated by
  `server/spotify/state.ts:mapQueue` (the autoplay-context scan loop, lines
  258–267 + 271). Zero consumers in any component. Safe to drop:
  - The `autoplay_context_uri?: string` field on `Queue` (both the SPA and
    server copies).
  - The `let autoplayContext` scan + `for (const t of rawNext)` loop in
    `mapQueue`.
  - The `autoplay_context_uri: autoplayContext` line in the return.
- **`void read` in `connect.ts:ensureRegistered`** (§6.3 #25) — function
  param is genuinely unused; the comment above it explains why it's
  retained. Safe to drop both the param and the `void read;` line.
- **Typo `maybeCaptureprior`** (§6.2 #19) — pure rename to
  `maybeCapturePrior`. Single file. Safe.

### Pure refactor — no behavior change

These can be done mechanically without risk to runtime behavior:

- §6.1 #1 server JSON helpers consolidation
- §6.1 #2 `truncate` consolidation (12+ copies)
- §6.1 #6 `runtimeOs()` consolidation
- §6.1 #7 `isNotFound()` consolidation
- §6.1 #8 `idFromUri` / `typeFromUri` consolidation
- §6.2 #11 `api/spotify.ts` split
- §6.2 #12 `notify` + `console.warn` pair wrapper
- §6.2 #14 `commands.ts` suppression flags into a small module
- §6.2 #17 `HelpOverlay` keybind table sourced from a shared map
- §6.2 #18 `canEdit` helper extraction
- §6.2 #20 `detailLayout` row primitive
- §6.2 #22 + §6.4 #30 `server/index.ts` log line + `proxy.ts` split
- §6.2 #27 audit `CookieSourceName` discriminator usage

### Needs care — risk of regressing PKCE fallback or write reliability

These are still good ideas but the migration must preserve specific
behaviors. Flagging the gotchas:

- **§6.1 #3 `SEC_CH_UA` / unified header builder.** Verified per-module
  drift: `pathfinder.ts` sends `Sec-Fetch-Site: same-site`, `token.ts`
  sends `Sec-Fetch-Site: same-origin`, others omit it; `connectHeaders`
  takes a `withContentType` flag. A unified builder must accept overrides
  for `Sec-Fetch-Site` and content-type. Don't blindly remove the per-call
  customizations — Spotify checks these.

- **§6.1 #5 server-side type duplication via shared dir.** Adding
  `web/shared/types.ts` to both `tsconfig.include` lists would unify the
  `Track` / `Episode` / `PlaybackState` / `Queue` / `Device` shapes between
  `src/api/spotify.ts` and `server/spotify/state.ts`. Risk: if you pull in
  more from `src/` than just types, the server tsconfig starts compiling
  React. Keep `shared/` types-only and re-verify with both tsconfigs.

- **§6.2 #9 flattening `fetchPage` interception.** 7 call sites:
  - `library.ts:145` (PKCE-only fallback path)
  - `library.ts:171` (PKCE-only loadMore path)
  - `selection.ts:172` (selectPlaylist primary)
  - `selection.ts:270` (selectLiked primary)
  - `selection.ts:332` (loadMoreTracks playlist branch)
  - `selection.ts:352` (loadMoreTracks liked branch)
  
  PKCE is load-bearing per §7. If you flatten, every site must reproduce
  the cookie-then-/v1 pattern explicitly or a PKCE-only user gets a broken
  Liked Songs / playlist pane. Easier path: leave `fetchPage` as the
  single decision point and only flatten when the abstraction stops paying
  rent.

- **§6.2 #10 + §6.1 #21 unifying fallback policy.** The asymmetry is
  *intentional*, not a smell:
  - Writes (`tryConnect`): catch anything → fall back to `/v1` PUT. User
    pressed Play; we MUST succeed somehow.
  - Reads (`isRetryablePathfinderError`): only retry on 429/5xx/transport;
    propagate 4xx + GraphQL errors loudly so we notice schema drift.
  Unifying to "loud fail on 4xx" everywhere would break write commands
  whenever connect-state hiccups. Unifying to "always swallow" would mask
  Pathfinder bugs. The right move is `withCookieFallback({ loudOn4xx: bool
  })` — keep both policies, just dedupe the boilerplate.

- **§6.2 #13 `Refresh` prop drilling.** `App.refresh()` is a closure over
  `setPlayback`/`setQueue` plus reads from `commands.ts`'s suppression
  flags. Replacing prop-drilling with a `useRefresh()` hook is fine, but
  the suppression-aware logic must move with it (or stay in App and the
  hook just exposes a stable reference). Don't lose the per-field
  suppression — it's what prevents Spotify's stale state from clobbering
  optimistic UI.

- **§6.2 #15 `withOptimistic` helper.** Each command flips a different
  field via a different store action: `optimisticIsPlaying` (toggle play),
  `patchPlayback({ shuffle_state })`, `patchPlayback({ repeat_state })`,
  `patchDevice({ volume_percent })`, `patchPlayback({ progress_ms })`.
  Helper signature must take both `apply()` and `rollback()` callbacks (or
  before/after values), not a single field name. `skipNext`/`skipPrevious`
  don't have an optimistic field at all — they can't share the helper.

### Wrong claim, please disregard

- **§6.2 #16 "applyTheme / applyColors run twice on boot".** I was wrong.
  They're complementary, not duplicate:
  - `index.html` inline script: toggles only the `<html class="dark">`
    class. Runs *before paint* to avoid a light-mode flash.
  - `store/ui.ts` module-init (line 301–305): toggles the class AND sets
    the `--color-accent` / `--color-external` CSS vars. The inline script
    can't easily set CSS vars (would need to read both `_dark` and
    `_light` keys + the active-theme key + apply the right pair).
  
  The "duplicate" framing is wrong. Leave both as-is unless someone wants
  to inline four more localStorage reads into the pre-paint script.

### Net answer

Every other cleanup item is safe given the constraints in §7. The biggest
single wins (in safety vs. payoff terms) are #2 `truncate`, #1 server JSON
helpers, #3 web-player headers builder, and the verified-dead deletions —
none of those touch the cookie ↔ PKCE fallback dance, and together they'd
trim several hundred lines.

---

## 8. File index (fast lookup)

```
web/
├── index.html                                  pre-paint theme + root mount
├── package.json
├── vite.config.ts                              registers spotuiSidecar
├── tsconfig.json / tsconfig.server.json        two project files
├── postcss.config.js / tailwind.config.js
├── WEB_PLAN.md                                 historical plan
├── server/
│   ├── index.ts                                Vite plugin: route table
│   ├── cookies/
│   │   ├── index.ts                            discover dispatcher
│   │   ├── file.ts                             cookie file persist
│   │   ├── paste.ts                            free-form paste parser
│   │   ├── safari.ts                           binarycookies parser
│   │   └── types.ts                            SpotifyCookie + helpers
│   ├── routes/
│   │   ├── auth.ts                             /api/auth/*
│   │   └── proxy.ts                            /api/proxy/* + /api/me
│   └── spotify/
│       ├── token.ts                            /api/token mint + cache
│       ├── totp.ts                             port of spogo totp.go
│       ├── session.ts                          bearer + clientToken + clientVersion + sp_t
│       ├── pathfinder.ts                       persisted-query GraphQL client
│       ├── hash.ts                             runtime SHA256 resolver
│       ├── connect.ts                          connect-state writes
│       ├── dealer.ts                           wss dealer client (singleton)
│       ├── state.ts                            cluster → public-Web-API mapper
│       ├── me.ts                               cached /v1/me + www fallback
│       ├── lyrics.ts                           color-lyrics/v2 client
│       ├── jam.ts                              social-connect/v2 client
│       └── buddylist.ts                        presence-view/v1 client
└── src/
    ├── main.tsx                                React root mount
    ├── App.tsx                                 shell + keybind dispatcher
    ├── commands.ts                             user-action functions + suppress
    ├── console.ts                              notify() shim into ui store
    ├── styles.css                              Tailwind entry
    ├── auth/
    │   ├── auth.ts                             bootstrap + PKCE + cookie token
    │   └── pkce.ts                             code verifier/challenge/state
    ├── api/
    │   ├── client.ts                           api<T>(path) for /v1
    │   ├── connect.ts                          /api/proxy/connect/* writes
    │   ├── events.ts                           SSE state stream
    │   ├── friends.ts                          friend feed
    │   ├── jam.ts                              jam session
    │   ├── lyrics.ts                           per-track lyrics + cache
    │   ├── me.ts                               /api/me wrapper
    │   ├── pathfinder.ts                       Pathfinder adapters
    │   ├── spotify.ts                          high-level surface
    │   └── state.ts                            cluster snapshot fetch
    ├── store/
    │   ├── library.ts                          playlists + folders
    │   ├── player.ts                           playback + queue + liked
    │   ├── search.ts                           search + per-tab loadMore
    │   ├── selection.ts                        open pane state
    │   └── ui.ts                               UI prefs + transient state
    └── components/
        ├── App shell:
        │   ├── ColorPicker.tsx
        │   ├── ControlPane.tsx
        │   ├── DevicePicker.tsx
        │   ├── FriendsOverlay.tsx
        │   ├── HelpOverlay.tsx
        │   └── JamOverlay.tsx
        ├── Library + Selected:
        │   ├── LibraryPanel.tsx
        │   ├── LoadMoreFooter.tsx
        │   └── SelectedPlaylist.tsx
        ├── Right side:
        │   ├── LyricsPanel.tsx
        │   ├── NowPlaying.tsx
        │   ├── ProgressBar.tsx
        │   ├── QueuePanel.tsx
        │   ├── RightPanel.tsx
        │   └── TransportBar.tsx
```
