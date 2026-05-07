//! Resolve the host's Tailscale IPv4 address.
//!
//! The HTTP server binds to this address and *only* this address. If
//! Tailscale isn't up, we refuse to serve — there is no LAN fallback.
//! See MERGE_PLAN.md (Phase 0).

use std::net::Ipv4Addr;

use anyhow::{anyhow, Result};

/// Tailscale's CGNAT range. Every Tailnet IPv4 falls inside this block,
/// so we use it as the second check after the interface name match.
/// (RFC 6598 calls this 100.64.0.0/10.)
const CGNAT_FIRST_OCTET: u8 = 100;
const CGNAT_SECOND_OCTET_MIN: u8 = 64;
const CGNAT_SECOND_OCTET_MAX: u8 = 127;

/// Returns the IPv4 address assigned to the `tailscale0` interface.
///
/// Errors when the interface is missing, has no IPv4, or has an address
/// outside the CGNAT range — any of which means we shouldn't be exposing
/// the server.
pub fn resolve() -> Result<Ipv4Addr> {
    let addrs = if_addrs::get_if_addrs()
        .map_err(|e| anyhow!("failed to enumerate network interfaces: {e}"))?;

    let mut saw_interface = false;
    for a in &addrs {
        if a.name != "tailscale0" {
            continue;
        }
        saw_interface = true;
        if let std::net::IpAddr::V4(ip) = a.ip() {
            if !is_cgnat(ip) {
                return Err(anyhow!(
                    "tailscale0 has IPv4 {ip}, which is outside 100.64.0.0/10 \
                     (Tailscale CGNAT). Refusing to bind."
                ));
            }
            return Ok(ip);
        }
    }

    if saw_interface {
        Err(anyhow!(
            "tailscale0 exists but has no IPv4 address. Is Tailscale logged in?"
        ))
    } else {
        Err(anyhow!(
            "tailscale0 interface not found. Start Tailscale before running \
             `spotui serve`."
        ))
    }
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == CGNAT_FIRST_OCTET && (CGNAT_SECOND_OCTET_MIN..=CGNAT_SECOND_OCTET_MAX).contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgnat_range() {
        assert!(is_cgnat(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_cgnat(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_cgnat(Ipv4Addr::new(100, 63, 0, 1)));
        assert!(!is_cgnat(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_cgnat(Ipv4Addr::new(192, 168, 1, 1)));
    }
}
