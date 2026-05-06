//! Mints a web-player access token from the `sp_dc` cookie.
//!
//! Hits `https://open.spotify.com/api/token` with the cookie jar attached,
//! the TOTP code from `super::totp`, and a browser-shaped header set. The
//! response token has elevated scopes vs. PKCE — it can call the internal
//! `spclient` / Pathfinder / `connect-state` endpoints. Lifetime ~1 hour.
//!
//! Direct port of `openclaw/spogo` `internal/spotify/token.go`. The one
//! non-obvious detail is the `totpServer` query param: spogo sets it to the
//! same code as `totp` and that's what currently passes Spotify's check.

use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

use super::cookies::{CookieSource, to_header_value};
use super::totp;

const TOKEN_URL: &str = "https://open.spotify.com/api/token";
const APP_PLATFORM: &str = "WebPlayer";
const ACCEPT_LANG: &str = "en-US,en;q=0.9";
const SEC_CH_UA: &str =
    "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\"";
const REFRESH_SLACK: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct WebToken {
    pub access_token: String,
    pub expires_at: SystemTime,
    pub anonymous: bool,
    pub client_id: String,
}

impl WebToken {
    pub fn is_fresh(&self) -> bool {
        SystemTime::now() + REFRESH_SLACK < self.expires_at
    }
}

/// Mints + caches a `WebToken` from a cookie source. Cheap to clone; the
/// caller is expected to hold one of these for the process lifetime.
pub struct CookieTokenProvider {
    http: reqwest::Client,
    source: Box<dyn CookieSource>,
    cached: tokio::sync::Mutex<Option<WebToken>>,
}

impl CookieTokenProvider {
    pub fn new(http: reqwest::Client, source: Box<dyn CookieSource>) -> Self {
        Self {
            http,
            source,
            cached: tokio::sync::Mutex::new(None),
        }
    }

    /// Returns a fresh `WebToken`. Re-uses the in-memory cache if the cached
    /// token has more than `REFRESH_SLACK` of life left.
    pub async fn token(&self) -> Result<WebToken> {
        {
            let guard = self.cached.lock().await;
            if let Some(t) = guard.as_ref() {
                if t.is_fresh() {
                    return Ok(t.clone());
                }
            }
        }
        let fresh = self.mint().await?;
        let mut guard = self.cached.lock().await;
        *guard = Some(fresh.clone());
        Ok(fresh)
    }

    async fn mint(&self) -> Result<WebToken> {
        let cookies = self.source.cookies().context("read cookies for mint")?;
        let cookie_header = to_header_value(&cookies);

        let (totp_code, totp_ver) = totp::generate(&self.http).await?;

        let url = format!(
            "{TOKEN_URL}?reason=init&productType=web-player&totp={code}&totpVer={ver}&totpServer={code}",
            code = totp_code,
            ver = totp_ver,
        );

        let resp = self
            .http
            .get(&url)
            .header("Cookie", &cookie_header)
            .header("Accept", "application/json")
            .header("Accept-Language", ACCEPT_LANG)
            .header("App-Platform", APP_PLATFORM)
            .header("Origin", "https://open.spotify.com")
            .header("Referer", "https://open.spotify.com/")
            .header("Sec-Fetch-Site", "same-origin")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-CH-UA", SEC_CH_UA)
            .header("Sec-CH-UA-Platform", "\"macOS\"")
            .header("Sec-CH-UA-Mobile", "?0")
            .send()
            .await
            .context("POST token endpoint")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!("token mint {status}: {body}");
        }

        let payload: TokenResponse = resp.json().await.context("parse token JSON")?;
        if payload.access_token.is_empty() {
            bail!("token response missing accessToken");
        }

        let expires_at = if payload.access_token_expiration_timestamp_ms > 0 {
            // Spotify returns a millis-since-epoch absolute timestamp; use it
            // verbatim so we don't drift relative to the server clock.
            let secs = (payload.access_token_expiration_timestamp_ms / 1000) as u64;
            let nanos = ((payload.access_token_expiration_timestamp_ms % 1000) as u32) * 1_000_000;
            SystemTime::UNIX_EPOCH + Duration::new(secs, nanos)
        } else if payload.expires_in > 0 {
            SystemTime::now() + Duration::from_secs(payload.expires_in as u64)
        } else {
            return Err(anyhow!("token response had no expiry"));
        };

        Ok(WebToken {
            access_token: payload.access_token,
            expires_at,
            anonymous: payload.is_anonymous,
            client_id: payload.client_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    access_token_expiration_timestamp_ms: i64,
    #[serde(default)]
    is_anonymous: bool,
    #[serde(default)]
    client_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_token_freshness() {
        let now = SystemTime::now();
        let fresh = WebToken {
            access_token: "x".into(),
            expires_at: now + Duration::from_secs(120),
            anonymous: false,
            client_id: "id".into(),
        };
        assert!(fresh.is_fresh());

        let stale = WebToken {
            access_token: "x".into(),
            expires_at: now + Duration::from_secs(10),
            anonymous: false,
            client_id: "id".into(),
        };
        assert!(!stale.is_fresh());
    }

    #[test]
    fn token_response_deserialize_camelcase() {
        let body = r#"{
            "accessToken":"BQ...",
            "expiresIn":3600,
            "accessTokenExpirationTimestampMs":1700000000000,
            "isAnonymous":false,
            "clientId":"abc"
        }"#;
        let parsed: TokenResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.access_token, "BQ...");
        assert_eq!(parsed.expires_in, 3600);
        assert_eq!(parsed.access_token_expiration_timestamp_ms, 1_700_000_000_000);
        assert!(!parsed.is_anonymous);
        assert_eq!(parsed.client_id, "abc");
    }
}
