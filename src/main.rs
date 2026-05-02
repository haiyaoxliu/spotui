mod app;
mod auth;
mod cache;
mod config;
mod diag;
mod jam;
mod jam_net;
mod spotify;
mod ui;

use anyhow::Result;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let paths = config::Paths::resolve()?;
    config::ensure_dirs(&paths)?;
    init_logging(&paths)?;

    let cfg = match config::load_or_create(&paths) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let spotify = auth::authenticate(&cfg, &paths).await?;

    if std::env::args().any(|a| a == "--diag") {
        diag::run(spotify).await?;
        return Ok(());
    }

    let cache = cache::Cache::new(paths.cache_root.clone());

    app::run(spotify, cfg, paths, cache).await?;
    Ok(())
}

fn init_logging(paths: &config::Paths) -> Result<()> {
    let appender = tracing_appender::rolling::daily(&paths.log_dir, "spotui.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    // Leak the guard so logs flush for the lifetime of the process.
    Box::leak(Box::new(guard));

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(writer)
        .with_ansi(false)
        .init();
    Ok(())
}
