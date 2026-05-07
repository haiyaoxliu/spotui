//! Axum server bound to the Tailscale interface. Phase 0 surface: a
//! single `/healthz` endpoint that confirms reachability.

use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::{routing::get, Router};
use tracing::info;

use super::tailscale;

const PORT: u16 = 7878;

/// Resolve the Tailscale IPv4, bind, and serve until the process exits.
pub async fn run() -> Result<()> {
    let ip = tailscale::resolve()?;
    let addr = SocketAddr::from((ip, PORT));
    let host = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".into());

    let app = Router::new().route("/healthz", get({
        let host = host.clone();
        move || async move { format!("ok {host}\n") }
    }));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind {addr} on tailscale0"))?;

    info!(%addr, host = %host, "spotui web server listening (tailscale-only)");
    eprintln!("[spotui] serving on http://{addr}/  (host: {host})");

    axum::serve(listener, app)
        .await
        .context("axum server exited with error")
}
