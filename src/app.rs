use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures::StreamExt;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::widgets::ListState;
use rspotify::AuthCodePkceSpotify;
use rspotify::clients::OAuthClient;
use tokio::sync::mpsc;
use tokio::time::interval;
use tracing::{debug, warn};


use crate::cache::Cache;
use crate::config::{self, Paths, Theme};
use crate::jam;
use crate::jam_net;
use crate::spotify::{self, DeviceRef};
use crate::ui;

pub enum Overlay {
    None,
    Devices {
        devices: Vec<DeviceRef>,
        state: ListState,
        loading: bool,
    },
    Help,
    Colors {
        /// Index into the slot list (0 = accent, 1 = success, 2 = warn, 3 = dim).
        slot: usize,
        /// Theme captured when the picker opened, restored on Esc.
        original: Theme,
    },
    Confirm {
        prompt: String,
        action: ConfirmAction,
    },
    Join {
        sub_focus: JoinField,
        host_input: String,
        code_input: String,
        discovered: Vec<DiscoveredJam>,
        discovered_state: ListState,
        /// Active mDNS browse. Held purely for its `Drop`, which stops the
        /// daemon's browse and aborts the relay task when the overlay closes.
        #[allow(dead_code)]
        browse_handle: Option<jam_net::BrowseHandle>,
    },
}

#[derive(Debug, Clone)]
pub struct DiscoveredJam {
    pub display_name: String,
    pub addr: String,
    /// mDNS fullname, used to match `ServiceRemoved` events to the right row.
    pub fullname: String,
}

#[derive(Debug, Clone)]
pub enum ConfirmAction {
    EndJam,
    KickParticipant {
        id: jam::ParticipantId,
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinField {
    Discovered,
    Host,
    Code,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Library,
    Listing,
    Search,
    NowPlaying,
    Queue,
    Jam,
}

impl Pane {
    fn next(self) -> Self {
        match self {
            Pane::Library => Pane::Listing,
            Pane::Listing => Pane::Search,
            Pane::Search => Pane::NowPlaying,
            Pane::NowPlaying => Pane::Queue,
            Pane::Queue => Pane::Jam,
            Pane::Jam => Pane::Library,
        }
    }
    fn prev(self) -> Self {
        match self {
            Pane::Library => Pane::Jam,
            Pane::Listing => Pane::Library,
            Pane::Search => Pane::Listing,
            Pane::NowPlaying => Pane::Search,
            Pane::Queue => Pane::NowPlaying,
            Pane::Jam => Pane::Queue,
        }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Playback {
    pub is_playing: bool,
    pub track: Option<String>,
    pub track_uri: Option<String>,
    pub album_art_url: Option<String>,
    pub artists: Option<String>,
    pub album: Option<String>,
    pub progress_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub device_id: Option<String>,
    pub volume_percent: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistRef {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub track_count: u32,
    #[serde(default)]
    pub snapshot_id: String,
    /// Earliest `added_at` of any track in the playlist; ISO 8601. Lazy.
    #[serde(default)]
    pub min_added_at: Option<String>,
    /// Sum of all track durations in ms. Lazy.
    #[serde(default)]
    pub total_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackRef {
    pub uri: String,
    pub name: String,
    pub artists: String,
    pub album: String,
    pub duration_ms: u64,
}

pub struct ListingState {
    pub playlist_id: String,
    pub playlist_name: String,
    pub tracks: Vec<TrackRef>,
    pub state: ListState,
    pub loading: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSubFocus {
    Input,
    Results,
}

pub struct SearchState {
    pub query: String,
    pub results: Vec<TrackRef>,
    pub state: ListState,
    pub seq: u64,
    pub last_applied_seq: u64,
    pub sub_focus: SearchSubFocus,
}

pub struct App {
    pub focus: Pane,
    pub last_focus: Pane,
    pub playback: Option<Playback>,
    pub status: Option<String>,
    pub should_quit: bool,

    pub playlists: Vec<PlaylistRef>,
    pub library_loading: bool,
    pub library_state: ListState,

    pub listing: Option<ListingState>,

    pub queue: Vec<jam::QueueEntry>,
    pub queue_state: ListState,

    pub search: SearchState,

    /// Current user's display_name (or id). Set once at startup. Used by the UI
    /// to render self-owned playlists in white vs the per-owner color palette.
    pub me_name: Option<String>,

    /// Current user's Spotify id (always the bare id, not display_name). Needed
    /// to build the `spotify:user:<id>:collection` context URI for Liked Songs.
    pub me_id: Option<String>,

    pub overlay: Overlay,

    pub theme: Theme,
    /// Full config kept around so the color picker can round-trip the file
    /// (preserving fields it doesn't manage, like `default_device`).
    pub cfg: config::Config,
    pub paths: Arc<Paths>,
    pub jam: jam::JamState,
}

impl App {
    fn new(cfg: config::Config, paths: Arc<Paths>) -> Self {
        let theme = Theme::from_config(&cfg.colors);
        Self {
            focus: Pane::Library,
            last_focus: Pane::Library,
            playback: None,
            status: None,
            should_quit: false,
            playlists: Vec::new(),
            library_loading: true,
            library_state: ListState::default(),
            listing: None,
            queue: Vec::new(),
            queue_state: ListState::default(),
            search: SearchState {
                query: String::new(),
                results: Vec::new(),
                state: ListState::default(),
                seq: 0,
                last_applied_seq: 0,
                sub_focus: SearchSubFocus::Input,
            },
            me_name: None,
            me_id: None,
            overlay: Overlay::None,
            theme,
            cfg,
            paths,
            jam: jam::JamState::Idle,
        }
    }

    pub fn library_cursor(&self) -> Option<usize> {
        self.library_state.selected()
    }
}

#[derive(Debug)]
pub enum Action {
    Key(KeyEvent),
    PlaybackUpdated(Option<Playback>),
    Resize,
    StatusFlash(String),
    PlaylistsLoaded(Vec<PlaylistRef>),
    PlaylistsError(String),
    TracksLoaded {
        playlist_id: String,
        tracks: Vec<TrackRef>,
        total: u32,
        min_added_at: Option<String>,
        /// First page of a streaming load — replace any cached tracks rather
        /// than append, and reset the cursor.
        is_first: bool,
        /// Last page — flip "missing tracks" status, etc. Loading flag flips
        /// to false on the first page, not the last.
        is_last: bool,
    },
    TracksError {
        playlist_id: String,
        error: String,
    },
    QueueUpdated(Vec<TrackRef>),
    SearchResults {
        seq: u64,
        results: Vec<TrackRef>,
    },
    SearchError {
        seq: u64,
        error: String,
    },
    DevicesLoaded(Vec<DeviceRef>),
    DevicesError(String),
    MeLoaded { display_name: String, id: String },

    // Jam — host side.
    JamHostStarted {
        code: String,
        bind_addr: std::net::SocketAddr,
        server_handle: tokio::task::JoinHandle<()>,
        advert: Option<jam_net::HostAdvert>,
    },
    JamHostStartFailed(String),
    /// A WebSocket peer cleared the code check; main loop assigns the id and
    /// pushes back `HostMsg::Joined` via the carried sender.
    JamClientConnecting {
        display_name: String,
        sender: mpsc::UnboundedSender<jam::HostMsg>,
    },
    JamParticipantDisconnected {
        id: jam::ParticipantId,
    },

    /// A connected client asked the host to queue a track. Main loop calls
    /// the Spotify queue API with the host's auth and acks back.
    JamHostQueueRequest {
        from: jam::ParticipantId,
        track: TrackRef,
    },

    // Jam — client side.
    JamClientJoined(jam_net::ClientConn),
    JamClientJoinFailed(String),
    JamClientParticipantsUpdated(Vec<jam::ParticipantPayload>),
    JamClientPlaybackUpdated(Option<Playback>),
    JamClientQueueUpdated(Vec<jam::QueueEntry>),
    JamClientQueueAck {
        uri: String,
        ok: bool,
        error: Option<String>,
    },
    JamClientKicked,
    JamClientEnded,
    JamClientLost(String),

    // Jam — mDNS discovery (only meaningful while the join overlay is open).
    JamMdnsDiscovered {
        display_name: String,
        addr: String,
        fullname: String,
    },
    JamMdnsLost {
        fullname: String,
    },
}

pub async fn run(
    spotify: AuthCodePkceSpotify,
    cfg: config::Config,
    paths: Paths,
    cache: Cache,
) -> Result<()> {
    enable_raw_mode().context("enable raw mode")?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run_inner(&mut terminal, spotify, cfg, paths, cache).await;

    disable_raw_mode().ok();
    execute!(terminal.backend_mut(), LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    result
}

async fn run_inner(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    spotify: AuthCodePkceSpotify,
    cfg: config::Config,
    paths: Paths,
    cache: Cache,
) -> Result<()> {
    let poll_ms = cfg.poll_ms;
    let paths = Arc::new(paths);
    let cache = Arc::new(cache);
    let (tx, mut rx) = mpsc::unbounded_channel::<Action>();

    let key_tx = tx.clone();
    tokio::spawn(async move {
        let mut events = EventStream::new();
        while let Some(Ok(ev)) = events.next().await {
            match ev {
                Event::Key(k) if k.kind == KeyEventKind::Press => {
                    let _ = key_tx.send(Action::Key(k));
                }
                Event::Resize(_, _) => {
                    let _ = key_tx.send(Action::Resize);
                }
                _ => {}
            }
        }
    });

    let poll_tx = tx.clone();
    let spotify_poll = spotify.clone();
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_millis(poll_ms));
        loop {
            tick.tick().await;
            match spotify::fetch_playback(&spotify_poll).await {
                Ok(p) => {
                    let _ = poll_tx.send(Action::PlaybackUpdated(p));
                }
                Err(e) => {
                    debug!("playback poll error: {e:?}");
                }
            }
        }
    });

    let queue_tx = tx.clone();
    let spotify_queue = spotify.clone();
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            match spotify::fetch_queue(&spotify_queue).await {
                Ok(q) => {
                    let _ = queue_tx.send(Action::QueueUpdated(q));
                }
                Err(e) => {
                    debug!("queue poll error: {e:?}");
                }
            }
        }
    });

    let mut app = App::new(cfg, paths);

    if let Some((age, cached)) = cache.load_playlists() {
        app.playlists = cached;
        app.library_loading = false;
        if !app.playlists.is_empty() {
            app.library_state.select(Some(0));
        }
        let mins = age.as_secs() / 60;
        app.status = Some(format!(
            "loaded {} playlists from cache ({}m old) — refreshing…",
            app.playlists.len(),
            mins
        ));
    }

    {
        let load_tx = tx.clone();
        let s = spotify.clone();
        let c = cache.clone();
        tokio::spawn(async move {
            match spotify::list_playlists(&s).await {
                Ok(ps) => {
                    if let Err(e) = c.save_playlists(&ps) {
                        tracing::warn!("playlist cache save: {e}");
                    }
                    let _ = load_tx.send(Action::PlaylistsLoaded(ps));
                }
                Err(e) => {
                    let _ = load_tx.send(Action::PlaylistsError(format!("{e}")));
                }
            }
        });
    }

    {
        let me_tx = tx.clone();
        let s = spotify.clone();
        tokio::spawn(async move {
            match spotify::fetch_me(&s).await {
                Ok(me) => {
                    let _ = me_tx.send(Action::MeLoaded {
                        display_name: me.display_name,
                        id: me.id,
                    });
                }
                Err(e) => tracing::debug!("me load: {e}"),
            }
        });
    }

    terminal.draw(|f| ui::render(f, &mut app))?;

    while let Some(action) = rx.recv().await {
        apply_action(&mut app, action, &spotify, &cache, &tx).await;
        if app.should_quit {
            break;
        }
        terminal.draw(|f| ui::render(f, &mut app))?;
    }

    Ok(())
}

async fn apply_action(
    app: &mut App,
    action: Action,
    spotify: &AuthCodePkceSpotify,
    cache: &Arc<Cache>,
    tx: &mpsc::UnboundedSender<Action>,
) {
    match action {
        Action::Key(k) => handle_key(app, k, spotify, cache, tx).await,
        Action::Resize => {}
        Action::PlaybackUpdated(p) => {
            // While joined as a client we mirror the host's playback rather
            // than our own; the local poller keeps running but its results
            // are dropped here.
            if !matches!(app.jam, jam::JamState::Client(_)) {
                app.playback = p.clone();
                if let jam::JamState::Host(h) = &app.jam {
                    let msg = jam::HostMsg::PlaybackUpdated { playback: p };
                    for tx in h.senders.values() {
                        let _ = tx.send(msg.clone());
                    }
                }
            }
        }
        Action::StatusFlash(s) => {
            app.status = Some(s);
        }
        Action::PlaylistsLoaded(mut ps) => {
            use std::collections::HashMap;
            let prior: HashMap<String, (Option<String>, Option<u64>)> = app
                .playlists
                .iter()
                .map(|p| (p.id.clone(), (p.min_added_at.clone(), p.total_duration_ms)))
                .collect();
            for p in ps.iter_mut() {
                if let Some((min_added, dur)) = prior.get(&p.id) {
                    if p.min_added_at.is_none() {
                        p.min_added_at = min_added.clone();
                    }
                    if p.total_duration_ms.is_none() {
                        p.total_duration_ms = *dur;
                    }
                }
            }
            app.library_loading = false;
            app.playlists = ps;
            if !app.playlists.is_empty() && app.library_state.selected().is_none() {
                app.library_state.select(Some(0));
            }
        }
        Action::PlaylistsError(e) => {
            app.library_loading = false;
            app.status = Some(format!("playlist load: {e}"));
        }
        Action::TracksLoaded {
            playlist_id,
            tracks,
            total,
            min_added_at,
            is_first,
            is_last,
        } => {
            // Apply the page to the open listing if it still matches.
            if let Some(l) = app.listing.as_mut() {
                if l.playlist_id == playlist_id {
                    let prior_cursor = l.state.selected();
                    if is_first {
                        l.tracks = tracks;
                        l.loading = false;
                        if l.tracks.is_empty() {
                            l.state.select(None);
                        } else {
                            let cur = prior_cursor.unwrap_or(0).min(l.tracks.len() - 1);
                            l.state.select(Some(cur));
                        }
                    } else {
                        l.tracks.extend(tracks);
                    }
                    if is_last {
                        let missing = (total as usize).saturating_sub(l.tracks.len());
                        if missing > 0 {
                            app.status = Some(format!(
                                "loaded {} tracks; {} skipped (likely local/regional)",
                                l.tracks.len(),
                                missing
                            ));
                        }
                    }
                }
            }

            // Persist playlist stats only on the final page (we have the
            // complete set then). Skip the synthetic Liked Songs entry —
            // it isn't a real cached playlist.
            if is_last && playlist_id != spotify::LIKED_PLAYLIST_ID {
                if let Some(l) = app.listing.as_ref() {
                    if l.playlist_id == playlist_id {
                        let total_duration_ms: u64 =
                            l.tracks.iter().map(|t| t.duration_ms).sum();
                        let mut updated = false;
                        for p in app.playlists.iter_mut() {
                            if p.id == playlist_id {
                                if min_added_at.is_some() {
                                    p.min_added_at = min_added_at.clone();
                                }
                                p.total_duration_ms = Some(total_duration_ms);
                                updated = true;
                                break;
                            }
                        }
                        if updated {
                            if let Err(e) = cache.save_playlists(&app.playlists) {
                                tracing::warn!("playlist stats persist: {e}");
                            }
                        }
                    }
                }
            }
        }
        Action::TracksError { playlist_id, error } => {
            if let Some(l) = app.listing.as_mut() {
                if l.playlist_id == playlist_id {
                    l.loading = false;
                }
            }
            let pl = app.playlists.iter().find(|p| p.id == playlist_id);
            let owner = pl.map(|p| p.owner.as_str()).unwrap_or("?");
            let name = pl.map(|p| p.name.as_str()).unwrap_or("?");
            let hint = if error.contains("403") {
                if owner.eq_ignore_ascii_case("Spotify") {
                    "  → Spotify-owned playlist; blocked in Development Mode"
                } else {
                    "  → 403 on your own playlist usually means User Management lists the wrong email"
                }
            } else {
                ""
            };
            app.status = Some(format!(
                "tracks load \"{name}\" (owner: {owner}): {error}{hint}"
            ));
        }
        Action::QueueUpdated(q) => {
            // Same mirror rule as PlaybackUpdated: ignore the client's local
            // poller while joined.
            if matches!(app.jam, jam::JamState::Client(_)) {
                return;
            }
            // Host attributes via the ledger and broadcasts in one step.
            // Idle just wraps with `submitter: None`.
            let entries: Vec<jam::QueueEntry> = if let jam::JamState::Host(h) = &mut app.jam {
                h.attribute_and_broadcast_queue(q)
            } else {
                q.into_iter()
                    .map(|t| jam::QueueEntry {
                        track: t,
                        submitter: None,
                    })
                    .collect()
            };
            apply_queue_update(app, entries);
        }
        Action::SearchResults { seq, results } => {
            if seq >= app.search.last_applied_seq {
                app.search.last_applied_seq = seq;
                let prior = app.search.state.selected();
                app.search.results = results;
                if app.search.results.is_empty() {
                    app.search.state.select(None);
                } else {
                    let cur = prior.unwrap_or(0).min(app.search.results.len() - 1);
                    app.search.state.select(Some(cur));
                }
            }
        }
        Action::SearchError { seq, error } => {
            if seq >= app.search.last_applied_seq {
                app.status = Some(format!("search: {error}"));
            }
        }
        Action::DevicesLoaded(devs) => {
            if let Overlay::Devices {
                devices,
                state,
                loading,
            } = &mut app.overlay
            {
                *devices = devs;
                *loading = false;
                if !devices.is_empty() {
                    let active = devices.iter().position(|d| d.is_active).unwrap_or(0);
                    state.select(Some(active));
                }
            }
        }
        Action::DevicesError(e) => {
            if let Overlay::Devices { loading, .. } = &mut app.overlay {
                *loading = false;
            }
            app.status = Some(format!("devices: {e}"));
        }
        Action::MeLoaded { display_name, id } => {
            app.me_name = Some(display_name);
            app.me_id = Some(id);
        }

        // ---- Jam (host) ----
        Action::JamHostStarted {
            code,
            bind_addr,
            server_handle,
            advert,
        } => {
            let host_name = app
                .me_name
                .clone()
                .unwrap_or_else(|| "host".to_string());
            app.jam = jam::JamState::Host(jam::HostState::new(
                code.clone(),
                bind_addr,
                host_name,
                server_handle,
                advert,
            ));
            app.status = Some(format!("jam started — code {code}"));
        }
        Action::JamHostStartFailed(e) => {
            // Don't clobber the status of a successful concurrent start —
            // e.g. user double-pressed shift-S, first task bound the port and
            // we're already Host(...), the second task's bind error arrives
            // late and would otherwise stomp the "jam started" flash.
            if matches!(app.jam, jam::JamState::Idle) {
                app.status = Some(format!("start jam: {e}"));
            }
        }
        Action::JamClientConnecting {
            display_name,
            sender,
        } => {
            if let jam::JamState::Host(h) = &mut app.jam {
                let id = h.next_id;
                h.next_id += 1;
                let color = jam::color_at_idx(jam::idx_for_join_order(h.participants.len()));
                let participant = jam::Participant {
                    id,
                    display_name: display_name.clone(),
                    color,
                    is_host: false,
                    is_self: false,
                };
                h.participants.push(participant);
                h.senders.insert(id, sender.clone());
                let host_name = app
                    .me_name
                    .clone()
                    .unwrap_or_else(|| "host".to_string());
                let _ = sender.send(jam::HostMsg::Joined {
                    id,
                    host_name,
                    participants: h.participants_payload(),
                });
                h.broadcast_participants();
                // Bootstrap the new client's mirror — they shouldn't have to
                // wait up to 5s for the host's queue poll to fire.
                let _ = sender.send(jam::HostMsg::PlaybackUpdated {
                    playback: app.playback.clone(),
                });
                let _ = sender.send(jam::HostMsg::QueueUpdated {
                    queue: app.queue.clone(),
                });
                app.status = Some(format!("{display_name} joined"));
            } else {
                let _ = sender.send(jam::HostMsg::Rejected {
                    reason: "host is no longer accepting".into(),
                });
            }
        }
        Action::JamParticipantDisconnected { id } => {
            if let jam::JamState::Host(h) = &mut app.jam {
                h.senders.remove(&id);
                if let Some(name) = h.remove_participant(id) {
                    h.broadcast_participants();
                    app.status = Some(format!("{name} left"));
                }
                // Otherwise the participant was already removed via kick — silent.
            }
        }
        Action::JamHostQueueRequest { from, track } => {
            if let jam::JamState::Host(h) = &mut app.jam {
                h.record_queue_request(track.uri.clone(), from);
                let from_name = h
                    .participants
                    .iter()
                    .find(|p| p.id == from)
                    .map(|p| p.display_name.clone())
                    .unwrap_or_default();
                let sender = h.senders.get(&from).cloned();
                let device_id = app
                    .playback
                    .as_ref()
                    .and_then(|p| p.device_id.clone());
                let s = spotify.clone();
                let tx_inner = tx.clone();
                let track_uri = track.uri.clone();
                let track_name = track.name.clone();
                tokio::spawn(async move {
                    let result =
                        spotify::add_to_queue(&s, &track_uri, device_id.as_deref()).await;
                    let (ok, error) = match &result {
                        Ok(_) => (true, None),
                        Err(e) => (false, Some(format!("{e}"))),
                    };
                    if let Some(sender) = sender {
                        let _ = sender.send(jam::HostMsg::QueueAck {
                            uri: track_uri,
                            ok,
                            error: error.clone(),
                        });
                    }
                    let msg = if ok {
                        format!("{from_name} queued {track_name}")
                    } else {
                        format!(
                            "{from_name}'s queue failed: {}",
                            error.unwrap_or_default()
                        )
                    };
                    let _ = tx_inner.send(Action::StatusFlash(msg));
                    // Refresh the queue immediately so attribution +
                    // mirroring propagate within ~1s instead of waiting for
                    // the next 5s host poll.
                    if ok {
                        if let Ok(q) = spotify::fetch_queue(&s).await {
                            let _ = tx_inner.send(Action::QueueUpdated(q));
                        }
                    }
                });
            }
        }

        // ---- Jam (client) ----
        Action::JamClientJoined(conn) => {
            let participants: Vec<jam::Participant> = conn
                .participants
                .into_iter()
                .map(|p| p.into_participant(conn.my_id))
                .collect();
            app.jam = jam::JamState::Client(jam::ClientState::new(
                conn.host_addr,
                conn.host_name,
                conn.code,
                conn.my_id,
                participants,
                conn.outbound,
                conn.handle,
            ));
            app.status = Some("joined jam".to_string());
        }
        Action::JamClientJoinFailed(e) => {
            // Same rationale as JamHostStartFailed.
            if matches!(app.jam, jam::JamState::Idle) {
                app.status = Some(format!("join: {e}"));
            }
        }
        Action::JamClientPlaybackUpdated(p) => {
            if matches!(app.jam, jam::JamState::Client(_)) {
                app.playback = p;
            }
        }
        Action::JamClientQueueUpdated(q) => {
            if matches!(app.jam, jam::JamState::Client(_)) {
                apply_queue_update(app, q);
            }
        }
        Action::JamClientQueueAck { uri, ok, error } => {
            let name = if let jam::JamState::Client(c) = &mut app.jam {
                c.pending_queue.remove(&uri).unwrap_or_else(|| uri.clone())
            } else {
                uri
            };
            if ok {
                app.status = Some(format!("✓ queued: {name}"));
            } else {
                app.status = Some(format!(
                    "✗ queue rejected: {name} ({})",
                    error.unwrap_or_else(|| "unknown".into())
                ));
            }
        }
        Action::JamClientParticipantsUpdated(payload) => {
            if let jam::JamState::Client(c) = &mut app.jam {
                c.participants = payload
                    .into_iter()
                    .map(|p| p.into_participant(c.my_id))
                    .collect();
                if c.participants.is_empty() {
                    c.pane_state.select(None);
                } else if let Some(cur) = c.pane_state.selected() {
                    if cur >= c.participants.len() {
                        c.pane_state.select(Some(c.participants.len() - 1));
                    }
                }
            }
        }
        Action::JamClientKicked => {
            app.jam = jam::JamState::Idle;
            app.status = Some("kicked from the jam".to_string());
        }
        Action::JamClientEnded => {
            app.jam = jam::JamState::Idle;
            app.status = Some("host ended the jam".to_string());
        }
        Action::JamClientLost(e) => {
            if matches!(app.jam, jam::JamState::Client(_)) {
                app.jam = jam::JamState::Idle;
                app.status = Some(format!("jam: {e}"));
            }
        }

        Action::JamMdnsDiscovered {
            display_name,
            addr,
            fullname,
        } => {
            if let Overlay::Join {
                discovered,
                discovered_state,
                ..
            } = &mut app.overlay
            {
                if let Some(existing) =
                    discovered.iter_mut().find(|d| d.fullname == fullname)
                {
                    existing.display_name = display_name;
                    existing.addr = addr;
                } else {
                    discovered.push(DiscoveredJam {
                        display_name,
                        addr,
                        fullname,
                    });
                    if discovered_state.selected().is_none() {
                        discovered_state.select(Some(0));
                    }
                }
            }
        }
        Action::JamMdnsLost { fullname } => {
            if let Overlay::Join {
                discovered,
                discovered_state,
                ..
            } = &mut app.overlay
            {
                if let Some(idx) = discovered.iter().position(|d| d.fullname == fullname)
                {
                    discovered.remove(idx);
                    if discovered.is_empty() {
                        discovered_state.select(None);
                    } else if let Some(cur) = discovered_state.selected() {
                        if cur >= discovered.len() {
                            discovered_state.select(Some(discovered.len() - 1));
                        }
                    }
                }
            }
        }
    }
}

fn apply_queue_update(app: &mut App, q: Vec<jam::QueueEntry>) {
    app.queue = q;
    if app.queue.is_empty() {
        app.queue_state.select(None);
    } else if let Some(cur) = app.queue_state.selected() {
        if cur >= app.queue.len() {
            app.queue_state.select(Some(app.queue.len() - 1));
        }
    } else {
        app.queue_state.select(Some(0));
    }
}

// ---------- Key handling ----------

async fn handle_key(
    app: &mut App,
    key: KeyEvent,
    spotify: &AuthCodePkceSpotify,
    cache: &Arc<Cache>,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    if matches!(key.code, Char('c')) && ctrl {
        app.should_quit = true;
        return;
    }

    // Overlays grab input first.
    if !matches!(app.overlay, Overlay::None) {
        handle_overlay_key(app, key, spotify, tx);
        return;
    }

    if app.focus == Pane::Search {
        handle_search_key(app, key, spotify, tx);
        return;
    }

    match (key.code, ctrl) {
        (Char(' '), false) => {
            let _ = toggle_play(app, spotify, tx).await;
        }
        (Char('/'), false) => focus_search(app),
        (Char('q'), false) => queue_listing_cursor(app, spotify, tx),
        (Char('Q'), false) => play_listing_cursor_now(app, spotify, tx),
        (Tab, _) => app.focus = app.focus.next(),
        (BackTab, _) => app.focus = app.focus.prev(),
        (Char('1'), false) => focus_pane(app, Pane::Library),
        (Char('2'), false) => focus_pane(app, Pane::Listing),
        (Char('3'), false) => focus_pane(app, Pane::NowPlaying),
        (Char('4'), false) => focus_pane(app, Pane::Queue),
        (Char('5'), false) => focus_pane(app, Pane::Search),
        (Char('7'), false) => focus_pane(app, Pane::Jam),
        (Char('J'), false) if app.focus == Pane::Jam && matches!(app.jam, jam::JamState::Idle) => {
            open_join_overlay(app, tx);
        }
        (Char('J'), false) => move_cursor(app, 10),
        (Char('K'), false) => move_cursor(app, -10),
        (Down, _) if shift => move_cursor(app, 10),
        (Up, _) if shift => move_cursor(app, -10),
        (Char('j'), false) | (Down, _) => move_cursor(app, 1),
        (Char('k'), false) | (Up, _) => move_cursor(app, -1),
        (Char('g'), false) => move_cursor_to(app, 0),
        (Char('G'), false) => move_cursor_to_end(app),
        (Char('a'), false) => add_to_open_playlist(app, spotify, tx),
        (Char('R'), false) => trigger_reload(app, spotify, cache, tx),
        (Char('n'), false) => skip_track(app, spotify, tx, true),
        (Char('p'), false) => skip_track(app, spotify, tx, false),
        (Char('+'), false) | (Char('='), false) => adjust_volume(app, spotify, tx, 5),
        (Char('-'), false) => adjust_volume(app, spotify, tx, -5),
        (Char('['), false) => seek_relative(app, spotify, tx, -5_000),
        (Char(']'), false) => seek_relative(app, spotify, tx, 5_000),
        (Char('d'), false) => open_devices_overlay(app, spotify, tx),
        (Char('C'), false) => open_colors_overlay(app),
        (Char('?'), false) => app.overlay = Overlay::Help,
        (Char('S'), false) if app.focus == Pane::Jam => {
            if matches!(app.jam, jam::JamState::Idle) {
                start_jam_host(app, tx);
            }
        }
        (Char('E'), false) if app.focus == Pane::Jam => match &app.jam {
            jam::JamState::Host(_) => open_end_jam_confirm(app),
            jam::JamState::Client(_) => leave_jam(app),
            jam::JamState::Idle => {}
        },
        (Char('X'), false) if app.focus == Pane::Jam => {
            if matches!(app.jam, jam::JamState::Host(_)) {
                open_kick_confirm(app);
            }
        }
        // ←/→ scrubbing while Now Playing is focused (no cursor to fight with).
        (Left, _) if app.focus == Pane::NowPlaying => {
            seek_relative(app, spotify, tx, -5_000)
        }
        (Right, _) if app.focus == Pane::NowPlaying => {
            seek_relative(app, spotify, tx, 5_000)
        }
        (Enter, _) => activate(app, spotify, cache, tx).await,
        _ => {}
    }
}

fn queue_listing_cursor(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(l) = app.listing.as_ref() else {
        app.status = Some("nothing to queue (open a playlist first)".to_string());
        return;
    };
    let Some(idx) = l.state.selected() else { return };
    let Some(track) = l.tracks.get(idx).cloned() else { return };
    queue_track(app, spotify, tx, track);
}

fn queue_search_selection(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(idx) = app.search.state.selected() else { return };
    let Some(track) = app.search.results.get(idx).cloned() else { return };
    queue_track(app, spotify, tx, track);
}

fn queue_track(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
    track: TrackRef,
) {
    // In a jam, queue requests get forwarded to the host instead of touching
    // the local Spotify account. Host calls the Spotify queue API with its own
    // auth and sends a `QueueAck` back.
    if let jam::JamState::Client(c) = &mut app.jam {
        c.pending_queue.insert(track.uri.clone(), track.name.clone());
        let _ = c.outbound.send(jam::ClientMsg::Queue { track: track.clone() });
        app.status = Some(format!("→ host: queue {}", track.name));
        return;
    }
    // Host's own queueing: tag the ledger so the next queue poll attributes
    // this row to the host (id 0).
    if let jam::JamState::Host(h) = &mut app.jam {
        h.record_queue_request(track.uri.clone(), 0);
    }
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let s = spotify.clone();
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match spotify::add_to_queue(&s, &track.uri, device_id.as_deref()).await {
            Ok(_) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("queued: {}", track.name)));
                let s2 = s.clone();
                let tx2 = tx_inner.clone();
                tokio::spawn(async move {
                    if let Ok(q) = spotify::fetch_queue(&s2).await {
                        let _ = tx2.send(Action::QueueUpdated(q));
                    }
                });
            }
            Err(e) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("queue: {e}")));
            }
        }
    });
}

/// Returns true (and flashes a status) if `app` is currently a jam client and
/// shouldn't be running playback-mutating actions locally. Use as a guard at
/// the top of any function that calls Spotify play / pause / seek / volume /
/// skip — those are host-only in jam mode.
fn host_only_blocked(app: &mut App) -> bool {
    if matches!(app.jam, jam::JamState::Client(_)) {
        app.status =
            Some("host-only — joined clients can only queue (q)".to_string());
        true
    } else {
        false
    }
}

fn play_listing_cursor_now(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(l) = app.listing.as_ref() else {
        app.status = Some("nothing to play (open a playlist first)".to_string());
        return;
    };
    let Some(idx) = l.state.selected() else { return };
    let Some(track) = l.tracks.get(idx).cloned() else { return };
    play_now(app, spotify, tx, track);
}

fn play_search_selection_now(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(idx) = app.search.state.selected() else { return };
    let Some(track) = app.search.results.get(idx).cloned() else { return };
    play_now(app, spotify, tx, track);
}

fn play_now(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
    track: TrackRef,
) {
    if host_only_blocked(app) {
        return;
    }
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let s = spotify.clone();
    let tx_inner = tx.clone();
    let name = track.name.clone();
    tokio::spawn(async move {
        match spotify::play_uris(&s, &[track.uri.clone()], device_id.as_deref()).await {
            Ok(_) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("▶ now: {name}")));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("play: {e}")));
            }
        }
    });
}

fn open_devices_overlay(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    app.overlay = Overlay::Devices {
        devices: Vec::new(),
        state: ListState::default(),
        loading: true,
    };
    let s = spotify.clone();
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match spotify::list_devices(&s).await {
            Ok(devs) => {
                let _ = tx_inner.send(Action::DevicesLoaded(devs));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::DevicesError(format!("{e}")));
            }
        }
    });
}

fn open_colors_overlay(app: &mut App) {
    app.overlay = Overlay::Colors {
        slot: 0,
        original: app.theme,
    };
}

fn handle_colors_overlay_key(app: &mut App, key: KeyEvent) {
    use KeyCode::*;
    let Overlay::Colors { slot, original } = &mut app.overlay else {
        return;
    };
    match key.code {
        Esc => {
            // Revert to the theme captured when the picker opened.
            app.theme = *original;
            app.overlay = Overlay::None;
        }
        Up | Char('k') => {
            *slot = if *slot == 0 { ui::NUM_SLOTS - 1 } else { *slot - 1 };
        }
        Down | Char('j') => {
            *slot = (*slot + 1) % ui::NUM_SLOTS;
        }
        Left | Char('h') => cycle_color(app, -1),
        Right | Char('l') => cycle_color(app, 1),
        Enter => {
            // Persist the new theme to config.toml. Other overlay events have
            // already mutated app.theme via the cycle.
            app.cfg.colors = app.theme.to_config();
            match config::write_config(&app.paths, &app.cfg) {
                Ok(_) => {
                    app.status = Some("colors saved".to_string());
                }
                Err(e) => {
                    app.status = Some(format!("colors save: {e}"));
                }
            }
            app.overlay = Overlay::None;
        }
        _ => {}
    }
}

fn handle_confirm_overlay_key(app: &mut App, key: KeyEvent) {
    use KeyCode::*;
    let action = match &app.overlay {
        Overlay::Confirm { action, .. } => action.clone(),
        _ => return,
    };
    match key.code {
        Enter | Char('y') | Char('Y') => {
            execute_confirm(app, action);
            app.overlay = Overlay::None;
        }
        Esc | Char('n') | Char('N') => {
            app.overlay = Overlay::None;
        }
        _ => {}
    }
}

fn execute_confirm(app: &mut App, action: ConfirmAction) {
    match action {
        ConfirmAction::EndJam => {
            if let jam::JamState::Host(h) = &mut app.jam {
                // Notify each connected client first so they can flash a status
                // message before their connection drops.
                for tx in h.senders.values() {
                    let _ = tx.send(jam::HostMsg::JamEnded);
                }
                h.senders.clear();
            }
            // HostState's Drop aborts the accept loop; per-client tasks see
            // their channels close and exit.
            app.jam = jam::JamState::Idle;
            app.status = Some("jam ended".to_string());
        }
        ConfirmAction::KickParticipant { id, name } => {
            if let jam::JamState::Host(h) = &mut app.jam {
                if let Some(tx) = h.senders.remove(&id) {
                    let _ = tx.send(jam::HostMsg::Kicked);
                    // tx drops at end of scope — per-client task exits after
                    // forwarding the Kicked frame.
                }
                if h.remove_participant(id).is_some() {
                    h.broadcast_participants();
                    app.status = Some(format!("kicked {name}"));
                }
            }
        }
    }
}

// ---------- Jam ----------

fn start_jam_host(app: &mut App, tx: &mpsc::UnboundedSender<Action>) {
    let code = jam::generate_code();
    let host_name = app
        .me_name
        .clone()
        .unwrap_or_else(|| "host".to_string());
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match jam_net::start_server(code.clone(), host_name, tx_inner.clone()).await {
            Ok(start) => {
                let _ = tx_inner.send(Action::JamHostStarted {
                    code,
                    bind_addr: start.bind_addr,
                    server_handle: start.server_handle,
                    advert: start.advert,
                });
            }
            Err(e) => {
                let _ = tx_inner.send(Action::JamHostStartFailed(format!("{e:#}")));
            }
        }
    });
    app.status = Some("starting jam server…".to_string());
}

fn leave_jam(app: &mut App) {
    if let jam::JamState::Client(c) = &app.jam {
        let _ = c.outbound.send(jam::ClientMsg::Leave);
    }
    app.jam = jam::JamState::Idle;
    app.status = Some("left jam".to_string());
}

fn open_end_jam_confirm(app: &mut App) {
    let prompt = match &app.jam {
        jam::JamState::Host(h) => {
            let others = h.participants.len().saturating_sub(1);
            if others == 0 {
                "End jam?".to_string()
            } else {
                let s = if others == 1 { "" } else { "s" };
                format!("End jam? {others} participant{s} will be disconnected.")
            }
        }
        _ => return,
    };
    app.overlay = Overlay::Confirm {
        prompt,
        action: ConfirmAction::EndJam,
    };
}

fn open_join_overlay(app: &mut App, tx: &mpsc::UnboundedSender<Action>) {
    let browse_handle = jam_net::start_browse(tx.clone());
    app.overlay = Overlay::Join {
        sub_focus: JoinField::Host,
        host_input: String::new(),
        code_input: String::new(),
        discovered: Vec::new(),
        discovered_state: ListState::default(),
        browse_handle,
    };
}

fn handle_join_overlay_key(
    app: &mut App,
    key: KeyEvent,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;
    let Overlay::Join {
        sub_focus,
        host_input,
        code_input,
        discovered,
        discovered_state,
        ..
    } = &mut app.overlay
    else {
        return;
    };
    match key.code {
        Esc => {
            app.overlay = Overlay::None;
        }
        Tab => {
            *sub_focus = next_join_field(*sub_focus, discovered.is_empty());
        }
        BackTab => {
            *sub_focus = prev_join_field(*sub_focus, discovered.is_empty());
        }
        Up if matches!(sub_focus, JoinField::Discovered) => {
            step_state(discovered_state, discovered.len(), -1);
        }
        Down if matches!(sub_focus, JoinField::Discovered) => {
            step_state(discovered_state, discovered.len(), 1);
        }
        Enter => match sub_focus {
            JoinField::Discovered => {
                if let Some(idx) = discovered_state.selected() {
                    if let Some(d) = discovered.get(idx) {
                        *host_input = d.addr.clone();
                        *sub_focus = JoinField::Code;
                    }
                }
            }
            _ => {
                let host = host_input.trim().to_string();
                let code = code_input.trim().to_string();
                if host.is_empty() || code.is_empty() {
                    app.status = Some("host and code required".to_string());
                    return;
                }
                app.overlay = Overlay::None;
                execute_join(app, host, code, tx);
            }
        },
        Backspace => match sub_focus {
            JoinField::Host => {
                host_input.pop();
            }
            JoinField::Code => {
                code_input.pop();
            }
            JoinField::Discovered => {}
        },
        Char(c) => match sub_focus {
            JoinField::Host => host_input.push(c),
            JoinField::Code => code_input.push(c),
            JoinField::Discovered => {}
        },
        _ => {}
    }
}

fn next_join_field(cur: JoinField, no_discovered: bool) -> JoinField {
    match cur {
        JoinField::Host => JoinField::Code,
        JoinField::Code => {
            if no_discovered {
                JoinField::Host
            } else {
                JoinField::Discovered
            }
        }
        JoinField::Discovered => JoinField::Host,
    }
}

fn prev_join_field(cur: JoinField, no_discovered: bool) -> JoinField {
    match cur {
        JoinField::Host => {
            if no_discovered {
                JoinField::Code
            } else {
                JoinField::Discovered
            }
        }
        JoinField::Code => JoinField::Host,
        JoinField::Discovered => JoinField::Code,
    }
}

fn execute_join(
    app: &mut App,
    host_addr: String,
    code: String,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let my_name = app
        .me_name
        .clone()
        .unwrap_or_else(|| "guest".to_string());
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match jam_net::connect_client(host_addr, code, my_name, tx_inner.clone()).await {
            Ok(conn) => {
                let _ = tx_inner.send(Action::JamClientJoined(conn));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::JamClientJoinFailed(format!("{e:#}")));
            }
        }
    });
    app.status = Some("joining jam…".to_string());
}

fn open_kick_confirm(app: &mut App) {
    let jam::JamState::Host(h) = &app.jam else {
        return;
    };
    let Some(idx) = h.pane_state.selected() else {
        return;
    };
    let Some(p) = h.participants.get(idx) else {
        return;
    };
    if p.is_self {
        app.status =
            Some("can't kick yourself — use shift-E to end the jam".to_string());
        return;
    }
    let id = p.id;
    let name = p.display_name.clone();
    app.overlay = Overlay::Confirm {
        prompt: format!("Kick {name}?"),
        action: ConfirmAction::KickParticipant { id, name },
    };
}

fn cycle_color(app: &mut App, delta: i32) {
    let Overlay::Colors { slot, .. } = &app.overlay else {
        return;
    };
    let slot = *slot;
    let palette = ui::PICKER_PALETTE;
    let cur = *ui::theme_slot_mut(&mut app.theme, slot);
    let cur_idx = palette.iter().position(|c| *c == cur).unwrap_or(0) as i32;
    let next_idx = (cur_idx + delta).rem_euclid(palette.len() as i32) as usize;
    *ui::theme_slot_mut(&mut app.theme, slot) = palette[next_idx];
}

fn handle_overlay_key(
    app: &mut App,
    key: KeyEvent,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;

    // Confirm dialog — y/enter confirms, n/esc cancels.
    if matches!(app.overlay, Overlay::Confirm { .. }) {
        handle_confirm_overlay_key(app, key);
        return;
    }

    // Join overlay — text input on host/code fields, tab cycles, enter joins.
    if matches!(app.overlay, Overlay::Join { .. }) {
        handle_join_overlay_key(app, key, tx);
        return;
    }

    // Color picker — its Esc reverts (rather than just closing), and its keymap
    // is otherwise distinct from the device picker's, so handle it separately.
    if matches!(app.overlay, Overlay::Colors { .. }) {
        handle_colors_overlay_key(app, key);
        return;
    }

    if matches!(key.code, Esc) || matches!(key.code, Char('?')) {
        app.overlay = Overlay::None;
        return;
    }
    let was_devices = matches!(app.overlay, Overlay::Devices { .. });
    if !was_devices {
        return;
    }
    let (devices_clone, selected_idx, was_loading) = match &mut app.overlay {
        Overlay::Devices {
            devices,
            state,
            loading,
        } => {
            match key.code {
                Up | Char('k') => {
                    step_state(state, devices.len(), -1);
                    return;
                }
                Down | Char('j') => {
                    step_state(state, devices.len(), 1);
                    return;
                }
                Enter => (devices.clone(), state.selected(), *loading),
                _ => return,
            }
        }
        _ => return,
    };
    if was_loading {
        return;
    }
    let Some(idx) = selected_idx else { return };
    let Some(dev) = devices_clone.get(idx).cloned() else {
        return;
    };
    app.overlay = Overlay::None;
    app.status = Some(format!("transferring → {}", dev.name));
    let s = spotify.clone();
    let tx_inner = tx.clone();
    let want_play = app.playback.as_ref().map_or(false, |p| p.is_playing);
    tokio::spawn(async move {
        match spotify::transfer_to_device(&s, &dev.id, want_play).await {
            Ok(_) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("✓ on {}", dev.name)));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("transfer: {e}")));
            }
        }
    });
}

fn focus_pane(app: &mut App, p: Pane) {
    if app.focus != Pane::Search {
        app.last_focus = app.focus;
    }
    app.focus = p;
}

fn focus_search(app: &mut App) {
    if app.focus != Pane::Search {
        app.last_focus = app.focus;
    }
    app.focus = Pane::Search;
    app.search.sub_focus = SearchSubFocus::Input;
}

fn handle_search_key(
    app: &mut App,
    key: KeyEvent,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

    // Always-on Esc: defocus the pane.
    if key.code == Esc {
        app.focus = app.last_focus;
        return;
    }
    // Always-on Ctrl-A: add cursor result to open playlist.
    if matches!(key.code, Char('a')) && ctrl {
        add_to_open_playlist(app, spotify, tx);
        return;
    }
    // Always-on Tab/BackTab: cycle panes (out of search).
    if matches!(key.code, Tab) {
        app.focus = Pane::Search.next();
        return;
    }
    if matches!(key.code, BackTab) {
        app.focus = Pane::Search.prev();
        return;
    }

    match app.search.sub_focus {
        SearchSubFocus::Input => handle_search_input_key(app, key, spotify, tx),
        SearchSubFocus::Results => handle_search_results_key(app, key, spotify, tx),
    }
}

fn handle_search_input_key(
    app: &mut App,
    key: KeyEvent,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match (key.code, ctrl) {
        // Down or Enter while in input: jump into the results list.
        (Down, _) | (Enter, _) => {
            if !app.search.results.is_empty() {
                app.search.sub_focus = SearchSubFocus::Results;
                if app.search.state.selected().is_none() {
                    app.search.state.select(Some(0));
                }
            }
        }
        (Backspace, _) => {
            app.search.query.pop();
            fire_search(app, spotify, tx);
        }
        (Char(c), false) => {
            app.search.query.push(c);
            fire_search(app, spotify, tx);
        }
        _ => {}
    }
}

fn handle_search_results_key(
    app: &mut App,
    key: KeyEvent,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    use KeyCode::*;
    match key.code {
        Up => {
            // If at the top, jump back to the input.
            if app.search.state.selected().map_or(true, |i| i == 0) {
                app.search.sub_focus = SearchSubFocus::Input;
            } else {
                step_state(&mut app.search.state, app.search.results.len(), -1);
            }
        }
        Char('k') => {
            if app.search.state.selected().map_or(true, |i| i == 0) {
                app.search.sub_focus = SearchSubFocus::Input;
            } else {
                step_state(&mut app.search.state, app.search.results.len(), -1);
            }
        }
        Down | Char('j') => {
            step_state(&mut app.search.state, app.search.results.len(), 1);
        }
        Enter => play_search_selection(app, spotify, tx),
        Char('q') => queue_search_selection(app, spotify, tx),
        Char('Q') => play_search_selection_now(app, spotify, tx),
        Char('a') => add_to_open_playlist(app, spotify, tx),
        Char('/') => {
            app.search.sub_focus = SearchSubFocus::Input;
        }
        _ => {}
    }
}

fn fire_search(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    if app.search.query.trim().is_empty() {
        app.search.results.clear();
        app.search.state.select(None);
        return;
    }
    app.search.seq += 1;
    let seq = app.search.seq;
    let query = app.search.query.clone();
    let sp = spotify.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(180)).await;
        // Spotify dev-mode caps /search?limit at 10 (undocumented; 11+ returns
        // 400 "Invalid limit"). Bump if the app gets Extended Quota approval.
        match spotify::search_tracks(&sp, &query, 10).await {
            Ok(results) => {
                let _ = tx.send(Action::SearchResults { seq, results });
            }
            Err(e) => {
                let _ = tx.send(Action::SearchError {
                    seq,
                    error: format!("{e}"),
                });
            }
        }
    });
}

// ---------- Cursor navigation ----------

fn move_cursor(app: &mut App, delta: i32) {
    match app.focus {
        Pane::Library => step_state(&mut app.library_state, app.playlists.len(), delta),
        Pane::Listing => {
            if let Some(l) = app.listing.as_mut() {
                step_state(&mut l.state, l.tracks.len(), delta);
            }
        }
        Pane::Queue => step_state(&mut app.queue_state, app.queue.len(), delta),
        Pane::Search => step_state(&mut app.search.state, app.search.results.len(), delta),
        Pane::Jam => match &mut app.jam {
            jam::JamState::Host(h) => step_state(&mut h.pane_state, h.participants.len(), delta),
            jam::JamState::Client(c) => step_state(&mut c.pane_state, c.participants.len(), delta),
            jam::JamState::Idle => {}
        },
        _ => {}
    }
}

fn step_state(state: &mut ListState, len: usize, delta: i32) {
    if len == 0 {
        state.select(None);
        return;
    }
    let cur = state.selected().unwrap_or(0) as i32;
    let next = (cur + delta).clamp(0, len as i32 - 1);
    state.select(Some(next as usize));
}

fn move_cursor_to(app: &mut App, idx: usize) {
    match app.focus {
        Pane::Library if !app.playlists.is_empty() => {
            app.library_state.select(Some(idx.min(app.playlists.len() - 1)));
        }
        Pane::Listing => {
            if let Some(l) = app.listing.as_mut() {
                if !l.tracks.is_empty() {
                    l.state.select(Some(idx.min(l.tracks.len() - 1)));
                }
            }
        }
        Pane::Queue if !app.queue.is_empty() => {
            app.queue_state.select(Some(idx.min(app.queue.len() - 1)));
        }
        Pane::Search if !app.search.results.is_empty() => {
            app.search
                .state
                .select(Some(idx.min(app.search.results.len() - 1)));
        }
        Pane::Jam => match &mut app.jam {
            jam::JamState::Host(h) if !h.participants.is_empty() => {
                h.pane_state.select(Some(idx.min(h.participants.len() - 1)));
            }
            jam::JamState::Client(c) if !c.participants.is_empty() => {
                c.pane_state.select(Some(idx.min(c.participants.len() - 1)));
            }
            _ => {}
        },
        _ => {}
    }
}

fn move_cursor_to_end(app: &mut App) {
    match app.focus {
        Pane::Library if !app.playlists.is_empty() => {
            app.library_state.select(Some(app.playlists.len() - 1));
        }
        Pane::Listing => {
            if let Some(l) = app.listing.as_mut() {
                if !l.tracks.is_empty() {
                    l.state.select(Some(l.tracks.len() - 1));
                }
            }
        }
        Pane::Queue if !app.queue.is_empty() => {
            app.queue_state.select(Some(app.queue.len() - 1));
        }
        Pane::Search if !app.search.results.is_empty() => {
            app.search
                .state
                .select(Some(app.search.results.len() - 1));
        }
        Pane::Jam => match &mut app.jam {
            jam::JamState::Host(h) if !h.participants.is_empty() => {
                h.pane_state.select(Some(h.participants.len() - 1));
            }
            jam::JamState::Client(c) if !c.participants.is_empty() => {
                c.pane_state.select(Some(c.participants.len() - 1));
            }
            _ => {}
        },
        _ => {}
    }
}

// ---------- Activate (Enter) ----------

async fn activate(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    cache: &Arc<Cache>,
    tx: &mpsc::UnboundedSender<Action>,
) {
    match app.focus {
        Pane::Library => open_library_selection(app, spotify, cache, tx),
        Pane::Listing => play_listing_track(app, spotify, tx),
        _ => {}
    }
}

fn open_library_selection(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    cache: &Arc<Cache>,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(idx) = app.library_cursor() else { return };
    let Some(p) = app.playlists.get(idx).cloned() else { return };

    let cached = cache.load_tracks(&p.id, &p.snapshot_id);
    let has_cache = cached.is_some();

    let mut state = ListState::default();
    if cached.as_ref().map_or(false, |t| !t.is_empty()) {
        state.select(Some(0));
    }
    app.listing = Some(ListingState {
        playlist_id: p.id.clone(),
        playlist_name: p.name.clone(),
        tracks: cached.unwrap_or_default(),
        state,
        loading: !has_cache,
    });
    app.focus = Pane::Listing;

    let s = spotify.clone();
    let c = cache.clone();
    let tx = tx.clone();
    let pid = p.id.clone();
    let snapshot = p.snapshot_id.clone();
    tokio::spawn(async move {
        let pid_for_cb = pid.clone();
        let tx_for_cb = tx.clone();
        let result = spotify::list_playlist_tracks(
            &s,
            &pid,
            |page, total, is_first, is_last, min_added_at| {
                let _ = tx_for_cb.send(Action::TracksLoaded {
                    playlist_id: pid_for_cb.clone(),
                    tracks: page.to_vec(),
                    total,
                    min_added_at: min_added_at.map(String::from),
                    is_first,
                    is_last,
                });
            },
        )
        .await;
        match result {
            Ok(tracks) => {
                // Don't persist the synthetic Liked Songs entry — it has no
                // real snapshot id and the next /me/tracks call refreshes it.
                if pid != spotify::LIKED_PLAYLIST_ID {
                    if let Err(e) = c.save_tracks(&pid, &snapshot, &tracks) {
                        tracing::warn!("tracks cache save: {e}");
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Action::TracksError {
                    playlist_id: pid,
                    error: format!("{e}"),
                });
            }
        }
    });
}

fn play_listing_track(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    if host_only_blocked(app) {
        return;
    }
    let Some(l) = app.listing.as_ref() else { return };
    let Some(idx) = l.state.selected() else { return };
    let Some(track) = l.tracks.get(idx).cloned() else { return };
    // Liked Songs has no playlist URI — Spotify exposes it via the user's
    // collection context. Fall back to playing the track URI directly if me_id
    // hasn't loaded yet (rare race during first-second of startup).
    let context_uri = if l.playlist_id == spotify::LIKED_PLAYLIST_ID {
        match app.me_id.as_ref() {
            Some(id) => format!("spotify:user:{id}:collection"),
            None => {
                app.status = Some("user id not loaded yet — try again in a moment".to_string());
                return;
            }
        }
    } else {
        format!("spotify:playlist:{}", l.playlist_id)
    };
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let s = spotify.clone();
    let tx = tx.clone();
    let track_name = track.name.clone();
    let track_uri = track.uri.clone();
    tokio::spawn(async move {
        match spotify::play_in_context(&s, &context_uri, &track_uri, device_id.as_deref()).await {
            Ok(_) => {
                let _ = tx.send(Action::StatusFlash(format!("▶ {track_name}")));
            }
            Err(e) => {
                let _ = tx.send(Action::StatusFlash(format!("play: {e}")));
            }
        }
    });
}

fn play_search_selection(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    if host_only_blocked(app) {
        return;
    }
    let Some(idx) = app.search.state.selected() else { return };
    let Some(track) = app.search.results.get(idx).cloned() else { return };
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let sp = spotify.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        match spotify::play_uris(&sp, &[track.uri.clone()], device_id.as_deref()).await {
            Ok(_) => {
                let _ = tx.send(Action::StatusFlash(format!("▶ {}", track.name)));
            }
            Err(e) => {
                let _ = tx.send(Action::StatusFlash(format!("play: {e}")));
            }
        }
    });
}

// ---------- Add to open playlist ----------

fn add_to_open_playlist(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) {
    let Some(l) = app.listing.as_ref() else {
        app.status = Some("no open playlist — open one from Library first".to_string());
        return;
    };
    if l.playlist_id == spotify::LIKED_PLAYLIST_ID {
        app.status = Some(
            "Liked Songs is read-only here — save tracks from the Spotify client".to_string(),
        );
        return;
    }
    let target_id = l.playlist_id.clone();
    let target_name = l.playlist_name.clone();

    // Source: search cursor when search is focused; otherwise now-playing track.
    let (track_uri, track_name) = if app.focus == Pane::Search {
        let Some(idx) = app.search.state.selected() else {
            app.status = Some("no search result selected".to_string());
            return;
        };
        let Some(t) = app.search.results.get(idx) else {
            return;
        };
        (t.uri.clone(), t.name.clone())
    } else {
        let Some(p) = app.playback.as_ref() else {
            app.status = Some("no track playing — / to search instead".to_string());
            return;
        };
        let Some(uri) = p.track_uri.clone() else {
            app.status = Some("now-playing track has no URI".to_string());
            return;
        };
        (uri, p.track.clone().unwrap_or_default())
    };

    app.status = Some(format!("adding {track_name} → {target_name}…"));
    let s = spotify.clone();
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match spotify::add_tracks_to_playlist(&s, &target_id, &[track_uri]).await {
            Ok(_) => {
                let _ = tx_inner.send(Action::StatusFlash(format!(
                    "✓ added {track_name} → {target_name}"
                )));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("✗ add failed: {e}")));
            }
        }
    });
}

// ---------- Playback control ----------

async fn toggle_play(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
) -> Result<()> {
    if host_only_blocked(app) {
        return Ok(());
    }
    let playing = app.playback.as_ref().map(|p| p.is_playing).unwrap_or(false);
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let result = if playing {
        spotify.pause_playback(device_id.as_deref()).await
    } else {
        spotify.resume_playback(device_id.as_deref(), None).await
    };
    match result {
        Ok(_) => {
            if let Some(p) = app.playback.as_mut() {
                p.is_playing = !playing;
            }
        }
        Err(e) => {
            let msg = format!("play/pause failed: {e}");
            warn!("{msg}");
            let _ = tx.send(Action::StatusFlash(msg));
        }
    }
    Ok(())
}

fn adjust_volume(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
    delta: i32,
) {
    if host_only_blocked(app) {
        return;
    }
    let cur = app
        .playback
        .as_ref()
        .and_then(|p| p.volume_percent)
        .unwrap_or(50) as i32;
    let next = (cur + delta).clamp(0, 100) as u32;
    if let Some(p) = app.playback.as_mut() {
        p.volume_percent = Some(next);
    }
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let s = spotify.clone();
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        match spotify::set_volume(&s, next, device_id.as_deref()).await {
            Ok(_) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("vol {next}%")));
            }
            Err(e) => {
                let _ = tx_inner.send(Action::StatusFlash(format!("volume: {e}")));
            }
        }
    });
}

fn seek_relative(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
    delta_ms: i64,
) {
    if host_only_blocked(app) {
        return;
    }
    let Some(p) = app.playback.as_ref() else {
        let _ = tx.send(Action::StatusFlash("nothing playing".to_string()));
        return;
    };
    let cur = p.progress_ms.unwrap_or(0) as i64;
    let dur = p.duration_ms.unwrap_or(u64::MAX) as i64;
    let target = (cur + delta_ms).clamp(0, dur);
    if let Some(p) = app.playback.as_mut() {
        p.progress_ms = Some(target as u64);
    }
    let device_id = app.playback.as_ref().and_then(|p| p.device_id.clone());
    let s = spotify.clone();
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        if let Err(e) = spotify::seek_to(&s, target, device_id.as_deref()).await {
            let _ = tx_inner.send(Action::StatusFlash(format!("seek: {e}")));
        }
    });
}

fn skip_track(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    tx: &mpsc::UnboundedSender<Action>,
    forward: bool,
) {
    if host_only_blocked(app) {
        return;
    }
    let s = spotify.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let r = if forward {
            s.next_track(None).await
        } else {
            s.previous_track(None).await
        };
        if let Err(e) = r {
            let _ = tx.send(Action::StatusFlash(format!("skip: {e}")));
        }
    });
}

fn trigger_reload(
    app: &mut App,
    spotify: &AuthCodePkceSpotify,
    cache: &Arc<Cache>,
    tx: &mpsc::UnboundedSender<Action>,
) {
    app.library_loading = true;
    app.status = Some("reloading playlists…".to_string());
    let s = spotify.clone();
    let c = cache.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        match spotify::list_playlists(&s).await {
            Ok(ps) => {
                if let Err(e) = c.save_playlists(&ps) {
                    tracing::warn!("playlist cache save: {e}");
                }
                let _ = tx.send(Action::PlaylistsLoaded(ps));
            }
            Err(e) => {
                let _ = tx.send(Action::PlaylistsError(format!("{e}")));
            }
        }
    });
}
