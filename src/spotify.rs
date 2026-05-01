use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use reqwest::{Client, StatusCode};
use rspotify::AuthCodePkceSpotify;
use serde_json::Value;

use crate::app::{Playback, PlaylistRef, TrackRef};

const API: &str = "https://api.spotify.com/v1";

async fn token(client: &AuthCodePkceSpotify) -> Result<String> {
    let guard = client.token.lock().await.unwrap();
    guard
        .as_ref()
        .map(|t| t.access_token.clone())
        .ok_or_else(|| anyhow!("no access token"))
}

fn http() -> &'static Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(4)
            .build()
            .expect("reqwest client")
    })
}

// GET wrapper that retries on transient network errors and 429s.
async fn get_json(url: &str, tok: &str) -> Result<Value> {
    let mut last_err: Option<anyhow::Error> = None;
    let mut delay = Duration::from_millis(250);
    for _ in 0..4 {
        match http().get(url).bearer_auth(tok).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status == StatusCode::TOO_MANY_REQUESTS {
                    let secs = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(2)
                        .min(10);
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                    continue;
                }
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    bail!("{url} → {status}: {body}");
                }
                return Ok(resp.json().await?);
            }
            Err(e) => {
                last_err = Some(anyhow!("send failed: {e:#}"));
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(2));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("retries exhausted: {url}")))
}

pub async fn fetch_playback(client: &AuthCodePkceSpotify) -> Result<Option<Playback>> {
    let tok = token(client).await?;
    // /me/player can legitimately return 204 (no playback). The retry helper
    // treats 2xx-only as success, so handle this endpoint manually.
    let resp = http()
        .get(format!("{API}/me/player"))
        .bearer_auth(&tok)
        .send()
        .await?;
    let status = resp.status();
    if status == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !status.is_success() {
        bail!("GET /me/player → {status}");
    }
    let json: Value = resp.json().await?;

    let is_playing = json
        .get("is_playing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let progress_ms = json.get("progress_ms").and_then(|v| v.as_u64());
    let device_id = json
        .get("device")
        .and_then(|d| d.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let volume_percent = json
        .get("device")
        .and_then(|d| d.get("volume_percent"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let mut pb = Playback {
        is_playing,
        progress_ms,
        device_id,
        volume_percent,
        ..Default::default()
    };

    if let Some(item) = json.get("item").filter(|v| !v.is_null()) {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        pb.track = item.get("name").and_then(|v| v.as_str()).map(String::from);
        pb.track_uri = item.get("uri").and_then(|v| v.as_str()).map(String::from);
        pb.duration_ms = item.get("duration_ms").and_then(|v| v.as_u64());
        match item_type {
            "track" => {
                pb.album = item
                    .get("album")
                    .and_then(|a| a.get("name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                // Pick the smallest cover image >= 200px wide so chafa has
                // detail without burning bandwidth on 640px JPEGs.
                pb.album_art_url = item
                    .get("album")
                    .and_then(|a| a.get("images"))
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        let mut best: Option<&serde_json::Value> = None;
                        let mut best_w = u64::MAX;
                        for im in arr {
                            let w = im.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
                            if w >= 200 && w < best_w {
                                best = Some(im);
                                best_w = w;
                            }
                        }
                        best.or_else(|| arr.last())
                            .and_then(|im| im.get("url"))
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });
                pb.artists = item.get("artists").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
                });
            }
            "episode" => {
                pb.album = item
                    .get("show")
                    .and_then(|s| s.get("name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            _ => {
                pb.album = item
                    .get("audiobook")
                    .and_then(|a| a.get("name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
        }
    }
    Ok(Some(pb))
}

pub async fn list_playlists(client: &AuthCodePkceSpotify) -> Result<Vec<PlaylistRef>> {
    let tok = token(client).await?;
    let mut out = Vec::new();
    let mut url = format!("{API}/me/playlists?limit=50");
    loop {
        let json = get_json(&url, &tok).await?;
        if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
            for item in items {
                let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(untitled)")
                    .to_string();
                let owner = item
                    .get("owner")
                    .and_then(|o| o.get("display_name").or_else(|| o.get("id")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Spotify's /me/playlists used to nest the count under
                // `tracks.total`; current responses use `items.total`. Accept
                // either so we tolerate both shapes.
                let track_count = item
                    .get("items")
                    .and_then(|t| t.get("total"))
                    .or_else(|| item.get("tracks").and_then(|t| t.get("total")))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let snapshot_id = item
                    .get("snapshot_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                out.push(PlaylistRef {
                    id: id.to_string(),
                    name,
                    owner,
                    track_count,
                    snapshot_id,
                    min_added_at: None,
                    total_duration_ms: None,
                });
            }
        }
        match json.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }
    Ok(out)
}

pub struct PlaylistTracks {
    pub tracks: Vec<TrackRef>,
    pub total: u32,
    pub min_added_at: Option<String>,
}

pub async fn list_playlist_tracks(
    client: &AuthCodePkceSpotify,
    playlist_id: &str,
) -> Result<PlaylistTracks> {
    let tok = token(client).await?;
    let mut out = Vec::new();
    let mut total: u32 = 0;
    let mut min_added_at: Option<String> = None;
    // Use /playlists/{id}/items, the documented current endpoint.
    // /playlists/{id}/tracks is deprecated and returns 403 for new dev-mode apps.
    let mut url = format!("{API}/playlists/{playlist_id}/items?limit=100");
    loop {
        let json = get_json(&url, &tok).await?;
        if total == 0 {
            total = json.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        }
        if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
            for item in items {
                // Track the earliest added_at for "added since" display.
                if let Some(added) = item.get("added_at").and_then(|v| v.as_str()) {
                    match &min_added_at {
                        None => min_added_at = Some(added.to_string()),
                        Some(cur) if added < cur.as_str() => {
                            min_added_at = Some(added.to_string());
                        }
                        _ => {}
                    }
                }

                // /playlists/{id}/items wraps the track under `item`. The old
                // /tracks endpoint used `track`. Accept either.
                let Some(track) = item
                    .get("item")
                    .or_else(|| item.get("track"))
                    .filter(|v| !v.is_null())
                else {
                    continue;
                };
                let Some(uri) = track.get("uri").and_then(|v| v.as_str()) else {
                    continue;
                };
                let name = track
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(untitled)")
                    .to_string();
                let duration_ms = track.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let item_type = track.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let (artists, album) = if item_type == "episode" {
                    (
                        String::new(),
                        track
                            .get("show")
                            .and_then(|s| s.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    )
                } else {
                    let artists = track
                        .get("artists")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    let album = track
                        .get("album")
                        .and_then(|a| a.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    (artists, album)
                };
                out.push(TrackRef {
                    uri: uri.to_string(),
                    name,
                    artists,
                    album,
                    duration_ms,
                });
            }
        }
        match json.get("next").and_then(|v| v.as_str()) {
            Some(next) if !next.is_empty() => url = next.to_string(),
            _ => break,
        }
    }
    Ok(PlaylistTracks {
        tracks: out,
        total,
        min_added_at,
    })
}

/// Fetch the current user's display name (or id as fallback). Used so the UI can
/// distinguish self-owned playlists from collaborator-owned ones.
pub async fn fetch_me_display_name(client: &AuthCodePkceSpotify) -> Result<String> {
    let tok = token(client).await?;
    let json = get_json(&format!("{API}/me"), &tok).await?;
    let name = json
        .get("display_name")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("id").and_then(|v| v.as_str()))
        .ok_or_else(|| anyhow!("no display_name or id on /me"))?
        .to_string();
    Ok(name)
}

pub async fn probe_playlist_meta(
    client: &AuthCodePkceSpotify,
    playlist_id: &str,
) -> Result<(reqwest::StatusCode, String)> {
    let tok = token(client).await?;
    let resp = http()
        .get(format!("{API}/playlists/{playlist_id}"))
        .bearer_auth(tok)
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body))
}

pub async fn probe_playlist_tracks(
    client: &AuthCodePkceSpotify,
    playlist_id: &str,
) -> Result<(reqwest::StatusCode, String)> {
    let tok = token(client).await?;
    let resp = http()
        .get(format!("{API}/playlists/{playlist_id}/tracks?limit=1"))
        .bearer_auth(tok)
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body))
}

pub async fn probe_playlist_items(
    client: &AuthCodePkceSpotify,
    playlist_id: &str,
) -> Result<(reqwest::StatusCode, String)> {
    let tok = token(client).await?;
    let resp = http()
        .get(format!("{API}/playlists/{playlist_id}/items?limit=2"))
        .bearer_auth(tok)
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body))
}

pub async fn search_tracks(
    client: &AuthCodePkceSpotify,
    query: &str,
    limit: u32,
) -> Result<Vec<TrackRef>> {
    let tok = token(client).await?;
    let url = format!(
        "{API}/search?q={}&type=track&limit={}",
        urlencoding::encode(query),
        limit.min(50)
    );
    let json = get_json(&url, &tok).await?;
    let mut out = Vec::new();
    if let Some(items) = json
        .get("tracks")
        .and_then(|t| t.get("items"))
        .and_then(|v| v.as_array())
    {
        for track in items {
            let Some(uri) = track.get("uri").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = track
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("(untitled)")
                .to_string();
            let duration_ms = track.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let artists = track
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let album = track
                .get("album")
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            out.push(TrackRef {
                uri: uri.to_string(),
                name,
                artists,
                album,
                duration_ms,
            });
        }
    }
    Ok(out)
}

pub async fn fetch_queue(client: &AuthCodePkceSpotify) -> Result<Vec<TrackRef>> {
    let tok = token(client).await?;
    let json = get_json(&format!("{API}/me/player/queue"), &tok).await?;
    let mut out = Vec::new();
    if let Some(items) = json.get("queue").and_then(|v| v.as_array()) {
        for track in items {
            if track.is_null() {
                continue;
            }
            let Some(uri) = track.get("uri").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = track
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("(untitled)")
                .to_string();
            let duration_ms = track.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let item_type = track.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let artists = if item_type == "track" {
                track
                    .get("artists")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let album = if item_type == "track" {
                track
                    .get("album")
                    .and_then(|a| a.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                track
                    .get("show")
                    .and_then(|s| s.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            out.push(TrackRef {
                uri: uri.to_string(),
                name,
                artists,
                album,
                duration_ms,
            });
        }
    }
    Ok(out)
}

pub async fn add_to_queue(
    client: &AuthCodePkceSpotify,
    track_uri: &str,
    device_id: Option<&str>,
) -> Result<()> {
    let tok = token(client).await?;
    let mut url = format!(
        "{API}/me/player/queue?uri={}",
        urlencoding::encode(track_uri)
    );
    if let Some(id) = device_id {
        url.push_str(&format!("&device_id={id}"));
    }
    let resp = http()
        .post(&url)
        .bearer_auth(&tok)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("POST /me/player/queue → {status}: {body}");
    }
    Ok(())
}

pub async fn add_tracks_to_playlist(
    client: &AuthCodePkceSpotify,
    playlist_id: &str,
    uris: &[String],
) -> Result<()> {
    if uris.is_empty() {
        return Ok(());
    }
    let tok = token(client).await?;
    // Spotify caps at 100 URIs per call.
    for chunk in uris.chunks(100) {
        let body = serde_json::json!({ "uris": chunk });
        let resp = http()
            .post(format!("{API}/playlists/{playlist_id}/tracks"))
            .bearer_auth(&tok)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("POST /playlists/{playlist_id}/tracks → {status}: {body}");
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct DeviceRef {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub is_active: bool,
    pub volume_percent: Option<u32>,
}

pub async fn list_devices(client: &AuthCodePkceSpotify) -> Result<Vec<DeviceRef>> {
    let tok = token(client).await?;
    let json = get_json(&format!("{API}/me/player/devices"), &tok).await?;
    let mut out = Vec::new();
    if let Some(arr) = json.get("devices").and_then(|v| v.as_array()) {
        for d in arr {
            let Some(id) = d.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            out.push(DeviceRef {
                id: id.to_string(),
                name: d
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string(),
                kind: d
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string(),
                is_active: d.get("is_active").and_then(|v| v.as_bool()).unwrap_or(false),
                volume_percent: d
                    .get("volume_percent")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32),
            });
        }
    }
    Ok(out)
}

pub async fn transfer_to_device(
    client: &AuthCodePkceSpotify,
    device_id: &str,
    play: bool,
) -> Result<()> {
    let tok = token(client).await?;
    let body = serde_json::json!({
        "device_ids": [device_id],
        "play": play,
    });
    let resp = http()
        .put(format!("{API}/me/player"))
        .bearer_auth(&tok)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("PUT /me/player → {status}: {body}");
    }
    Ok(())
}

pub async fn seek_to(
    client: &AuthCodePkceSpotify,
    position_ms: i64,
    device_id: Option<&str>,
) -> Result<()> {
    let tok = token(client).await?;
    let pos = position_ms.max(0) as u64;
    let mut url = format!("{API}/me/player/seek?position_ms={pos}");
    if let Some(id) = device_id {
        url.push_str(&format!("&device_id={id}"));
    }
    let resp = http()
        .put(&url)
        .bearer_auth(&tok)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("PUT /me/player/seek → {status}: {body}");
    }
    Ok(())
}

pub async fn set_volume(
    client: &AuthCodePkceSpotify,
    volume_percent: u32,
    device_id: Option<&str>,
) -> Result<()> {
    let tok = token(client).await?;
    let mut url = format!(
        "{API}/me/player/volume?volume_percent={}",
        volume_percent.min(100)
    );
    if let Some(id) = device_id {
        url.push_str(&format!("&device_id={id}"));
    }
    let resp = http()
        .put(&url)
        .bearer_auth(&tok)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("PUT /me/player/volume → {status}: {body}");
    }
    Ok(())
}

pub async fn play_uris(
    client: &AuthCodePkceSpotify,
    uris: &[String],
    device_id: Option<&str>,
) -> Result<()> {
    let tok = token(client).await?;
    let mut url = format!("{API}/me/player/play");
    if let Some(id) = device_id {
        url.push_str(&format!("?device_id={id}"));
    }
    let body = serde_json::json!({ "uris": uris });
    let resp = http()
        .put(&url)
        .bearer_auth(&tok)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("PUT /me/player/play → {status}: {body}");
    }
    Ok(())
}

pub async fn play_in_context(
    client: &AuthCodePkceSpotify,
    context_uri: &str,
    track_uri: &str,
    device_id: Option<&str>,
) -> Result<()> {
    let tok = token(client).await?;
    let mut url = format!("{API}/me/player/play");
    if let Some(id) = device_id {
        url.push_str(&format!("?device_id={id}"));
    }
    let body = serde_json::json!({
        "context_uri": context_uri,
        "offset": { "uri": track_uri },
    });
    let resp = http()
        .put(&url)
        .bearer_auth(&tok)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("PUT /me/player/play → {status}: {body}");
    }
    Ok(())
}
