//! Cookie-auth backend (phase 1).
//!
//! Reads `sp_dc` (and friends) from the user's browser, mints a web-player
//! access token at `open.spotify.com/api/token`, and exposes it for the
//! internal Spotify endpoints (`spclient`, `pathfinder`, `connect-state`,
//! `dealer`). See [`PLAN.md`](../../../PLAN.md) for phase scope.

pub mod cookies;
pub mod token;
mod totp;

pub use cookies::{CookieSource, FileSource, PasteSource, SpotifyCookie};
pub use token::{CookieTokenProvider, WebToken};
