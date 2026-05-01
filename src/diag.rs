use anyhow::Result;
use rspotify::AuthCodePkceSpotify;
use rspotify::clients::OAuthClient;
use rspotify::model::{AdditionalType, PlayableItem};

pub async fn run(spotify: AuthCodePkceSpotify) -> Result<()> {
    println!("\n=== spotui diagnostic ===\n");

    // 1. Token
    {
        let tok = spotify.token.lock().await.unwrap();
        match &*tok {
            Some(t) => {
                let mut scopes: Vec<_> = t.scopes.iter().cloned().collect();
                scopes.sort();
                println!(
                    "[token] expires_at={:?} scopes={}",
                    t.expires_at, scopes.len()
                );
                for s in &scopes {
                    println!("        - {s}");
                }
            }
            None => println!("[token] none"),
        }
    }

    // 2. Identity
    println!();
    match spotify.current_user().await {
        Ok(u) => {
            println!("[me] id={} display_name={:?}", u.id, u.display_name);
            println!("     email={:?} country={:?} product={:?}", u.email, u.country, u.product);
        }
        Err(e) => println!("[me] error: {e}"),
    }

    // 3. Devices
    println!();
    match spotify.device().await {
        Ok(devs) if devs.is_empty() => {
            println!("[devices] none — open the Spotify desktop app or a web player");
        }
        Ok(devs) => {
            println!("[devices] {} found", devs.len());
            for d in &devs {
                println!(
                    "  - name={:?} type={:?} id={:?} active={} restricted={} private_session={} volume={:?}",
                    d.name,
                    d._type,
                    d.id,
                    d.is_active,
                    d.is_restricted,
                    d.is_private_session,
                    d.volume_percent
                );
            }
        }
        Err(e) => println!("[devices] error: {e}"),
    }

    // 4. Current playback
    println!();
    match spotify
        .current_playback(None, Some([&AdditionalType::Track]))
        .await
    {
        Ok(None) => println!("[playback] no current playback context"),
        Ok(Some(cp)) => {
            println!(
                "[playback] is_playing={} device.name={:?} device.id={:?} progress_ms={:?}",
                cp.is_playing,
                cp.device.name,
                cp.device.id,
                cp.progress.map(|d| d.num_milliseconds())
            );
            match cp.item {
                Some(PlayableItem::Track(t)) => {
                    println!(
                        "  track: {:?} by {:?}",
                        t.name,
                        t.artists.iter().map(|a| &a.name).collect::<Vec<_>>()
                    );
                }
                Some(PlayableItem::Episode(ep)) => {
                    println!("  episode: {:?}", ep.name);
                }
                None => println!("  item: none"),
            }
        }
        Err(e) => println!("[playback] error: {e}"),
    }

    // 5. Trial pause/resume to surface the real error
    println!();
    println!("[trial] attempting pause_playback(None)...");
    match spotify.pause_playback(None).await {
        Ok(_) => println!("  ok"),
        Err(e) => {
            println!("  failed: {e}");
            println!("  debug: {e:#?}");
        }
    }

    println!();
    println!("[trial] attempting resume_playback(None, None)...");
    match spotify.resume_playback(None, None).await {
        Ok(_) => println!("  ok"),
        Err(e) => {
            println!("  failed: {e}");
            println!("  debug: {e:#?}");
        }
    }

    // 6. Playlists
    println!();
    match crate::spotify::list_playlists(&spotify).await {
        Ok(ps) => {
            println!("[playlists] {} returned by /me/playlists", ps.len());
            let mut spotify_owned = 0usize;
            let mut user_owned = 0usize;
            for p in &ps {
                if p.owner.eq_ignore_ascii_case("Spotify") {
                    spotify_owned += 1;
                } else {
                    user_owned += 1;
                }
            }
            println!(
                "  user-owned: {user_owned}   spotify-owned: {spotify_owned} (will 403 in dev mode)"
            );
            for p in ps.iter().take(20) {
                println!(
                    "  - id={} owner={:?} tracks={} name={:?}",
                    p.id, p.owner, p.track_count, p.name
                );
            }
            if ps.len() > 20 {
                println!("  ... and {} more", ps.len() - 20);
            }
        }
        Err(e) => println!("[playlists] error: {e}"),
    }

    // 7. Probe playlist endpoints with the first user-owned playlist
    println!();
    if let Ok(ps) = crate::spotify::list_playlists(&spotify).await {
        let user_owned = ps.iter().find(|p| !p.owner.eq_ignore_ascii_case("Spotify"));
        if let Some(p) = user_owned {
            println!(
                "[probe] using playlist id={} owner={:?} name={:?}",
                p.id, p.owner, p.name
            );

            match crate::spotify::probe_playlist_meta(&spotify, &p.id).await {
                Ok((status, body)) => {
                    println!("[probe] GET /playlists/{{id}} → {status}");
                    if !status.is_success() {
                        println!("  body: {body}");
                    }
                }
                Err(e) => println!("[probe] meta error: {e}"),
            }

            match crate::spotify::probe_playlist_tracks(&spotify, &p.id).await {
                Ok((status, body)) => {
                    println!("[probe] GET /playlists/{{id}}/tracks → {status}");
                    if !status.is_success() {
                        println!("  body: {body}");
                    }
                }
                Err(e) => println!("[probe] tracks error: {e}"),
            }

            match crate::spotify::probe_playlist_items(&spotify, &p.id).await {
                Ok((status, body)) => {
                    println!("[probe] GET /playlists/{{id}}/items → {status}");
                    println!("  body (first ~2KB):");
                    let snippet = if body.len() > 2048 { &body[..2048] } else { &body };
                    println!("{snippet}");
                }
                Err(e) => println!("[probe] items error: {e}"),
            }
        } else {
            println!("[probe] no user-owned playlists found to probe with");
        }
    }

    println!("\n=== end diagnostic ===\n");
    Ok(())
}
