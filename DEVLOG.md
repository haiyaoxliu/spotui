# spotui devlog

Reverse-chronological notes on what's built, what was tried, and why decisions
landed where they did. New entries go on top.

---

## v1 — 2026-05-01 — initial public release

First public cut. Single-binary, keyboard-first Spotify controller for the
terminal. Built in Rust on `ratatui` + `crossterm` + `rspotify`.

### What's in

**Five panes**, switchable with `tab`/`shift-tab` or `1`–`5`:

- **Library** — flat list of `/me/playlists`. Each row: name (colored by owner)
  + track count. Self-owned uses terminal default fg (theme-adaptive),
  Spotify-curated dims to gray + ⚠, others get a stable per-owner color from a
  4-color palette (light green / magenta / blue / red — yellow and cyan removed
  for legibility).
- **Listing** — tracks of the open playlist. Title shows `name — by owner ·
  count tracks · duration · since YYYY-MM`. Now-playing track highlighted in
  green inside the list.
- **Search** — split into two stacked panes (results above, input bar below).
  Sub-focus distinguishes typing-into-the-query from cursor-on-a-result. 180ms
  debounce on typing.
- **Now Playing** — title / artists / album / progress bar / state + volume.
  Fixed 10-row height; the rest of the right column goes to Queue.
- **Queue** — `/me/player/queue` polled every 5 seconds.

**Playback control** via Spotify Connect:

- `space` play/pause, `n`/`p` next/prev
- `[`/`]` and `←`/`→` (on Now Playing) seek 5s
- `+`/`-` volume +/-5
- `q` queue cursor track in Listing or Search-Results
- `Q` play cursor track now (replaces playback — closest the Web API offers to
  "top of queue")
- `enter` plays in playlist/search context
- `a` adds now-playing to the open playlist (or in Search-Results, adds the
  cursor track)
- `d` opens the device picker overlay (Spotify Connect transfer)
- `?` opens the keybind help overlay
- `R` reloads playlists from the API

### Architecture

**State + actions**: `App` holds all UI state. A single `mpsc::UnboundedSender<Action>`
threads events from the keyboard loop, the playback poller (every `poll_ms`,
1s by default), the queue poller (5s), and one-shot loaders (playlists tracks,
search, devices, current user). The render loop is `recv → apply_action → draw`
in a tight loop, so every keystroke and poll tick produces a fresh frame.

**Auth**: PKCE flow via `rspotify`. First run prompts for a Client ID
interactively (TTY-detected), writes `config.toml`, then opens a browser to the
authorize URL. The callback at `127.0.0.1:8888/callback` is served by an
in-process loopback `TcpListener` that captures the code, swaps it for a token,
and persists `token.json`. Subsequent launches read the cached token and
refresh transparently.

**HTTP**: `reqwest` shared via `OnceLock<Client>`. Custom `get_json` helper
retries on transient errors and honors `Retry-After` on 429. We avoid
`rspotify`'s strict deserializer for endpoints with churning shapes
(`/me/player`, `/me/playlists`, `/playlists/{id}/items`) and parse `serde_json::Value`
ourselves — Spotify ships new content types and field renames frequently, and
strict parsing fails closed.

**Endpoint specifics**:
- `/playlists/{id}/tracks` is deprecated and returns 403 to new dev-mode
  apps. We use `/playlists/{id}/items` and read `item.item` (legacy was
  `item.track`).
- `track_count` lives at `items.total` in current responses, not the older
  `tracks.total`. We accept either.
- `/me/player` can return 204 (no playback) — handled as `Ok(None)`.

**Cache**: `~/Library/Caches/spotui/`
- `playlists.json` — versioned + timestamped Vec<PlaylistRef>. Loaded at
  startup so the Library renders instantly while the network fetch runs.
- `tracks/<playlist_id>.json` — keyed by Spotify's `snapshot_id`. A cache hit
  is valid only when the snapshot matches; otherwise we re-fetch.
  Invalidated automatically when you (or someone you collaborate with) modify
  the playlist.

**Theme adaptivity**: primary text uses `Color::Reset` (terminal default)
rather than `Color::White`, so light-themed terminals render legibly. Accent
colors (Cyan/Green/Magenta/etc.) read fine on both.

**List width math**: every list pane budgets columns against
`area.width - 2 (borders) - 2 (highlight_symbol "▸ ")`. Forgetting the
highlight prefix overflowed right-aligned columns by 2 cells; constant
`HIGHLIGHT_PREFIX_W` keeps the four panes consistent.

### What's deliberately not in v1

- **Album art**. We tried three implementations: chafa subprocess, in-process
  half-block via `image` crate, and `ratatui-image` with halfblocks fallback.
  Each had drawbacks (chafa probes the terminal and leaks key events into the
  search bar on resize; in-process didn't add enough over chafa's halfblocks;
  ratatui-image worked but had been removed before this release pending a
  cleaner integration). NowPlaying is text-only for v1.
- **Owner sectioning + sort**. Tried grouping the Library by owner with section
  headers and `o`/`O` jump keys; reverted to plain Spotify-default ordering.
  Owner identity is conveyed via per-row name color instead.
- **Background lazy stats filler**. We ran a throttled fetch loop after
  startup to populate date/length for every playlist; pulled it because the
  per-playlist stats are only relevant when a playlist is open. The Listing
  header carries that data now, populated on the foreground fetch when you
  open a playlist.
- **Sort modes**, **multi-select**, **multi-listing tiles**, **mouse support**,
  **dynamic pitch visualizer**, **playlist creation**, **library folders**.
  All considered; deferred or rejected.

### Known limitations

- **Spotify dev mode**: editorial (Spotify-owned) playlists return 403. The
  Library marks them with a ⚠ and dims them. Your own playlists work fine.
- **Premium-only**: Spotify Connect playback control requires Premium. Free
  accounts can browse but not control playback.
- **Single device active**: actions follow whichever device is "active" per
  Spotify. Press `d` to transfer between devices.
- **No "true top of queue"**: the Web API doesn't expose queue insertion,
  only append. `Q` is a "play this now" replacement instead.

### Next likely directions

- Album art via `ratatui-image` (halfblocks on Terminal.app, true images on
  iTerm2/Kitty/Sixel terminals).
- Sort options on Library (date added, name, length, count) with `o` to cycle
  and persistence in `config.toml`.
- "Recently played" pane (the scope is granted; just needs UI).
