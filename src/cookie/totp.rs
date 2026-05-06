//! TOTP for the cookie-auth flow.
//!
//! Spotify added a TOTP gate to `open.spotify.com/api/token` in March 2025.
//! The secret is published per-version; we fetch the latest from public
//! mirrors, fall back to a hardcoded version on offline, and accept an
//! override via `SPOTUI_TOTP_SECRET_URL` when Spotify rotates faster than
//! we ship.
//!
//! Algorithm (mirrors `openclaw/spogo` `internal/spotify/totp.go`):
//! 1. XOR each byte of the published secret with `(i % 33) + 9`.
//! 2. Concatenate the resulting bytes' decimal representations into an ASCII
//!    string. This string is the HOTP/TOTP key.
//! 3. HMAC-SHA1 the key against the 30s counter, take 6 digits per RFC 6238.
//!
//! Counter-intuitively, step 2 means the key is *not* the raw bytes — it's
//! the digit-string form. spogo does this and it's required for Spotify to
//! accept the code.
//!
//! Step 1's mask `(i % 33) + 9` is also from spogo; the published "secret"
//! is mildly obfuscated and this XOR de-obfuscates it.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;

const SECRET_ENV: &str = "SPOTUI_TOTP_SECRET_URL";
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const STEP_SECS: u64 = 30;
const DIGITS: usize = 6;
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// Hardcoded fallback (version 18). Used when no remote secret is reachable
/// and cache is empty. Bumped when Spotify rotates and we ship a release.
const FALLBACK_VERSION: u32 = 18;
const FALLBACK_SECRET: &[u8] = &[
    70, 60, 33, 57, 92, 120, 90, 33, 32, 62, 62, 55, 126, 93, 66, 35, 108, 68,
];

/// Mirror list, tried in order. Same set spogo uses.
const SECRET_URLS: &[&str] = &[
    "https://github.com/xyloflake/spot-secrets-go/raw/main/secrets/secretDict.json",
    "https://github.com/Thereallo1026/spotify-secrets/raw/main/secrets/secretDict.json",
];

#[derive(Clone)]
struct Cached {
    version: u32,
    secret: Vec<u8>,
    expires: SystemTime,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// Generate the current TOTP code and return `(code, version)`. The version
/// must be sent back to Spotify alongside the code (`totpVer` query param).
pub async fn generate(http: &reqwest::Client) -> Result<(String, u32)> {
    let (version, secret) = load_secret(http).await;
    let now = SystemTime::now();
    let code = totp_from_secret(&secret, now)?;
    Ok((code, version))
}

async fn load_secret(http: &reqwest::Client) -> (u32, Vec<u8>) {
    if let Some(cached) = read_cache() {
        return (cached.version, cached.secret);
    }
    match fetch_remote(http).await {
        Ok((v, s)) => {
            write_cache(v, &s);
            (v, s)
        }
        Err(e) => {
            tracing::warn!("totp secret fetch failed, using fallback: {e:#}");
            (FALLBACK_VERSION, FALLBACK_SECRET.to_vec())
        }
    }
}

fn read_cache() -> Option<Cached> {
    let guard = CACHE.lock().ok()?;
    let c = guard.as_ref()?;
    if SystemTime::now() < c.expires {
        Some(c.clone())
    } else {
        None
    }
}

fn write_cache(version: u32, secret: &[u8]) {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cached {
            version,
            secret: secret.to_vec(),
            expires: SystemTime::now() + CACHE_TTL,
        });
    }
}

async fn fetch_remote(http: &reqwest::Client) -> Result<(u32, Vec<u8>)> {
    let urls = source_urls();
    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        match fetch_one(http, &url).await {
            Ok(out) => return Ok(out),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no totp secret sources available")))
}

fn source_urls() -> Vec<String> {
    if let Ok(v) = std::env::var(SECRET_ENV) {
        let v = v.trim();
        if !v.is_empty() {
            return vec![v.to_string()];
        }
    }
    SECRET_URLS.iter().map(|s| s.to_string()).collect()
}

async fn fetch_one(http: &reqwest::Client, url: &str) -> Result<(u32, Vec<u8>)> {
    if let Some(path) = url.strip_prefix("file://") {
        let body = std::fs::read_to_string(path)
            .with_context(|| format!("read totp secret file {path}"))?;
        return parse_secret_dict(&body);
    }
    let resp = http
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("{url} → {status}");
    }
    let body = resp.text().await.context("read totp secret body")?;
    parse_secret_dict(&body)
}

#[derive(Deserialize)]
#[serde(transparent)]
struct SecretDict(std::collections::HashMap<String, Vec<i64>>);

/// The published format is `{ "<version>": [<int byte>, ...], ... }`. Pick
/// the highest-numbered version present.
fn parse_secret_dict(body: &str) -> Result<(u32, Vec<u8>)> {
    let dict: SecretDict = serde_json::from_str(body).context("parse secretDict.json")?;
    let mut best_ver: i64 = -1;
    let mut best: Vec<i64> = vec![];
    for (k, v) in dict.0 {
        let Ok(n) = k.parse::<i64>() else {
            continue;
        };
        if n > best_ver && !v.is_empty() {
            best_ver = n;
            best = v;
        }
    }
    if best_ver < 0 || best.is_empty() {
        bail!("no usable secret in dict");
    }
    let mut out = Vec::with_capacity(best.len());
    for b in best {
        if !(0..=255).contains(&b) {
            bail!("byte {b} out of range");
        }
        out.push(b as u8);
    }
    Ok((best_ver as u32, out))
}

/// Derive the TOTP code given a published-secret byte sequence and the
/// current time. Pulled out so unit tests can pin a time and a known secret.
pub fn totp_from_secret(secret: &[u8], now: SystemTime) -> Result<String> {
    if secret.is_empty() {
        bail!("totp secret empty");
    }
    // Step 1: XOR each byte with `(i % 33) + 9`.
    let mut transformed = Vec::with_capacity(secret.len());
    for (i, b) in secret.iter().enumerate() {
        let mask = ((i % 33) + 9) as u8;
        transformed.push(*b ^ mask);
    }
    // Step 2: ASCII digit string of those byte values, concatenated.
    let mut joined = String::with_capacity(secret.len() * 3);
    for b in &transformed {
        joined.push_str(&b.to_string());
    }
    // Step 3: HOTP at 30s counter.
    let unix = now
        .duration_since(UNIX_EPOCH)
        .context("system time before unix epoch")?
        .as_secs();
    Ok(hotp(joined.as_bytes(), unix / STEP_SECS))
}

fn hotp(key: &[u8], counter: u64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(&counter.to_be_bytes());
    let sum = mac.finalize().into_bytes();
    let offset = (sum[sum.len() - 1] & 0x0f) as usize;
    let bin = ((sum[offset] as u32 & 0x7f) << 24)
        | ((sum[offset + 1] as u32 & 0xff) << 16)
        | ((sum[offset + 2] as u32 & 0xff) << 8)
        | (sum[offset + 3] as u32 & 0xff);
    let code = bin % 10u32.pow(DIGITS as u32);
    format!("{:0width$}", code, width = DIGITS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 / RFC 4226 standard TOTP test vectors. spogo uses the same
    /// set in `internal/spotify/totp_test.go` — if these pass we know the
    /// HMAC-SHA1 + dynamic-truncation core is correct.
    #[test]
    fn rfc6238_known_vectors() {
        let key = b"12345678901234567890";
        let cases: &[(u64, &str)] = &[
            (59, "287082"),
            (1_111_111_109, "081804"),
            (1_111_111_111, "050471"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ];
        for (ts, want) in cases {
            let got = hotp(key, ts / STEP_SECS);
            assert_eq!(&got, want, "ts={ts}");
        }
    }

    /// Same secret + same time should always yield the same code. Catches
    /// non-determinism if anyone edits the transform later.
    #[test]
    fn deterministic_for_fixed_time() {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let a = totp_from_secret(FALLBACK_SECRET, now).unwrap();
        let b = totp_from_secret(FALLBACK_SECRET, now).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn parse_secret_dict_picks_highest_version() {
        let body = r#"{"17":[1,2,3],"19":[10,20,30],"18":[7,8,9]}"#;
        let (v, s) = parse_secret_dict(body).unwrap();
        assert_eq!(v, 19);
        assert_eq!(s, vec![10, 20, 30]);
    }

    #[test]
    fn parse_secret_dict_rejects_out_of_range() {
        let body = r#"{"1":[300]}"#;
        assert!(parse_secret_dict(body).is_err());
    }
}
