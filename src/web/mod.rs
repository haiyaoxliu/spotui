//! HTTP server side of the merged binary. Bound exclusively to the host's
//! Tailscale interface. See MERGE_PLAN.md (Phase 0) for the security
//! posture.

pub mod server;
pub mod tailscale;

pub use server::run;
