# Cookie-auth migration plan

Branch: `explore/cookie-auth-bypass`. Long-lived; phases land as separate
commits, each leaves the app in a working state.

## Goal

Move spotui off the public Spotify Web API as the primary backend.
Authenticate by reading the user's `sp_dc` / `sp_t` cookies from the browser
they're logged into (`open.spotify.com`) and call Spotify's internal endpoints
— the same ones the web player uses. The PKCE Web API stays in the binary as
a **fallback** for ops the internal path can't cover, and as a safety net when
the cookie path is broken (token mint failure, hash resolution failure, 5xx).

The reference implementation we're porting from is
[`openclaw/spogo`](https://github.com/openclaw/spogo) (MIT, Go, ~9.5k LoC of
spotify-package code). Its hybrid `connect` engine works exactly this way: try
internal first, fall back to web on rate-limit or unsupported feature.

## Why

Spotify dev-mode tightening (Feb 2026):

- 5 authorized users / app (was 25).
- Premium required on the dev account.
- Endpoint allowlist: batch `/tracks`, `/albums`, `/artists`,
  `/browse/*`, `/users/{id}`, `/markets` removed for dev mode.
- Search `limit` capped at 10 (was 50).
- `popularity`, `available_markets`, `external_ids`, `followers`, user
  `country`/`email`/`product` stripped from responses.
- `/audio-features`, `/audio-analysis`: 403 to any new app.
- Editorial (Spotify-curated) playlists: 403 to any dev-mode app.

Internal endpoints (`spclient.wg.spotify.com`, `gue1-spclient.spotify.com`,
`api-partner.spotify.com/pathfinder`, `wss://dealer.spotify.com`) are not
subject to these restrictions and have rate limits suitable for a real
client. They're undocumented and can change without notice — the porting
strategy weights heavily toward runtime-resilient code (live JS-bundle
parsing for GraphQL hashes, env-var overrides for the moving parts).

## Out of scope (explicitly deferred)

- **Spotify Jam.** Existing `src/jam.rs` + `src/jam_net.rs` are mDNS-based
  local-network code; not affected by this migration. We may revisit later if
  the cookie path exposes server-side jam data, but Jam is not part of this
  branch's scope.
- **Friend activity** (`guc-spclient.spotify.com/presence-view/v1/buddylist`).
  Cookie auth unlocks it cleanly, but there's no UI surface for it yet.
  Deferred until after the core migration lands.
- Free-account (non-Premium) playback via `connect-state`. Possible with
  cookie auth but a separate product decision.
- Virtual-device registration (`track-playback/v1/devices`) — making spotui
  itself a Spotify Connect target. Different product.

## Architecture

### Backend trait

A single backend trait that high-level callers (`app.rs`, `diag.rs`,
`cache.rs`) talk to. Two implementations:

```
trait Backend: Send + Sync {
    // playback
    async fn fetch_playback(&self) -> Result<Option<Playback>>;
    async fn fetch_queue(&self) -> Result<Vec<TrackRef>>;
    async fn play_uris(&self, uris: &[String], device: Option<&str>) -> Result<()>;
    async fn play_in_context(&self, ctx_uri: &str, offset: usize, device: Option<&str>) -> Result<()>;
    async fn pause(&self) -> Result<()>;
    async fn next(&self) -> Result<()>;
    async fn previous(&self) -> Result<()>;
    async fn seek_to(&self, pos_ms: i64) -> Result<()>;
    async fn set_volume(&self, vol: u8) -> Result<()>;
    async fn add_to_queue(&self, uri: &str) -> Result<()>;
    async fn list_devices(&self) -> Result<Vec<DeviceRef>>;
    async fn transfer_to_device(&self, id: &str, play: bool) -> Result<()>;

    // library
    async fn list_playlists(&self) -> Result<Vec<PlaylistRef>>;
    async fn list_playlist_tracks(&self, id: &str) -> Result<(Vec<TrackRef>, PlaylistMeta)>;
    async fn save_to_library(&self, uris: &[String]) -> Result<()>;
    async fn remove_from_library(&self, uris: &[String]) -> Result<()>;
    async fn library_contains(&self, uris: &[String]) -> Result<Vec<bool>>;
    async fn add_tracks_to_playlist(&self, id: &str, uris: &[String]) -> Result<()>;
    async fn fetch_me(&self) -> Result<Me>;

    // search
    async fn search_tracks(&self, q: &str, limit: u32) -> Result<Vec<TrackRef>>;
}

struct CookieBackend { /* + PkceBackend as fallback */ }
struct PkceBackend  { /* existing rspotify path */ }
```

`CookieBackend` holds a `PkceBackend` and uses `withWebFallback` semantics on
each method. Routing:

- **First**: try internal (cookie/Pathfinder/connect-state).
- **Fallback** if the internal call returns a known recoverable error (HTTP
  5xx, hash resolution failed, 429, ToS-block, deserialize miss).
- **Surface immediately** for definitive errors (auth invalid, 4xx with
  meaningful body other than 429).

### Modules

```
src/
  cookie/                  NEW
    mod.rs                 module exports
    totp.rs                TOTP secret fetch + HMAC-SHA1 HOTP    [phase 1]
    token.rs               CookieTokenProvider (mints web token) [phase 1]
    cookies.rs             CookieSource trait, paste + file      [phase 1]
    safari.rs              ~/Library/Cookies/Cookies.binarycookies parser [phase 1.5]
    session.rs             client-token + clientVersion + sp_t   [phase 2]
    pathfinder.rs          GraphQL query client                  [phase 2]
    hash.rs                runtime sha256Hash resolver           [phase 2]
    connect.rs             connect-state/v1 commands             [phase 3]
    dealer.rs              wss://dealer.spotify.com/             [phase 3]
    lyrics.rs              spclient color-lyrics/v2              [phase 4]
  backend/                 NEW (trait + dispatch)
    mod.rs                 Backend trait
    cookie.rs              CookieBackend impl (cookie + fallback)
    pkce.rs                PkceBackend impl (current spotify.rs reorganized)
  ...
```

`spotify.rs` becomes thin — its existing content moves into
`backend/pkce.rs` largely unchanged. Call sites in `app.rs` switch from
`spotify::fetch_playback(client)` to `backend.fetch_playback()`.

### Auth modes

`config.toml` adds:

```toml
[auth]
mode = "cookie"          # "cookie" | "pkce"  (default: cookie)
cookie_browser = "safari" # "safari" | "chrome" | "paste"  (default: safari)
```

First-run UX:

- **Default (cookie)**: walk through browser-cookie import. macOS-only on the
  Safari path. Chrome path needs Keychain access (planned for phase 1.5).
  Paste path is the universal fallback (`spotui auth paste`).
- **PKCE (opt-in)**: existing first-run flow unchanged.

When the cookie path can't bootstrap (no cookies, expired `sp_dc`), spotui
prompts the user to re-import and falls back to PKCE if they decline. PKCE
auth artifacts (`token.json`, `client_id` in `config.toml`) coexist so users
can switch modes without re-authenticating.

### TOTP secret + clientVersion handling

The TOTP secret rotates and the `clientVersion` (`harmony:4.43.2-...`) ages
out. spogo solves both with env-var overrides + public-mirror fallbacks. We
copy the same pattern:

- `SPOTUI_TOTP_SECRET_URL` overrides the secret source (HTTP or `file://`).
- `SPOTUI_CONNECT_VERSION` overrides the connect client-version string.
- Default secret URLs (in priority order):
  1. `https://github.com/xyloflake/spot-secrets-go/raw/main/secrets/secretDict.json`
  2. `https://github.com/Thereallo1026/spotify-secrets/raw/main/secrets/secretDict.json`
- 15-minute in-memory cache.
- Hardcoded fallback (current published version) so first-launch works
  offline if Spotify hasn't rotated.

The `clientVersion` is scraped from the live `<script id="appServerConfig">`
on `open.spotify.com` at session-init time (matches spogo
`connect_session.go`).

### Persisted-query hash resolution

Pathfinder uses `{operationName, persistedQuery: {sha256Hash}}`. Hashes change
when Spotify ships a new web bundle. spogo's solution:

1. Fetch `open.spotify.com` HTML, regex out the web-player JS bundle URL.
2. Fetch the bundle, regex-match `{operationName} ... sha256Hash:"..."`.
3. If not found in the main bundle, parse the webpack chunk-hash and
   chunk-name maps, fetch each chunk, repeat.
4. Cache the resolved hashes by `clientVersion` in
   `~/Library/Caches/spotui/pathfinder-hashes.json` so we don't redo the
   network/regex work every launch.

`hash.rs` is a direct port of `connect_hash.go`.

## Phases

### Phase 1 — cookie token mint  *(this commit)*

Land the smallest end-to-end piece that proves auth works.

- `src/cookie/totp.rs` — secret fetch + cache + HMAC-SHA1 HOTP.
- `src/cookie/cookies.rs` — `CookieSource` trait, paste + file impls.
- `src/cookie/token.rs` — `CookieTokenProvider`: cookie → bearer + clientId.
- Self-contained module with unit tests against known TOTP vectors. Not yet
  wired into `app.rs`.
- New deps: `hmac`, `sha1`.

**Done when:** `cargo test cookie` passes and a manual `spotui auth paste`
mints a real bearer token from `open.spotify.com/api/token`.

### Phase 1.5 — Safari binarycookies reader *(next commit)*

- `src/cookie/safari.rs` — read `~/Library/Cookies/Cookies.binarycookies`,
  filter by domain `.spotify.com`, return `sp_dc` / `sp_t` / `sp_key`.
- Add `spotui auth import-cookies --browser safari` subcommand.
- Add `[auth] mode` and `[auth] cookie_browser` to `config.toml`.

**Done when:** `spotui auth import-cookies --browser safari` reads the live
cookies and re-uses them for token mint.

### Phase 2 — Pathfinder GraphQL + hash resolver

- `src/cookie/session.rs` — manages bearer + client-token + clientVersion +
  device-id (`sp_t`).
- `src/cookie/hash.rs` — JS-bundle scraper, persistent cache.
- `src/cookie/pathfinder.rs` — GraphQL POST with persisted queries.
- `src/backend/mod.rs` — `Backend` trait.
- `src/backend/pkce.rs` — move existing `spotify.rs` content here, unchanged.
- `src/backend/cookie.rs` — `CookieBackend` with web-fallback wrappers.
- Wire ops one at a time: `searchDesktop` → `libraryV3` → `fetchPlaylist`.
  Each ops PR re-points one `app.rs` call site.

**Done when:** library / search / playlist tracks all flow through the
cookie path; `Library` no longer dims editorial playlists; search results
no longer cap at 10.

### Phase 3 — connect-state + dealer WebSocket

- `src/cookie/connect.rs` — `connect-state/v1` and `track-playback/v1`
  commands: play, pause, next/prev, seek, volume, shuffle, repeat,
  transfer, queue-add. Direct port of spogo `connect_commands.go` +
  `connect_helpers.go`.
- `src/cookie/dealer.rs` — `wss://dealer.spotify.com/?access_token=...`
  with ping/pong + player-state subscription. Replaces the `poll_ms`
  loop and the 5s queue poll.
- Drop `poll_ms` from `Config`.

**Done when:** transport bar, queue, and now-playing all update from
push events; no more 1s/5s polling.

### Phase 4 — lyrics

- `src/cookie/lyrics.rs` — `GET spclient.wg.spotify.com/color-lyrics/v2/track/{id}`.
- New pane state in `app.rs` (or extension of NowPlaying); UI in `ui.rs`.
- Cache lyrics by track id in `~/Library/Caches/spotui/lyrics/{id}.json`.

**Done when:** Now Playing renders synced lyrics for tracks Spotify has
them for, falls back to "no lyrics" otherwise.

### Phase 5 — cleanup

- Delete dead code in `backend/pkce.rs` for any op fully replaced by
  cookie path (keep what's still used as fallback).
- `--diag` probe battery extends to cover cookie-path health (token mint,
  hash resolution, dealer connect).
- README + DEVLOG updates.
- Decide: merge to `master` as opt-in default, or stay on this branch.

## Testing

Unit tests live next to each module (`#[cfg(test)] mod tests` — Rust
convention). spogo's test suite is a useful oracle:

- TOTP: known-vector tests against spogo's `totp_test.go`.
- Hash parser: snapshot test against a frozen JS bundle.
- Pathfinder: `mockito` for HTTP, fixture responses captured from real calls.

Integration test: a `--smoke` flag that runs auth + one search + one library
fetch + dealer connect. Run manually pre-merge of each phase.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| TOTP secret rotates | Quarterly | Mirror-list fallback + `SPOTUI_TOTP_SECRET_URL` override |
| `clientVersion` aged out | Monthly | Live scrape from `open.spotify.com`; `SPOTUI_CONNECT_VERSION` override |
| Pathfinder hash changes | Per web-player release | Runtime resolution from JS bundle; cache by `clientVersion` |
| Spotify revokes our `sp_dc` | Per-account, rare | Re-import flow; PKCE fallback always present |
| Spotify ToS escalation | Possible | Local-only tool, no distribution of secrets, no scraping for AI training. Document clearly in README that this is undocumented territory. |
| `Cookies.binarycookies` format change | Rare | Format hasn't changed in years; if it does, paste flow is the workaround |

## Reference

- spogo source: `/tmp/spogo-research/spogo/internal/spotify/` (cloned for this work)
- TOTP implementation: spogo `internal/spotify/totp.go`
- Token mint: spogo `internal/spotify/token.go`
- Connect session (client-token, clientVersion): spogo `internal/spotify/connect_session.go`
- Pathfinder + hash resolver: spogo `internal/spotify/connect_pathfinder.go` + `connect_hash.go`
- Connect commands: spogo `internal/spotify/connect_commands.go`
- License: both projects MIT — port + attribute.
