use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::app::{PlaylistRef, TrackRef};

#[derive(Serialize, Deserialize)]
struct PlaylistsFile {
    version: u32,
    fetched_at_unix: u64,
    playlists: Vec<PlaylistRef>,
}

#[derive(Serialize, Deserialize)]
struct TracksFile {
    version: u32,
    snapshot_id: String,
    tracks: Vec<TrackRef>,
}

const VERSION: u32 = 1;

pub struct Cache {
    pub root: PathBuf,
}

impl Cache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn playlists_path(&self) -> PathBuf {
        self.root.join("playlists.json")
    }

    fn tracks_dir(&self) -> PathBuf {
        self.root.join("tracks")
    }

    fn tracks_path(&self, playlist_id: &str) -> PathBuf {
        self.tracks_dir().join(format!("{playlist_id}.json"))
    }

    pub fn load_playlists(&self) -> Option<(Duration, Vec<PlaylistRef>)> {
        let path = self.playlists_path();
        if !path.exists() {
            return None;
        }
        let body = fs::read_to_string(&path).ok()?;
        let file: PlaylistsFile = serde_json::from_str(&body).ok()?;
        if file.version != VERSION {
            return None;
        }
        let age = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .checked_sub(Duration::from_secs(file.fetched_at_unix))
            .unwrap_or(Duration::ZERO);
        Some((age, file.playlists))
    }

    pub fn save_playlists(&self, playlists: &[PlaylistRef]) -> Result<()> {
        ensure_dir(&self.root)?;
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let file = PlaylistsFile {
            version: VERSION,
            fetched_at_unix: now,
            playlists: playlists.to_vec(),
        };
        write_atomic(
            &self.playlists_path(),
            serde_json::to_string(&file)?.as_bytes(),
        )
    }

    pub fn load_tracks(&self, playlist_id: &str, expected_snapshot: &str) -> Option<Vec<TrackRef>> {
        let path = self.tracks_path(playlist_id);
        if !path.exists() {
            return None;
        }
        let body = fs::read_to_string(&path).ok()?;
        let file: TracksFile = serde_json::from_str(&body).ok()?;
        if file.version != VERSION {
            return None;
        }
        if !expected_snapshot.is_empty() && file.snapshot_id != expected_snapshot {
            return None;
        }
        Some(file.tracks)
    }

    pub fn save_tracks(
        &self,
        playlist_id: &str,
        snapshot_id: &str,
        tracks: &[TrackRef],
    ) -> Result<()> {
        ensure_dir(&self.tracks_dir())?;
        let file = TracksFile {
            version: VERSION,
            snapshot_id: snapshot_id.to_string(),
            tracks: tracks.to_vec(),
        };
        write_atomic(
            &self.tracks_path(playlist_id),
            serde_json::to_string(&file)?.as_bytes(),
        )
    }
}

fn ensure_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    }
    Ok(())
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}
