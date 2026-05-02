use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;

use ratatui::style::Color;
use ratatui::widgets::ListState;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::app::{Playback, TrackRef};

pub type ParticipantId = u32;

/// Round-robin palette for participant name colors. Saturated mid-dark hues
/// chosen to read clearly on dark terminals without the eye-strain of the
/// `Light*` variants, while staying distinct from each other and from the
/// default theme slots (cyan accent, green success, yellow warn).
pub const PARTICIPANT_PALETTE: [Color; 7] = [
    Color::Red,                  // ANSI red — host's color (palette[0])
    Color::Rgb(0, 100, 0),       // dark green — first joiner
    Color::Magenta,              // ANSI magenta
    Color::Rgb(128, 0, 128),     // purple
    Color::Rgb(128, 0, 0),       // maroon
    Color::Blue,                 // ANSI blue
    Color::Rgb(139, 69, 19),     // saddle brown
];

pub fn color_at_idx(idx: u8) -> Color {
    PARTICIPANT_PALETTE[(idx as usize) % PARTICIPANT_PALETTE.len()]
}

pub fn idx_for_join_order(n: usize) -> u8 {
    (n % PARTICIPANT_PALETTE.len()) as u8
}

#[derive(Debug, Clone)]
pub struct Participant {
    pub id: ParticipantId,
    pub display_name: String,
    pub color: Color,
    pub is_host: bool,
    pub is_self: bool,
}

// ---------- Wire protocol ----------

/// Messages sent from a connected client to the host. Tagged JSON over WS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        code: String,
        display_name: String,
    },
    Queue {
        track: TrackRef,
    },
    Leave,
}

/// Messages sent from the host to a single client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMsg {
    Joined {
        id: ParticipantId,
        host_name: String,
        participants: Vec<ParticipantPayload>,
    },
    Rejected {
        reason: String,
    },
    QueueAck {
        uri: String,
        ok: bool,
        error: Option<String>,
    },
    PlaybackUpdated {
        playback: Option<Playback>,
    },
    QueueUpdated {
        queue: Vec<QueueEntry>,
    },
    ParticipantsUpdated {
        participants: Vec<ParticipantPayload>,
    },
    Kicked,
    JamEnded,
}

/// A queue track plus who submitted it, if known. Used both on the wire (host
/// → client `QueueUpdated`) and internally as `app.queue`'s element type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    pub track: TrackRef,
    pub submitter: Option<ParticipantId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantPayload {
    pub id: ParticipantId,
    pub display_name: String,
    pub color_idx: u8,
    pub is_host: bool,
}

impl ParticipantPayload {
    pub fn from_participant(p: &Participant) -> Self {
        let color_idx = PARTICIPANT_PALETTE
            .iter()
            .position(|c| *c == p.color)
            .unwrap_or(0) as u8;
        Self {
            id: p.id,
            display_name: p.display_name.clone(),
            color_idx,
            is_host: p.is_host,
        }
    }

    pub fn into_participant(self, my_id: ParticipantId) -> Participant {
        Participant {
            id: self.id,
            display_name: self.display_name,
            color: color_at_idx(self.color_idx),
            is_host: self.is_host,
            is_self: self.id == my_id,
        }
    }
}

// ---------- Host / Client state ----------

pub struct HostState {
    pub code: String,
    pub bind_addr: SocketAddr,
    pub participants: Vec<Participant>,
    pub pane_state: ListState,
    pub next_id: ParticipantId,
    /// One channel per connected participant (excluding the host themselves);
    /// the connection task forwards to its WebSocket. Removing a sender drops
    /// the connection (kick / end-jam).
    pub senders: HashMap<ParticipantId, mpsc::UnboundedSender<HostMsg>>,
    /// Append on every queue request (own + forwarded). Drained as items
    /// appear in the polled queue; capped to bound memory if entries get
    /// orphaned by Spotify-side drops.
    pub attribution: VecDeque<(String, ParticipantId)>,
    /// Aborts the accept loop on `Drop`, which cascades into all per-client
    /// tasks losing their connection.
    pub server_handle: JoinHandle<()>,
    /// mDNS service registration. Dropping this unregisters from the LAN.
    /// `None` if mDNS init failed; the host still works for manual joins.
    #[allow(dead_code)]
    pub advert: Option<crate::jam_net::HostAdvert>,
}

impl HostState {
    pub fn new(
        code: String,
        bind_addr: SocketAddr,
        host_name: String,
        server_handle: JoinHandle<()>,
        advert: Option<crate::jam_net::HostAdvert>,
    ) -> Self {
        let host = Participant {
            id: 0,
            display_name: host_name,
            color: color_at_idx(0),
            is_host: true,
            is_self: true,
        };
        let mut state = ListState::default();
        state.select(Some(0));
        Self {
            code,
            bind_addr,
            participants: vec![host],
            pane_state: state,
            next_id: 1,
            senders: HashMap::new(),
            attribution: VecDeque::new(),
            server_handle,
            advert,
        }
    }

    /// Append a (uri, submitter) entry to the attribution ledger. Bounded so
    /// orphaned entries (e.g. tracks Spotify silently dropped) can't grow
    /// memory unboundedly.
    pub fn record_queue_request(&mut self, uri: String, submitter: ParticipantId) {
        const MAX_ATTRIBUTION_ENTRIES: usize = 200;
        self.attribution.push_back((uri, submitter));
        while self.attribution.len() > MAX_ATTRIBUTION_ENTRIES {
            self.attribution.pop_front();
        }
    }

    /// Walk the polled queue and tag each track with its submitter, preferring
    /// the previous attributed queue (so a track keeps its color across polls
    /// even once the ledger entry has been consumed) and falling back to the
    /// ledger for newly-submitted items. Then broadcast the attributed queue
    /// to all connected clients and return it for local use.
    pub fn attribute_and_broadcast_queue(
        &mut self,
        polled: Vec<TrackRef>,
        prev: &[QueueEntry],
    ) -> Vec<QueueEntry> {
        // Slot-by-slot prev attribution per uri: pop_front so duplicates of
        // the same uri preserve their individual attributions.
        let mut prev_slots: HashMap<&str, VecDeque<Option<ParticipantId>>> =
            HashMap::new();
        for e in prev {
            prev_slots
                .entry(e.track.uri.as_str())
                .or_default()
                .push_back(e.submitter);
        }

        let mut entries = Vec::with_capacity(polled.len());
        for t in polled {
            let from_prev: Option<ParticipantId> = prev_slots
                .get_mut(t.uri.as_str())
                .and_then(|q| q.pop_front())
                .flatten();
            let submitter = if from_prev.is_some() {
                from_prev
            } else {
                // Either prev didn't have this uri, or had it unattributed —
                // either way, a fresh ledger entry can claim the slot.
                let pos = self.attribution.iter().position(|(u, _)| u == &t.uri);
                pos.and_then(|p| self.attribution.remove(p).map(|(_, id)| id))
            };
            entries.push(QueueEntry { track: t, submitter });
        }

        let msg = HostMsg::QueueUpdated {
            queue: entries.clone(),
        };
        for tx in self.senders.values() {
            let _ = tx.send(msg.clone());
        }
        entries
    }

    pub fn participants_payload(&self) -> Vec<ParticipantPayload> {
        self.participants
            .iter()
            .map(ParticipantPayload::from_participant)
            .collect()
    }

    /// Push a fresh `ParticipantsUpdated` to every connected client. Senders
    /// whose receivers have been dropped are silently skipped — those tasks
    /// will be reaped when the disconnect notification arrives.
    pub fn broadcast_participants(&self) {
        let payload = self.participants_payload();
        let msg = HostMsg::ParticipantsUpdated {
            participants: payload,
        };
        for tx in self.senders.values() {
            let _ = tx.send(msg.clone());
        }
    }

    pub fn remove_participant(&mut self, id: ParticipantId) -> Option<String> {
        let idx = self.participants.iter().position(|p| p.id == id)?;
        let removed = self.participants.remove(idx);
        if self.participants.is_empty() {
            self.pane_state.select(None);
        } else if let Some(cur) = self.pane_state.selected() {
            if cur >= self.participants.len() {
                self.pane_state.select(Some(self.participants.len() - 1));
            }
        }
        Some(removed.display_name)
    }
}

impl Drop for HostState {
    fn drop(&mut self) {
        // Aborting the accept task closes the listener; per-client tasks then
        // notice their `senders` entry is gone and shut down.
        self.server_handle.abort();
    }
}

pub struct ClientState {
    pub host_addr: String,
    pub host_name: String,
    pub code: String,
    /// Server-assigned id for this client. Used by the WebSocket session when
    /// sending `queue` / `leave`; UI doesn't read it directly.
    #[allow(dead_code)]
    pub my_id: ParticipantId,
    pub participants: Vec<Participant>,
    pub pane_state: ListState,
    /// Outbound channel into the connection relay task.
    pub outbound: mpsc::UnboundedSender<ClientMsg>,
    /// Aborts the relay task on `Drop`.
    pub conn_handle: JoinHandle<()>,
    /// Tracks we've submitted via `Queue` but haven't seen a `QueueAck` for
    /// yet. Lets the ack status flash include the track name.
    pub pending_queue: HashMap<String, String>,
}

impl ClientState {
    pub fn new(
        host_addr: String,
        host_name: String,
        code: String,
        my_id: ParticipantId,
        participants: Vec<Participant>,
        outbound: mpsc::UnboundedSender<ClientMsg>,
        conn_handle: JoinHandle<()>,
    ) -> Self {
        let mut state = ListState::default();
        let self_idx = participants.iter().position(|p| p.is_self).unwrap_or(0);
        state.select(Some(self_idx));
        Self {
            host_addr,
            host_name,
            code,
            my_id,
            participants,
            pane_state: state,
            outbound,
            conn_handle,
            pending_queue: HashMap::new(),
        }
    }
}

impl Drop for ClientState {
    fn drop(&mut self) {
        self.conn_handle.abort();
    }
}

pub enum JamState {
    Idle,
    Host(HostState),
    Client(ClientState),
}

impl JamState {
    pub fn is_active(&self) -> bool {
        !matches!(self, JamState::Idle)
    }

    pub fn role(&self) -> Option<&'static str> {
        match self {
            JamState::Idle => None,
            JamState::Host(_) => Some("host"),
            JamState::Client(_) => Some("client"),
        }
    }
}

// ---------- Code generation ----------

/// Generate a 6-digit join code, using the system time as entropy. 10^6 = 1M
/// possible values — plenty for a small LAN.
pub fn generate_code() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0xC0FFEE) as u64;
    let mixed = nanos
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    format!("{:06}", mixed % 1_000_000)
}
