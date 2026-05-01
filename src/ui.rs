use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};

use crate::app::{App, Overlay, Pane, Playback, SearchSubFocus};

/// Cell width of the `highlight_symbol` prefix on every List row. The widget
/// reserves this margin for ALL rows (selected and not) so columns stay aligned;
/// list-pane width budgets must subtract this in addition to the 2-cell border.
const HIGHLIGHT_PREFIX_W: usize = 2;

pub fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(area);
    let main = outer[0];
    let status_area = outer[1];

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(22),
            Constraint::Percentage(50),
            Constraint::Percentage(28),
        ])
        .split(main);

    // Column 2: Listing on top, then Search Results, then Search Input bar.
    let mid_rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(8),
            Constraint::Length(8),
            Constraint::Length(3),
        ])
        .split(cols[1]);

    // Now Playing has a fixed line budget (title + artists + album + bar + state),
    // so cap its height and let Queue absorb the rest of the column.
    let right_rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(10), Constraint::Min(0)])
        .split(cols[2]);

    render_library(f, cols[0], app);
    render_listing(f, mid_rows[0], app);
    render_search_results(f, mid_rows[1], app);
    render_search_input(f, mid_rows[2], app);
    render_now_playing(f, right_rows[0], app);
    render_queue(f, right_rows[1], app);
    render_status(f, status_area, app);

    if !matches!(app.overlay, Overlay::None) {
        render_overlay(f, main, app);
    }
}

fn render_overlay(f: &mut Frame, area: Rect, app: &mut App) {
    let popup = centered_rect(60, 60, area);
    f.render_widget(Clear, popup);
    match &mut app.overlay {
        Overlay::None => {}
        Overlay::Help => render_help(f, popup),
        Overlay::Devices { devices, state, loading } => {
            render_devices(f, popup, devices, state, *loading);
        }
    }
}

fn render_devices(
    f: &mut Frame,
    area: Rect,
    devices: &[crate::spotify::DeviceRef],
    state: &mut ratatui::widgets::ListState,
    loading: bool,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(Span::styled(
            " Devices — ↑/↓ choose, enter transfer, esc cancel ",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
    if loading {
        let p = Paragraph::new("Fetching devices…")
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        f.render_widget(p, area);
        return;
    }
    if devices.is_empty() {
        let p = Paragraph::new("No Spotify Connect devices visible. Open Spotify on a device.")
            .block(block)
            .style(Style::default().fg(Color::DarkGray))
            .wrap(Wrap { trim: true });
        f.render_widget(p, area);
        return;
    }
    let items: Vec<ListItem> = devices
        .iter()
        .map(|d| {
            let active = if d.is_active { "● " } else { "  " };
            let vol = d
                .volume_percent
                .map(|v| format!("  vol {v}%"))
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                Span::styled(active, Style::default().fg(Color::Green)),
                Span::styled(
                    d.name.clone(),
                    Style::default()
                        .fg(Color::Reset)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("  ({})", d.kind), Style::default().fg(Color::Gray)),
                Span::styled(vol, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(Color::Cyan)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, state);
}

fn render_help(f: &mut Frame, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(Span::styled(
            " Help — esc / ? to close ",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));

    let key = Style::default()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);
    let dim = Style::default().fg(Color::DarkGray);
    let body = vec![
        Line::from(Span::styled("Global", dim)),
        kb("ctrl-c", "quit", key),
        kb("space", "play / pause", key),
        kb("n / p", "next / previous track", key),
        kb("[ / ] or ←/→", "seek -5s / +5s", key),
        kb("+ / -", "volume +5 / -5", key),
        kb("R", "reload library", key),
        kb("d", "device picker", key),
        kb("?", "this help", key),
        kb("tab / shift-tab", "cycle panes", key),
        kb("1-5", "jump to pane", key),
        Line::from(""),
        Line::from(Span::styled("Library", dim)),
        kb("↑/↓ or j/k", "move cursor", key),
        kb("shift+↑/↓ or J/K", "move cursor by 10", key),
        kb("enter", "open playlist into Listing", key),
        kb("/", "focus search", key),
        Line::from(""),
        Line::from(Span::styled("Listing", dim)),
        kb("enter", "play track in playlist context", key),
        kb("q", "queue cursor track", key),
        kb("Q", "play cursor track now", key),
        kb("a", "add now-playing to this playlist", key),
        Line::from(""),
        Line::from(Span::styled("Search (input)", dim)),
        kb("type", "live query (180ms debounce)", key),
        kb("↓ / enter", "jump to results", key),
        kb("ctrl-a", "add cursor result to open playlist", key),
        kb("esc", "defocus pane", key),
        Line::from(""),
        Line::from(Span::styled("Search (results)", dim)),
        kb("enter", "play", key),
        kb("q / Q", "queue / play-now", key),
        kb("a", "add to open playlist", key),
        kb("/", "back to input", key),
    ];
    let p = Paragraph::new(body).block(block).wrap(Wrap { trim: true });
    f.render_widget(p, area);
}

fn kb(k: &str, desc: &str, key_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {k:<18}", k = k), key_style),
        Span::styled(desc.to_string(), Style::default().fg(Color::Reset)),
    ])
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(v[1])[1]
}

// ---------- Library ----------

fn render_library(f: &mut Frame, area: Rect, app: &mut App) {
    let focused = app.focus == Pane::Library;
    let title = if app.library_loading {
        "Library — loading…".to_string()
    } else {
        format!("Library ({})", app.playlists.len())
    };
    let block = pane_block(title, focused, 1);

    if app.library_loading && app.playlists.is_empty() {
        let p = Paragraph::new("Fetching playlists…")
            .block(block)
            .style(Style::default().fg(Color::DarkGray))
            .wrap(Wrap { trim: true });
        f.render_widget(p, area);
        return;
    }
    if app.playlists.is_empty() {
        let p = Paragraph::new("No playlists.")
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        f.render_widget(p, area);
        return;
    }

    // Subtract borders (2) and the `highlight_symbol` prefix width (2) — the
    // List widget reserves that left margin on every row to keep columns aligned
    // between selected and unselected rows.
    let inner_w = (area.width as usize).saturating_sub(2 + HIGHLIGHT_PREFIX_W);
    let count_w = 5usize;
    // 1 leading space between name and count.
    let name_w = inner_w.saturating_sub(count_w + 1).max(6);

    let me_name = app.me_name.clone();
    let me_ref = me_name.as_deref();

    let items: Vec<ListItem> = app
        .playlists
        .iter()
        .map(|p| {
            let owned_by_spotify = p.owner.eq_ignore_ascii_case("Spotify");
            let is_liked = p.id == crate::spotify::LIKED_PLAYLIST_ID;
            let is_self = me_ref
                .map(|me| me.eq_ignore_ascii_case(&p.owner))
                .unwrap_or(false);
            let name_style = if is_liked {
                Style::default().fg(Color::LightRed)
            } else if owned_by_spotify {
                Style::default().fg(Color::DarkGray)
            } else if is_self {
                Style::default().fg(Color::Reset)
            } else {
                Style::default().fg(owner_color(&p.owner))
            };
            let dim = Style::default().fg(Color::DarkGray);
            let name = pad(&p.name, name_w);
            let count = format!("{:>5}", p.track_count);
            let mut spans = vec![
                Span::styled(name, name_style),
                Span::raw(" "),
                Span::styled(count, dim),
            ];
            if owned_by_spotify {
                spans.push(Span::styled(" ⚠", Style::default().fg(Color::Yellow)));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(highlight_style(focused))
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, &mut app.library_state);
}

// ---------- Listing ----------

fn render_listing(f: &mut Frame, area: Rect, app: &mut App) {
    let focused = app.focus == Pane::Listing;
    // Pull the open playlist's metadata once so the title can show owner / date /
    // duration alongside the name. These come from `app.playlists` (loaded on
    // startup) and `total_duration_ms` / `min_added_at` (filled when we fetch
    // tracks for this playlist), so they appear after a brief load.
    let pl_meta = app
        .listing
        .as_ref()
        .and_then(|l| app.playlists.iter().find(|p| p.id == l.playlist_id));
    let owner = pl_meta.map(|p| p.owner.clone()).unwrap_or_default();
    let date = pl_meta
        .and_then(|p| p.min_added_at.as_deref())
        .and_then(|s| s.get(..7))
        .map(str::to_string);
    let duration = pl_meta.and_then(|p| p.total_duration_ms).map(fmt_long);
    let count = pl_meta.map(|p| p.track_count);
    let title = match app.listing.as_ref() {
        None => "Listing".to_string(),
        Some(l) if l.loading => format!("Listing — {} (loading…)", l.playlist_name),
        Some(l) => {
            let mut parts: Vec<String> = Vec::with_capacity(4);
            if owner.is_empty() {
                parts.push(l.playlist_name.clone());
            } else {
                parts.push(format!("{} — by {}", l.playlist_name, owner));
            }
            if let Some(c) = count {
                parts.push(format!("{c} tracks"));
            }
            if let Some(d) = duration {
                parts.push(d);
            }
            if let Some(d) = date {
                parts.push(format!("since {d}"));
            }
            parts.join(" · ")
        }
    };
    let block = pane_block(title, focused, 2);

    let Some(l) = app.listing.as_mut() else {
        let p = Paragraph::new("Open a playlist from Library (Enter).")
            .block(block)
            .style(Style::default().fg(Color::DarkGray))
            .wrap(Wrap { trim: true });
        f.render_widget(p, area);
        return;
    };
    if l.tracks.is_empty() {
        let p = Paragraph::new(if l.loading {
            "Loading tracks…"
        } else {
            "(empty)"
        })
        .block(block)
        .style(Style::default().fg(Color::DarkGray));
        f.render_widget(p, area);
        return;
    }

    // Columns: # | name (collapse) | artists | album | duration
    let inner_w = (area.width as usize).saturating_sub(2 + HIGHLIGHT_PREFIX_W);
    let num_w = 4usize;
    let dur_w = 6usize;
    let rest = inner_w.saturating_sub(num_w + dur_w + 3);
    // Fixed-ish budgets for artists/album so we don't constantly re-flow.
    let artists_w = (rest * 25 / 100).max(8);
    let album_w = (rest * 25 / 100).max(8);
    let name_w = rest.saturating_sub(artists_w + album_w);

    let now_playing_uri = app
        .playback
        .as_ref()
        .and_then(|p| p.track_uri.as_deref());

    let items: Vec<ListItem> = l
        .tracks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let is_now = now_playing_uri.map_or(false, |u| u == t.uri);
            let marker = if is_now { "▶" } else { " " };
            let num = format!("{:>2} ", i + 1);
            let name = pad(&t.name, name_w);
            let artists = pad(&t.artists, artists_w);
            let album = pad(&t.album, album_w);
            let dur = format!(" {:>5}", fmt_ms(t.duration_ms));
            let name_style = if is_now {
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Reset)
            };
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{marker} "),
                    Style::default().fg(Color::Green),
                ),
                Span::styled(num, Style::default().fg(Color::DarkGray)),
                Span::styled(name, name_style),
                Span::raw(" "),
                Span::styled(artists, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(album, Style::default().fg(Color::Gray)),
                Span::styled(dur, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(highlight_style(focused))
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, &mut l.state);
}

// ---------- Search ----------

fn render_search_results(f: &mut Frame, area: Rect, app: &mut App) {
    let pane_focused = app.focus == Pane::Search;
    let results_focused = pane_focused && app.search.sub_focus == SearchSubFocus::Results;

    let title = if app.search.query.is_empty() {
        "Search Results".to_string()
    } else {
        format!("Search Results ({})", app.search.results.len())
    };
    let block = pane_block_colored(
        title,
        results_focused,
        pane_focused,
        Color::Magenta,
        5,
    );

    if app.search.results.is_empty() {
        let body = if app.search.query.trim().is_empty() {
            "type below (/ to focus input)"
        } else {
            "no results"
        };
        let p = Paragraph::new(body)
            .block(block)
            .style(Style::default().fg(Color::DarkGray))
            .wrap(Wrap { trim: true });
        f.render_widget(p, area);
        return;
    }

    let inner_w = (area.width as usize).saturating_sub(2 + HIGHLIGHT_PREFIX_W);
    let dur_w = 6usize;
    let rest = inner_w.saturating_sub(dur_w + 2);
    let artists_w = (rest * 28 / 100).max(6);
    let album_w = (rest * 25 / 100).max(6);
    let name_w = rest.saturating_sub(artists_w + album_w);

    let items: Vec<ListItem> = app
        .search
        .results
        .iter()
        .map(|t| {
            let name = pad(&t.name, name_w);
            let artists = pad(&t.artists, artists_w);
            let album = pad(&t.album, album_w);
            let dur = format!(" {:>5}", fmt_ms(t.duration_ms));
            ListItem::new(Line::from(vec![
                Span::styled(name, Style::default().fg(Color::Reset)),
                Span::raw(" "),
                Span::styled(artists, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(album, Style::default().fg(Color::Gray)),
                Span::styled(dur, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(if results_focused {
            Style::default()
                .bg(Color::Magenta)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().bg(Color::DarkGray).fg(Color::White)
        })
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, &mut app.search.state);
}

fn render_search_input(f: &mut Frame, area: Rect, app: &mut App) {
    let pane_focused = app.focus == Pane::Search;
    let input_focused = pane_focused && app.search.sub_focus == SearchSubFocus::Input;

    let title = "Search".to_string();
    let block = pane_block_colored(title, input_focused, pane_focused, Color::Magenta, 6);

    let inner = block.inner(area);
    f.render_widget(block, area);

    let cursor_glyph = if input_focused { "▌" } else { " " };
    let prompt_color = if input_focused {
        Color::Magenta
    } else {
        Color::DarkGray
    };
    let input_line = Line::from(vec![
        Span::styled("/ ", Style::default().fg(prompt_color)),
        Span::styled(
            app.search.query.clone(),
            Style::default()
                .fg(if input_focused { Color::Reset } else { Color::Gray })
                .add_modifier(if input_focused {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ),
        Span::styled(cursor_glyph.to_string(), Style::default().fg(Color::Magenta)),
    ]);
    f.render_widget(Paragraph::new(input_line), inner);
}

// ---------- Queue ----------

fn render_queue(f: &mut Frame, area: Rect, app: &mut App) {
    let focused = app.focus == Pane::Queue;
    let title = if app.queue.is_empty() {
        "Queue".to_string()
    } else {
        format!("Queue ({})", app.queue.len())
    };
    let block = pane_block(title, focused, 4);

    if app.queue.is_empty() {
        let p = Paragraph::new("Nothing queued.")
            .block(block)
            .style(Style::default().fg(Color::DarkGray));
        f.render_widget(p, area);
        return;
    }
    let inner_w = (area.width as usize).saturating_sub(2 + HIGHLIGHT_PREFIX_W);
    let dur_w = 6usize;
    let rest = inner_w.saturating_sub(dur_w + 1);
    let artists_w = (rest * 35 / 100).max(6);
    let name_w = rest.saturating_sub(artists_w);

    let items: Vec<ListItem> = app
        .queue
        .iter()
        .map(|t| {
            let name = pad(&t.name, name_w);
            let artists = pad(&t.artists, artists_w);
            let dur = format!(" {:>5}", fmt_ms(t.duration_ms));
            ListItem::new(Line::from(vec![
                Span::styled(name, Style::default().fg(Color::Reset)),
                Span::raw(" "),
                Span::styled(artists, Style::default().fg(Color::Cyan)),
                Span::styled(dur, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_style(highlight_style(focused))
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, &mut app.queue_state);
}

// ---------- Now Playing ----------

fn render_now_playing(f: &mut Frame, area: Rect, app: &App) {
    let block = pane_block(
        "Now Playing".to_string(),
        app.focus == Pane::NowPlaying,
        3,
    );
    let inner = block.inner(area);
    f.render_widget(block, area);

    let lines = match &app.playback {
        Some(p) => now_playing_lines(p),
        None => vec![Line::from(Span::styled(
            "Nothing is playing.",
            Style::default().fg(Color::DarkGray),
        ))],
    };
    let body = Paragraph::new(lines).wrap(Wrap { trim: true });
    f.render_widget(body, inner);
}

fn now_playing_lines(p: &Playback) -> Vec<Line<'static>> {
    let title = p.track.clone().unwrap_or_else(|| "—".to_string());
    let artists = p.artists.clone().unwrap_or_else(|| "—".to_string());
    let album = p.album.clone().unwrap_or_else(|| "—".to_string());
    let bar = progress_bar(p.progress_ms, p.duration_ms, 24);
    let state = if p.is_playing { "▶ playing" } else { "⏸ paused" };
    let vol = p
        .volume_percent
        .map(|v| format!("vol {v}%"))
        .unwrap_or_default();
    vec![
        Line::from(Span::styled(
            title,
            Style::default()
                .fg(Color::Reset)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(artists, Style::default().fg(Color::Cyan))),
        Line::from(Span::styled(album, Style::default().fg(Color::Gray))),
        Line::from(""),
        Line::from(bar),
        Line::from(vec![
            Span::styled(state, Style::default().fg(Color::Green)),
            Span::raw("   "),
            Span::styled(vol, Style::default().fg(Color::DarkGray)),
        ]),
    ]
}

fn progress_bar(progress_ms: Option<u64>, duration_ms: Option<u64>, width: usize) -> String {
    let p = progress_ms.unwrap_or(0);
    let d = duration_ms.unwrap_or(0).max(1);
    let filled = ((p as f64 / d as f64) * width as f64).round() as usize;
    let filled = filled.min(width);
    let mut s = String::with_capacity(width + 16);
    for i in 0..width {
        s.push(if i < filled { '█' } else { '░' });
    }
    s.push_str(&format!("  {}  /  {}", fmt_ms(p), fmt_ms(d as u64)));
    s
}

fn fmt_ms(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Compact "1h23m" / "47m" length for playlists.
fn fmt_long(ms: u64) -> String {
    let secs = ms / 1000;
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 0 {
        format!("{h}h{m:02}m")
    } else {
        format!("{m}m")
    }
}

// ---------- Status bar ----------

fn render_status(f: &mut Frame, area: Rect, app: &App) {
    let mode = match app.focus {
        Pane::Library => "library",
        Pane::Listing => "listing",
        Pane::Search => "search",
        Pane::Queue => "queue",
        Pane::NowPlaying => "now playing",
    };
    let default_help = match app.focus {
        Pane::Search => match app.search.sub_focus {
            SearchSubFocus::Input => "type to query • ↓/enter → results • esc unfocus • ctrl-a add",
            SearchSubFocus::Results => "enter play • q queue • Q play-now • a add to playlist • / back to input",
        },
        Pane::Library => "↑/↓ move • enter open • / search • R reload",
        Pane::Listing => "↑/↓ move • enter play • q queue • Q play-now • a add now-playing here",
        Pane::Queue => "↑/↓ move",
        Pane::NowPlaying => "space play/pause • n/p skip • ←/→ or [/] seek 5s • +/- volume",
    };
    let msg = app.status.as_deref().unwrap_or(default_help);
    let line = Line::from(vec![
        Span::styled(
            format!(" {mode} "),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(msg, Style::default().fg(Color::Gray)),
        Span::raw("    "),
        Span::styled("ctrl-c quit", Style::default().fg(Color::DarkGray)),
    ]);
    let p = Paragraph::new(line);
    f.render_widget(p, area);
}

// ---------- Helpers ----------

fn pane_block<'a>(title: String, focused: bool, idx: u8) -> Block<'a> {
    let title_text = format!(" {idx}  {title} ");
    let (border_style, title_style) = if focused {
        (
            Style::default().fg(Color::Cyan),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        (
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::Gray),
        )
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .title(Span::styled(title_text, title_style))
}

/// Variant for pairs of panes that share a logical focus (e.g. Search input + results).
/// `sub_focused` = this specific section owns sub-focus; `pane_focused` = the parent pane
/// is focused at all. Uses `accent` instead of cyan so the pair stands out from the
/// neighboring panes when active.
fn pane_block_colored<'a>(
    title: String,
    sub_focused: bool,
    pane_focused: bool,
    accent: Color,
    idx: u8,
) -> Block<'a> {
    let title_text = format!(" {idx}  {title} ");
    let (border_style, title_style) = if sub_focused {
        (
            Style::default().fg(accent),
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        )
    } else if pane_focused {
        // Pane is focused but this section isn't — dim accent so the pair still reads
        // as "active" but the cursor location is unambiguous.
        (
            Style::default().fg(accent).add_modifier(Modifier::DIM),
            Style::default().fg(accent),
        )
    } else {
        (
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::Gray),
        )
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(border_style)
        .title(Span::styled(title_text, title_style))
}

fn highlight_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .bg(Color::Cyan)
            .fg(Color::Black)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().bg(Color::DarkGray).fg(Color::White)
    }
}

/// Stable per-owner color so the user can scan the Library by who owns each playlist.
/// djb2 hash → fixed palette of bright colors that read well on dark terminals.
fn owner_color(owner: &str) -> Color {
    // Yellow and cyan removed per request (visually unappealing in this theme).
    const PALETTE: [Color; 4] = [
        Color::LightGreen,
        Color::LightMagenta,
        Color::LightBlue,
        Color::LightRed,
    ];
    let mut h: u32 = 5381;
    for b in owner.as_bytes() {
        h = h.wrapping_mul(33).wrapping_add(*b as u32);
    }
    PALETTE[(h as usize) % PALETTE.len()]
}

fn pad(s: &str, w: usize) -> String {
    if w == 0 {
        return String::new();
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.len() > w {
        if w <= 1 {
            return "…".to_string();
        }
        let mut out: String = chars[..w - 1].iter().collect();
        out.push('…');
        out
    } else {
        let mut out = s.to_string();
        let pad = w - chars.len();
        for _ in 0..pad {
            out.push(' ');
        }
        out
    }
}
