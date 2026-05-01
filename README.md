# spotui

A keyboard-first Spotify controller for the terminal. Multi-pane TUI for browsing your library, queuing tracks, controlling playback, and searching — built in Rust on `ratatui` + `rspotify` (PKCE auth).

```
┌─ 1  Library (300) ──────┐ ┌─ 2  情人 — by hoyo · 21 tracks · 1h23m · since 2021-09-12 ┐ ┌─ 3  Now Playing ──┐
│ ▸ 情人               21 │ │   1  Track Name      Artists       Album         3:42  │ │ Track Title       │
│   Spaghetto         45  │ │   2  Another One    More Artists   Same Album   4:01    │ │ Artist            │
│   classical v2       5  │ │ ▸ 3  Currently      Now Playing   Album Name    3:18    │ │ Album             │
│   ...                   │ │   ...                                                    │ │ ████████░░  1:23 / 3:42 │
│                         │ │                                                          │ │ ▶ playing  vol 65% │
│                         │ ├─ 4  Search Results (12) ─────────────────────────────────┤ ├─ 5  Queue (4) ────┤
│                         │ │   ...                                                    │ │ Up next 1         │
│                         │ ├─ 6  Search ──────────────────────────────────────────────┤ │ Up next 2         │
│                         │ │ / radiohead lucky▌                                        │ │ ...               │
└─────────────────────────┘ └──────────────────────────────────────────────────────────┘ └───────────────────┘
 library  ↑/↓ move • enter open • / search • R reload                              ctrl-c quit
```

## Requirements

- macOS (Terminal.app, iTerm2) or any modern Unix terminal
- Rust 1.75+ (install via [rustup](https://rustup.rs))
- A **Spotify Premium** account — Spotify Connect playback control is Premium-only
- A registered Spotify app (free; instructions below)

## Install

```sh
git clone https://github.com/<you>/spotui.git
cd spotui
cargo install --path .
```

`cargo install` puts the binary at `~/.cargo/bin/spotui`. Make sure that's on your `PATH`.

For local development:

```sh
cargo run
```

## First run

The app walks you through Spotify-side setup the first time you launch it. You'll see:

```
=== spotui first-run setup ===

1. Open https://developer.spotify.com/dashboard and create an app.
2. In the app's Edit Settings:
     - Add this Redirect URI exactly:
         http://127.0.0.1:8888/callback
     - Under "User Management", add the email you sign in with
       (Spotify dev mode requires it).
3. Copy the app's Client ID and paste it below.

Client ID:
```

Paste your Client ID, hit enter, and the OAuth flow opens in your browser. After you approve, the callback at `127.0.0.1:8888` finishes the handshake and the TUI launches.

The Client ID and refresh token are persisted at `~/Library/Application Support/spotui/` (macOS) so subsequent launches are instant.

## Keybinds

### Global

| Key | Action |
|---|---|
| `ctrl-c` | Quit |
| `space` | Play / pause |
| `n` / `p` | Next / previous track |
| `[` / `]`, `←` / `→` | Seek -5s / +5s (←/→ only on Now Playing) |
| `+` / `-` | Volume +5 / -5 |
| `R` | Reload library |
| `d` | Device picker |
| `?` | Help overlay |
| `tab` / `shift-tab` | Cycle panes |
| `1`–`5` | Jump to pane |
| `esc` | Close overlay / clear status |

### Library (pane 1)

| Key | Action |
|---|---|
| `↑` `↓` `j` `k` | Move cursor |
| `shift+↑` `shift+↓` `J` `K` | Move cursor by 10 |
| `g` / `G` | Top / bottom |
| `enter` | Open playlist into Listing |
| `/` | Focus search |

### Listing (pane 2)

| Key | Action |
|---|---|
| `↑` `↓` `j` `k` | Move cursor |
| `shift+↑` `shift+↓` `J` `K` | Move cursor by 10 |
| `enter` | Play track in playlist context |
| `q` | Queue cursor track |
| `Q` | Play cursor track now |
| `a` | Add now-playing track to this playlist |

### Search (pane 5)

The pane has two sub-focuses — input (the bar) and results (the list above).

| Key (input)   | Action                                |
|---------------|---------------------------------------|
| _typing_      | Live query (180ms debounce)           |
| `↓` / `enter` | Jump focus to results                 |
| `ctrl-a`      | Add cursor result to open playlist    |
| `esc`         | Defocus pane                          |

| Key (results) | Action                                |
|---------------|---------------------------------------|
| `enter`       | Play                                  |
| `q` / `Q`     | Queue / play-now                      |
| `a`           | Add to open playlist                  |
| `/`           | Back to input                         |

## Files & paths

| Path | Contents |
|---|---|
| `~/Library/Application Support/spotui/config.toml` | Client ID, redirect port, default device |
| `~/Library/Application Support/spotui/token.json` | OAuth refresh token (sensitive) |
| `~/Library/Caches/spotui/` | Playlist + track metadata cache (snapshot-keyed) |
| `~/Library/Application Support/spotui/log/spotui.log` | Daily-rotated debug log |

To reset state (re-auth, clear cache), delete the contents of those directories.

## Diagnostics

```sh
spotui --diag
```

Runs a battery of API probes against your account (playback, devices, playlists, scopes, etc.) and prints results. Useful when something looks wrong before opening an issue.

## Troubleshooting

**"client_id is unset" / config errors.**  Re-run `spotui` interactively (a real terminal, not a piped pipeline). The first-run prompt only fires when stdin is a TTY.

**OAuth callback hangs.**  The redirect URI in your Spotify app dashboard must be **exactly** `http://127.0.0.1:8888/callback` — trailing slashes and `localhost` instead of `127.0.0.1` will all silently break.

**403 on playlist tracks.**  Spotify dev-mode apps can't read editorial (Spotify-curated) playlists. Your own playlists work; "Today's Top Hits" et al. won't.

**403 on play/pause.**  Make sure your account email is added under "User Management" on the dashboard. New dev-mode apps need every account email registered explicitly.

**No devices visible.**  Open Spotify on a phone, desktop client, or speaker — Spotify Connect can't see your account until at least one client is online. Then press `d` in spotui to transfer.

## Project layout

```
src/
  main.rs       entry point + logging init
  config.rs     paths + first-run setup
  auth.rs       PKCE flow, token cache, loopback redirect
  spotify.rs    HTTP wrappers (lenient JSON; snapshot-keyed cache)
  cache.rs      playlists.json + tracks/<id>.json on-disk cache
  app.rs        App state, action loop, key handling
  ui.rs         ratatui rendering for all panes
  diag.rs       --diag probe battery
```

See [`DEVLOG.md`](DEVLOG.md) for design decisions and version history.

## License

MIT — see [`LICENSE`](LICENSE).
