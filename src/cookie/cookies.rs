//! Where the `sp_dc` / `sp_t` / `sp_key` cookies come from.
//!
//! Phase 1 ships two sources:
//! - `PasteSource` — manual `key=value` lines, fed by `spotui auth paste`.
//! - `FileSource` — JSON file written by an earlier paste/import, so the
//!   cookies survive between launches.
//!
//! Phase 1.5 will add `SafariSource` (binarycookies parser). The trait is
//! `async` because future sources may need IO (Keychain, network).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

/// One name/value pair from the browser's `.spotify.com` cookie jar.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpotifyCookie {
    pub name: String,
    pub value: String,
}

/// Anything that can hand us a fresh-enough set of cookies. Implementations
/// must return `sp_dc` at minimum; `sp_t` (Connect device id) and `sp_key`
/// (some flows want it) are optional.
pub trait CookieSource: Send + Sync {
    fn cookies(&self) -> Result<Vec<SpotifyCookie>>;
}

/// In-memory bag of cookies, typically populated from interactive paste.
#[derive(Clone, Debug, Default)]
pub struct PasteSource {
    cookies: Vec<SpotifyCookie>,
}

impl PasteSource {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse a single line in either `name=value` or `name: value` form.
    /// Whitespace and a trailing semicolon are trimmed.
    pub fn add_line(&mut self, line: &str) -> Result<()> {
        let line = line.trim().trim_end_matches(';').trim();
        if line.is_empty() {
            return Ok(());
        }
        let (name, value) = if let Some((n, v)) = line.split_once('=') {
            (n.trim(), v.trim())
        } else if let Some((n, v)) = line.split_once(':') {
            (n.trim(), v.trim())
        } else {
            bail!("expected `name=value`, got: {line}");
        };
        if name.is_empty() || value.is_empty() {
            bail!("empty name or value in: {line}");
        }
        self.cookies.push(SpotifyCookie {
            name: name.to_string(),
            value: value.to_string(),
        });
        Ok(())
    }

    pub fn has_sp_dc(&self) -> bool {
        self.cookies.iter().any(|c| c.name == "sp_dc")
    }

    pub fn into_inner(self) -> Vec<SpotifyCookie> {
        self.cookies
    }
}

impl CookieSource for PasteSource {
    fn cookies(&self) -> Result<Vec<SpotifyCookie>> {
        if !self.has_sp_dc() {
            bail!("paste source missing required `sp_dc` cookie");
        }
        Ok(self.cookies.clone())
    }
}

/// On-disk JSON store under `~/Library/Application Support/spotui/`.
#[derive(Clone, Debug)]
pub struct FileSource {
    path: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct StoredCookies {
    cookies: Vec<SpotifyCookie>,
}

impl FileSource {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self, cookies: &[SpotifyCookie]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let body = serde_json::to_string_pretty(&StoredCookies {
            cookies: cookies.to_vec(),
        })?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("rename to {}", self.path.display()))?;
        // Best-effort 0600 on Unix so the cookie isn't world-readable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.path) {
                let mut p = meta.permissions();
                p.set_mode(0o600);
                let _ = fs::set_permissions(&self.path, p);
            }
        }
        Ok(())
    }
}

impl CookieSource for FileSource {
    fn cookies(&self) -> Result<Vec<SpotifyCookie>> {
        if !self.path.exists() {
            return Err(anyhow!(
                "no cookies on disk at {} (run `spotui auth paste` first)",
                self.path.display()
            ));
        }
        let body = fs::read_to_string(&self.path)
            .with_context(|| format!("read {}", self.path.display()))?;
        let stored: StoredCookies =
            serde_json::from_str(&body).context("parse cookies file")?;
        if !stored.cookies.iter().any(|c| c.name == "sp_dc") {
            bail!("stored cookies missing `sp_dc`");
        }
        Ok(stored.cookies)
    }
}

/// Convenience: extract a named cookie by `&str` lookup.
pub fn find_cookie<'a>(cookies: &'a [SpotifyCookie], name: &str) -> Option<&'a str> {
    cookies
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.value.as_str())
}

/// Reduce a cookies vec to the `Cookie:` header value for `open.spotify.com`.
pub fn to_header_value(cookies: &[SpotifyCookie]) -> String {
    // De-dup by name (later wins) before joining so a re-paste doesn't
    // produce two `sp_dc=` segments.
    let mut by_name: HashMap<&str, &str> = HashMap::new();
    for c in cookies {
        by_name.insert(c.name.as_str(), c.value.as_str());
    }
    by_name
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_source_parses_eq_form() {
        let mut s = PasteSource::new();
        s.add_line("sp_dc=AABBCC").unwrap();
        s.add_line("sp_t=device_id; ").unwrap();
        assert!(s.has_sp_dc());
        let inner = s.into_inner();
        assert_eq!(inner.len(), 2);
        assert_eq!(inner[0].name, "sp_dc");
        assert_eq!(inner[0].value, "AABBCC");
        assert_eq!(inner[1].name, "sp_t");
        assert_eq!(inner[1].value, "device_id");
    }

    #[test]
    fn paste_source_parses_colon_form() {
        let mut s = PasteSource::new();
        s.add_line("sp_dc: AABBCC").unwrap();
        assert_eq!(s.into_inner()[0].value, "AABBCC");
    }

    #[test]
    fn paste_source_rejects_garbage() {
        let mut s = PasteSource::new();
        assert!(s.add_line("noequals").is_err());
        assert!(s.add_line("=novalue").is_err());
    }

    #[test]
    fn paste_source_requires_sp_dc() {
        let mut s = PasteSource::new();
        s.add_line("sp_t=foo").unwrap();
        assert!(<PasteSource as CookieSource>::cookies(&s).is_err());
    }

    #[test]
    fn header_value_dedups_by_name() {
        let cs = vec![
            SpotifyCookie {
                name: "sp_dc".into(),
                value: "old".into(),
            },
            SpotifyCookie {
                name: "sp_dc".into(),
                value: "new".into(),
            },
        ];
        let header = to_header_value(&cs);
        assert_eq!(header, "sp_dc=new");
    }
}
