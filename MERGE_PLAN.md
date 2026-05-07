# MERGE_PLAN

Branch: `tui/serve-web`. Goal: collapse the Rust TUI (root) and the web app
(`web/` SPA + Node sidecar) into one Rust binary that does both — a Spotify
controller in the terminal, and a thin-client HTTP server for browser access
over Tailscale only.

## Status

- **Phase 0** — code landed; positive-path smoke test (curl `/healthz` from
  a Tailnet peer) still pending. Strict-fail path verified locally
  (binary exits 1 with `tailscale0 interface not found` when Tailscale is
  down).
- **Phase 1+** — not started.

**Resume here.** Bring Tailscale up on the host machine, then run
`cargo run -- serve`. From another Tailnet peer, `curl
http://<tailscale-ip>:7878/healthz` should return `ok <hostname>`. Confirm
the same address is unreachable from a non-Tailnet machine. Once that's
green, proceed to Phase 1.

**End state.** One `spotui` binary. `spotui` runs the TUI; `spotui serve`
runs the TUI plus an HTTP server bound exclusively to the `tailscale0`
interface. Browser clients receive pre-rendered HTML fragments over SSE; all
Spotify state and logic live in the Rust process. No Node, no Vite, no React
build, no public network surface.

**Thin-client principle.** All operations execute on the binary. The browser
gets the bare minimum of visual information (HTML fragments per region) and
emits intents (POST). It never holds Spotify state, never transforms API
payloads, never decides what to render — the server hands it the rendered
fragment.

**Security posture.** The HTTP server binds to a single IPv4 address: the
host's `tailscale0` address (must fall in `100.64.0.0/10`). No `0.0.0.0`,
no `127.0.0.1`, no LAN bind. If Tailscale isn't up at startup, refuse to
serve.

---

## Phase 0 — Merged-binary scaffold + strict Tailscale bind

- Add `axum` (or `hyper` + `tower-http`) and `tokio` to `Cargo.toml`.
- New CLI subcommand: `spotui serve` (default `spotui` keeps current TUI
  behavior).
- Resolve the Tailscale interface at startup: walk interfaces, find
  `tailscale0`, take its IPv4 (must be in `100.64.0.0/10`). If absent →
  exit with a clear error. No fallback, no LAN bind.
- Bind the HTTP listener to that single IP only.
- Serve a placeholder `/healthz` returning the Tailnet hostname.

**Acceptance.** Reachable from another Tailnet peer; refused via
`127.0.0.1`, LAN IP, and from outside the Tailnet.

## Phase 1 — Cookie + token plane in Rust

- Audit `src/cookie/` against `web/server/cookies/` and
  `web/server/spotify/token.ts`. Likely gaps: Safari auto-discovery,
  paste-mode capture, TOTP rotation timing, token refresh under 429.
- Port what's missing; keep one canonical store at
  `~/Library/Application Support/spotui/web-cookies.json` (the file the
  Node sidecar already uses).
- Wire `getToken()` into the HTTP server.

**Acceptance.** `GET /api/me` (still old wire format) returns the profile
via the Rust path; Node sidecar can be killed and the SPA still boots
through a feature flag pointing at the Rust port.

## Phase 2 — Port the Node sidecar's API surface route by route

The SPA stays React for now; we swap its backend. Port in this order, each
shippable on its own:

1. `/api/me` (cache to disk; same `me.json` shape).
2. `/api/proxy/pathfinder/*` (biggest chunk — queries + retries + bearer
   selection).
3. `/api/proxy/connect/*` (cluster snapshot, transfer, play/pause/seek,
   queue).
4. `/api/proxy/state/stream` (dealer SSE relay).
5. `/api/proxy/lyrics/:id`, `/api/proxy/friends`, `/api/proxy/jam/*`.

Each port preserves the wire format so the SPA needs no changes. A
`RUST_BACKEND=1` flag in the SPA toggles which backend it hits; flip per
route as they land.

**Acceptance.** Node sidecar shut down for an entire session, full SPA
functionality intact.

## Phase 3 — Single source-of-truth state machine

- One Rust `AppState` mirrors what both surfaces need: current track,
  progress, device list, queue, library tree, selected playlist, lyrics,
  friends, jam.
- Inputs: cluster snapshots + dealer events + on-demand Pathfinder fetches
  (cached).
- TUI reads from `AppState` directly; web layer reads through a view-model
  adapter (next phase).
- Where possible, replace per-request fetches with subscriptions on
  `AppState`'s broadcast channel.

**Acceptance.** TUI runs off `AppState`; web still served via phase-2 API
but both surfaces stay visibly in sync.

## Phase 4 — Thin-client protocol (HTML over SSE)

- Regions: `now-playing`, `queue`, `library`, `lyrics`, `control-bar`,
  `friends-overlay`, `jam-overlay`.
- `GET /` returns a static HTML shell with `<div id="region-now-playing">`
  etc., a small CSS bundle, and a ~200-line vanilla JS client.
- `GET /events` is an SSE stream. Each event has `event: <region>` and
  `data: <html-fragment>`. Server diffs `AppState` against the last-sent
  state per connection and emits only changed regions; full snapshot on
  connect.
- Client JS: open SSE, swap `innerHTML` of the matching region per event.
  Delegate clicks/keys to a tiny dispatcher.
- Intents are POSTs: `/intent/play`, `/intent/pause`, `/intent/seek?ms=`,
  `/intent/select-playlist/:uri`, `/intent/queue/:uri`, etc. Server
  mutates `AppState`, pushes a Spotify command, returns `204`. SSE then
  propagates the change.
- Sub-steps: ship `now-playing` + `control-bar` first end-to-end on the
  new path while the rest of the SPA runs old; then migrate region by
  region.

**Acceptance.** Thin client at feature parity with the React SPA. Bytes
per state change should be small — one fragment, not a JSON tree the
client re-renders from.

## Phase 5 — Retire React + Vite

- Delete `web/src/`, `web/vite.config.ts`, `web/package.json`,
  `web/tsconfig*.json`, `web/server/` (now fully ported).
- Move thin-client HTML/JS/CSS templates into Rust source, included via
  `include_str!` (or a `templates/` dir loaded at build time).

**Acceptance.** Repo has no Node toolchain. `cargo build` is the only
build step.

## Phase 6 — Single-binary packaging

- Embed all static assets via `rust-embed` or `include_bytes!`.
- One `spotui` binary, no runtime asset paths.

**Acceptance.** Copy the binary to a fresh machine on the Tailnet, run
`spotui serve`, browser works.

---

## Cross-cutting risks

- **No browser audio playback exists today** — everything routes to a
  Spotify Connect device — so the thin-client move loses nothing. The
  Web Playback SDK is the only feature that would require a fatter
  client; out of scope.
- **Multi-client viewing the same state** is a feature, not a bug. TUI +
  phone browser + laptop browser all see one view. Per-client view state
  (different selections per device) would go onto `AppState` as
  per-session state keyed by a session cookie; out of scope here.
- **Tailscale up/down at runtime.** If the interface drops, the listener
  should error and the binary exits (or supervisor-restart). Do not
  rebind elsewhere.
