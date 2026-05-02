//! WebSocket transport for the jam feature. Plain `ws://` over TCP — no TLS
//! since this is LAN-only and the join code is the authentication.
//!
//! ## Server flow
//! 1. `start_server` binds a `TcpListener` and spawns `accept_loop`.
//! 2. `accept_loop` accepts each connection and spawns `per_client_task`.
//! 3. `per_client_task` does the WS handshake, validates the join code, then
//!    notifies the main loop via `Action::JamClientConnecting` (passing a
//!    sender). The main loop assigns an id, registers the participant, and
//!    sends `HostMsg::Joined` back through that sender.
//! 4. The per-client task then runs a select loop forwarding messages between
//!    the WS and the main loop until either side disconnects.
//!
//! ## Client flow
//! 1. `connect_client` opens a TCP+WS connection, sends `Join`, awaits the
//!    `Joined` (or `Rejected`) response.
//! 2. On success it spawns `client_relay`, which forwards inbound WS messages
//!    to the main loop and outbound `ClientMsg`s to the WS until either side
//!    closes.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::OnceLock;

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

use crate::app::Action;
use crate::jam::{ClientMsg, HostMsg, ParticipantId, ParticipantPayload};

/// Port the host binds on. Hardcoded for now; configurable in a follow-up.
pub const JAM_PORT: u16 = 7878;

/// DNS-SD service type for the jam protocol. Trailing dot is significant.
pub const SERVICE_TYPE: &str = "_spotui-jam._tcp.local.";

/// Lazily-initialized shared mDNS daemon. Returns `None` if init fails (e.g.
/// no usable network interfaces) — callers should fall back to manual entry.
pub fn mdns() -> Option<&'static ServiceDaemon> {
    static DAEMON: OnceLock<Option<ServiceDaemon>> = OnceLock::new();
    DAEMON
        .get_or_init(|| match ServiceDaemon::new() {
            Ok(d) => Some(d),
            Err(e) => {
                warn!("mdns daemon init failed: {e}");
                None
            }
        })
        .as_ref()
}

// ---------- Host side ----------

#[derive(Debug)]
pub struct HostServerStart {
    pub bind_addr: SocketAddr,
    pub server_handle: JoinHandle<()>,
    pub advert: Option<HostAdvert>,
}

/// RAII guard for an active mDNS service registration. On `Drop` it best-effort
/// unregisters from the daemon so other clients see the service vanish.
pub struct HostAdvert {
    fullname: String,
}

impl std::fmt::Debug for HostAdvert {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostAdvert")
            .field("fullname", &self.fullname)
            .finish()
    }
}

impl Drop for HostAdvert {
    fn drop(&mut self) {
        if let Some(d) = mdns() {
            let _ = d.unregister(&self.fullname);
        }
    }
}

fn advertise(display_name: &str, ip: IpAddr, port: u16) -> Option<HostAdvert> {
    let daemon = mdns()?;
    // mDNS hostnames must be DNS-safe. Derive a unique hostname from the IP so
    // multiple hosts on the same LAN don't collide on the "server" field.
    let hostname = match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("spotui-{}-{}-{}-{}.local.", o[0], o[1], o[2], o[3])
        }
        IpAddr::V6(_) => "spotui.local.".to_string(),
    };
    let info = match ServiceInfo::new(
        SERVICE_TYPE,
        display_name,
        &hostname,
        ip,
        port,
        None::<HashMap<String, String>>,
    ) {
        Ok(i) => i,
        Err(e) => {
            warn!("mdns ServiceInfo build failed: {e}");
            return None;
        }
    };
    let fullname = info.get_fullname().to_string();
    if let Err(e) = daemon.register(info) {
        warn!("mdns register failed: {e}");
        return None;
    }
    Some(HostAdvert { fullname })
}

pub async fn start_server(
    code: String,
    host_name: String,
    main_tx: mpsc::UnboundedSender<Action>,
) -> Result<HostServerStart> {
    let listener = TcpListener::bind(("0.0.0.0", JAM_PORT))
        .await
        .with_context(|| format!("bind 0.0.0.0:{JAM_PORT}"))?;
    let port = listener.local_addr()?.port();
    let ip = pick_lan_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let bind_addr = SocketAddr::new(ip, port);
    let server_handle = tokio::spawn(accept_loop(listener, code, main_tx));
    let advert = advertise(&host_name, ip, port);
    Ok(HostServerStart {
        bind_addr,
        server_handle,
        advert,
    })
}

async fn accept_loop(
    listener: TcpListener,
    code: String,
    main_tx: mpsc::UnboundedSender<Action>,
) {
    loop {
        let (socket, _addr) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                debug!("jam accept error: {e}");
                continue;
            }
        };
        let code_c = code.clone();
        let tx_c = main_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = per_client_task(socket, code_c, tx_c).await {
                debug!("jam per-client task ended: {e:#}");
            }
        });
    }
}

async fn per_client_task(
    socket: TcpStream,
    code: String,
    main_tx: mpsc::UnboundedSender<Action>,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(socket)
        .await
        .context("ws handshake")?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    // First message must be Join.
    let raw = ws_rx
        .next()
        .await
        .ok_or_else(|| anyhow!("client closed before join"))?
        .context("read join")?;
    let parsed: ClientMsg = match raw {
        WsMessage::Text(t) => serde_json::from_str(&t).context("parse join")?,
        _ => return Err(anyhow!("expected text join message")),
    };
    let (recv_code, display_name) = match parsed {
        ClientMsg::Join {
            code,
            display_name,
        } => (code, display_name),
        _ => {
            send_msg(
                &mut ws_tx,
                &HostMsg::Rejected {
                    reason: "expected join".into(),
                },
            )
            .await
            .ok();
            return Ok(());
        }
    };
    if recv_code != code {
        send_msg(
            &mut ws_tx,
            &HostMsg::Rejected {
                reason: "invalid code".into(),
            },
        )
        .await
        .ok();
        return Ok(());
    }

    // Hand control to the main loop. It assigns the id, registers the
    // participant, and sends back HostMsg::Joined via this channel.
    let (per_tx, mut per_rx) = mpsc::unbounded_channel::<HostMsg>();
    main_tx
        .send(Action::JamClientConnecting {
            display_name,
            sender: per_tx,
        })
        .map_err(|_| anyhow!("main loop closed"))?;

    let initial = per_rx
        .recv()
        .await
        .ok_or_else(|| anyhow!("main loop did not respond"))?;
    let my_id = match &initial {
        HostMsg::Joined { id, .. } => *id,
        HostMsg::Rejected { reason } => {
            send_msg(&mut ws_tx, &HostMsg::Rejected { reason: reason.clone() })
                .await
                .ok();
            return Ok(());
        }
        _ => return Err(anyhow!("unexpected first message from main")),
    };
    send_msg(&mut ws_tx, &initial).await?;

    // Relay loop. Inbound WS messages turn into `Action`s; outbound `HostMsg`s
    // from the main loop turn into WS frames.
    loop {
        tokio::select! {
            inbound = ws_rx.next() => match inbound {
                Some(Ok(WsMessage::Text(text))) => {
                    if let Ok(parsed) = serde_json::from_str::<ClientMsg>(&text) {
                        match parsed {
                            ClientMsg::Leave => break,
                            ClientMsg::Queue { track } => {
                                main_tx
                                    .send(Action::JamHostQueueRequest { from: my_id, track })
                                    .ok();
                            }
                            // The handshake already consumed Join; ignore stray re-joins.
                            ClientMsg::Join { .. } => {}
                        }
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Err(e)) => {
                    debug!("jam ws read error: {e}");
                    break;
                }
                _ => {}
            },
            outbound = per_rx.recv() => match outbound {
                Some(msg) => {
                    let terminal = matches!(msg, HostMsg::Kicked | HostMsg::JamEnded);
                    if send_msg(&mut ws_tx, &msg).await.is_err() {
                        break;
                    }
                    if terminal {
                        break;
                    }
                }
                None => break, // main dropped sender (kick or end-jam path)
            },
        }
    }

    main_tx
        .send(Action::JamParticipantDisconnected { id: my_id })
        .ok();
    Ok(())
}

// ---------- Client side ----------

#[derive(Debug)]
pub struct ClientConn {
    pub host_addr: String,
    pub code: String,
    pub my_id: ParticipantId,
    pub host_name: String,
    pub participants: Vec<ParticipantPayload>,
    pub outbound: mpsc::UnboundedSender<ClientMsg>,
    pub handle: JoinHandle<()>,
}

pub async fn connect_client(
    host_addr: String,
    code: String,
    my_name: String,
    main_tx: mpsc::UnboundedSender<Action>,
) -> Result<ClientConn> {
    // Manual TCP + `client_async` so we can use the no-TLS feature set; the
    // `connect_async` convenience requires the `connect` feature, which pulls
    // a TLS impl we don't need for LAN-only ws://.
    let stream = TcpStream::connect(&host_addr)
        .await
        .with_context(|| format!("connect {host_addr}"))?;
    let url = format!("ws://{host_addr}/");
    let (ws, _resp) = tokio_tungstenite::client_async(url, stream)
        .await
        .context("ws handshake")?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    send_msg(
        &mut ws_tx,
        &ClientMsg::Join {
            code: code.clone(),
            display_name: my_name,
        },
    )
    .await
    .context("send join")?;

    let raw = ws_rx
        .next()
        .await
        .ok_or_else(|| anyhow!("server closed before response"))?
        .context("read join response")?;
    let parsed: HostMsg = match raw {
        WsMessage::Text(t) => serde_json::from_str(&t).context("parse join response")?,
        _ => return Err(anyhow!("expected text response")),
    };
    let (my_id, host_name, participants) = match parsed {
        HostMsg::Joined {
            id,
            host_name,
            participants,
        } => (id, host_name, participants),
        HostMsg::Rejected { reason } => return Err(anyhow!("rejected: {reason}")),
        _ => return Err(anyhow!("unexpected response from host")),
    };

    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<ClientMsg>();
    let main_tx_c = main_tx.clone();
    let handle = tokio::spawn(async move {
        client_relay(ws_tx, ws_rx, outbound_rx, main_tx_c).await;
    });

    Ok(ClientConn {
        host_addr,
        code,
        my_id,
        host_name,
        participants,
        outbound: outbound_tx,
        handle,
    })
}

async fn client_relay(
    mut ws_tx: futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<TcpStream>,
        WsMessage,
    >,
    mut ws_rx: futures::stream::SplitStream<tokio_tungstenite::WebSocketStream<TcpStream>>,
    mut outbound: mpsc::UnboundedReceiver<ClientMsg>,
    main_tx: mpsc::UnboundedSender<Action>,
) {
    let mut left = false;
    loop {
        tokio::select! {
            inbound = ws_rx.next() => match inbound {
                Some(Ok(WsMessage::Text(text))) => {
                    match serde_json::from_str::<HostMsg>(&text) {
                        Ok(msg) => {
                            let terminal = matches!(msg, HostMsg::Kicked | HostMsg::JamEnded);
                            forward_host_msg(msg, &main_tx);
                            if terminal {
                                return; // host already told us to stop
                            }
                        }
                        Err(e) => warn!("jam parse host msg: {e}"),
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Err(e)) => {
                    debug!("jam ws read error: {e}");
                    break;
                }
                _ => {}
            },
            out = outbound.recv() => match out {
                Some(msg) => {
                    let is_leave = matches!(msg, ClientMsg::Leave);
                    if send_msg(&mut ws_tx, &msg).await.is_err() {
                        break;
                    }
                    if is_leave {
                        left = true;
                        break;
                    }
                }
                None => break,
            },
        }
    }
    if !left {
        // Connection lost without a clean leave — let the main loop transition
        // back to Idle with a status flash.
        let _ = main_tx.send(Action::JamClientLost(
            "disconnected from host".to_string(),
        ));
    }
}

fn forward_host_msg(msg: HostMsg, main_tx: &mpsc::UnboundedSender<Action>) {
    match msg {
        HostMsg::Joined { .. } | HostMsg::Rejected { .. } => {
            // Already consumed during the handshake.
        }
        HostMsg::QueueAck { uri, ok, error } => {
            let _ = main_tx.send(Action::JamClientQueueAck { uri, ok, error });
        }
        HostMsg::PlaybackUpdated { playback } => {
            let _ = main_tx.send(Action::JamClientPlaybackUpdated(playback));
        }
        HostMsg::QueueUpdated { queue } => {
            let _ = main_tx.send(Action::JamClientQueueUpdated(queue));
        }
        HostMsg::ParticipantsUpdated { participants } => {
            let _ = main_tx.send(Action::JamClientParticipantsUpdated(participants));
        }
        HostMsg::Kicked => {
            let _ = main_tx.send(Action::JamClientKicked);
        }
        HostMsg::JamEnded => {
            let _ = main_tx.send(Action::JamClientEnded);
        }
    }
}

// ---------- Helpers ----------

async fn send_msg<S, T>(sink: &mut S, msg: &T) -> Result<()>
where
    S: SinkExt<WsMessage> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
    T: serde::Serialize,
{
    let body = serde_json::to_string(msg).context("encode msg")?;
    sink.send(WsMessage::Text(body))
        .await
        .map_err(|e| anyhow!("ws send: {e}"))?;
    Ok(())
}

// ---------- mDNS browse ----------

/// RAII guard for an active mDNS browse. Aborts the relay task and tells the
/// daemon to stop browsing on `Drop`.
#[derive(Debug)]
pub struct BrowseHandle {
    handle: JoinHandle<()>,
}

impl Drop for BrowseHandle {
    fn drop(&mut self) {
        self.handle.abort();
        if let Some(d) = mdns() {
            let _ = d.stop_browse(SERVICE_TYPE);
        }
    }
}

pub fn start_browse(main_tx: mpsc::UnboundedSender<Action>) -> Option<BrowseHandle> {
    let daemon = mdns()?;
    let receiver = match daemon.browse(SERVICE_TYPE) {
        Ok(r) => r,
        Err(e) => {
            warn!("mdns browse failed: {e}");
            return None;
        }
    };
    let handle = tokio::spawn(async move {
        while let Ok(event) = receiver.recv_async().await {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let fullname = info.get_fullname().to_string();
                    let display_name = parse_instance_name(&fullname);
                    // Prefer IPv4 for ergonomic `ip:port` strings users type.
                    let v4 = info.get_addresses().iter().find_map(|a| match a.to_ip_addr() {
                        IpAddr::V4(v) => Some(v),
                        _ => None,
                    });
                    if let Some(ip) = v4 {
                        let port = info.get_port();
                        let _ = main_tx.send(Action::JamMdnsDiscovered {
                            display_name,
                            addr: format!("{ip}:{port}"),
                            fullname,
                        });
                    }
                }
                ServiceEvent::ServiceRemoved(_ty, fullname) => {
                    let _ = main_tx.send(Action::JamMdnsLost { fullname });
                }
                _ => {}
            }
        }
    });
    Some(BrowseHandle { handle })
}

fn parse_instance_name(fullname: &str) -> String {
    // "alex._spotui-jam._tcp.local." → "alex"
    let suffix = format!(".{SERVICE_TYPE}");
    fullname
        .strip_suffix(&suffix)
        .unwrap_or(fullname)
        .to_string()
}

/// Pick the first non-loopback IPv4 address. Falls back to localhost so the
/// host pane always has something to display.
fn pick_lan_ip() -> Option<IpAddr> {
    let addrs = if_addrs::get_if_addrs().ok()?;
    for a in &addrs {
        if a.is_loopback() {
            continue;
        }
        if let IpAddr::V4(ip) = a.ip() {
            let octets = ip.octets();
            // Skip APIPA self-assigned 169.254.x.x — useless to share.
            if octets[0] == 169 && octets[1] == 254 {
                continue;
            }
            return Some(IpAddr::V4(ip));
        }
    }
    None
}
