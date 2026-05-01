use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use rspotify::{
    AuthCodePkceSpotify, Config as RspConfig, Credentials, OAuth,
    clients::{BaseClient, OAuthClient},
    scopes,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tracing::{info, warn};
use url::Url;

use crate::config::{Config, Paths};

const SUCCESS_BODY: &str = "<!doctype html><html><head><meta charset=utf-8><title>spotui</title>\
<style>body{font:16px -apple-system,Segoe UI,sans-serif;background:#111;color:#eee;\
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}\
.card{padding:32px;border:1px solid #2a2a2a;border-radius:12px;text-align:center}</style></head>\
<body><div class=card><h2>spotui authorized.</h2><p>You can close this tab.</p></div></body></html>";

const FAIL_BODY: &str = "<!doctype html><html><body><h2>spotui auth failed</h2>\
<p>Check the terminal.</p></body></html>";

pub async fn authenticate(cfg: &Config, paths: &Paths) -> Result<AuthCodePkceSpotify> {
    let creds = Credentials::new_pkce(&cfg.client_id);
    let oauth = OAuth {
        redirect_uri: cfg.redirect_uri(),
        scopes: scopes!(
            "user-read-playback-state",
            "user-modify-playback-state",
            "user-read-currently-playing",
            "playlist-read-private",
            "playlist-read-collaborative",
            "playlist-modify-private",
            "playlist-modify-public",
            "user-library-read",
            "user-library-modify",
            "user-read-recently-played"
        ),
        ..Default::default()
    };
    let rcfg = RspConfig {
        cache_path: paths.token_cache.clone(),
        token_cached: true,
        token_refreshing: true,
        ..Default::default()
    };

    let mut client = AuthCodePkceSpotify::with_config(creds, oauth, rcfg);

    // Try cached token first.
    match client.read_token_cache(true).await {
        Ok(Some(tok)) => {
            let expired = tok.is_expired();
            *client.token.lock().await.unwrap() = Some(tok);
            if expired {
                info!("cached token expired; refreshing");
                if let Some(new_tok) = client.refetch_token().await? {
                    *client.token.lock().await.unwrap() = Some(new_tok);
                    client.write_token_cache().await?;
                } else {
                    warn!("refresh failed; falling back to full auth");
                    full_auth(&mut client, cfg).await?;
                }
            }
        }
        _ => {
            full_auth(&mut client, cfg).await?;
        }
    }

    Ok(client)
}

async fn full_auth(client: &mut AuthCodePkceSpotify, cfg: &Config) -> Result<()> {
    let url = client
        .get_authorize_url(None)
        .map_err(|e| anyhow!("build auth URL: {e}"))?;

    let listener = TcpListener::bind(("127.0.0.1", cfg.redirect_port))
        .await
        .with_context(|| {
            format!(
                "bind 127.0.0.1:{}. Is something else using this port?",
                cfg.redirect_port
            )
        })?;

    println!("\nOpening browser to authorize spotui...");
    println!("If it doesn't open, paste this URL manually:\n  {url}\n");
    if let Err(e) = webbrowser::open(&url) {
        eprintln!("(could not auto-open browser: {e})");
    }

    // Wait up to 5 minutes for the redirect.
    let code = timeout(Duration::from_secs(300), accept_code(&listener, &cfg.redirect_uri()))
        .await
        .map_err(|_| anyhow!("timed out waiting for browser redirect"))??;

    client
        .request_token(&code)
        .await
        .map_err(|e| anyhow!("exchange code for token: {e}"))?;
    Ok(())
}

async fn accept_code(listener: &TcpListener, redirect_uri: &str) -> Result<String> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let mut total = 0usize;

        // Read just enough to get the request line. Browsers usually send the
        // whole header in one go, so a single read is typically sufficient.
        loop {
            let n = socket.read(&mut buf[total..]).await?;
            if n == 0 {
                break;
            }
            total += n;
            if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") || total == buf.len() {
                break;
            }
        }
        let req = String::from_utf8_lossy(&buf[..total]);
        let path = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/");

        // Build a fake absolute URL so url::Url can parse the query.
        let synthetic = format!("{}{}", strip_path(redirect_uri), path);
        let parsed = Url::parse(&synthetic).context("parse callback URL")?;

        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        if let Some(err) = pairs.get("error") {
            let _ = write_response(&mut socket, 400, FAIL_BODY).await;
            return Err(anyhow!("authorization denied: {err}"));
        }

        if let Some(code) = pairs.get("code") {
            let _ = write_response(&mut socket, 200, SUCCESS_BODY).await;
            return Ok(code.clone());
        }

        // Probably a /favicon.ico hit or similar; respond and keep waiting.
        let _ = write_response(&mut socket, 404, "not found").await;
    }
}

fn strip_path(uri: &str) -> String {
    // Turn "http://127.0.0.1:8888/callback" -> "http://127.0.0.1:8888"
    if let Ok(u) = Url::parse(uri) {
        let mut base = u.clone();
        base.set_path("");
        let s = base.to_string();
        // url::Url renders a trailing slash; trim it.
        s.trim_end_matches('/').to_string()
    } else {
        uri.to_string()
    }
}

async fn write_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await?;
    socket.shutdown().await.ok();
    Ok(())
}
