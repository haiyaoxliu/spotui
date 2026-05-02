use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use ratatui::style::Color;
use serde::{Deserialize, Serialize};

const CONFIG_TEMPLATE: &str = r#"# spotui config
# Get a client ID at https://developer.spotify.com/dashboard
# In your Spotify app settings, register this exact redirect URI:
#   http://127.0.0.1:8888/callback
client_id = "REPLACE_ME"

# Loopback redirect port. Must match what is registered in your Spotify app.
redirect_port = 8888

# Substring matching the device name to prefer (empty = whichever is active).
default_device = ""

# How often to poll Spotify for now-playing state (ms).
poll_ms = 1000
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub client_id: String,
    #[serde(default = "default_port")]
    pub redirect_port: u16,
    #[serde(default)]
    pub default_device: String,
    #[serde(default = "default_poll_ms")]
    pub poll_ms: u64,
    #[serde(default)]
    pub colors: ColorsConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ColorsConfig {
    pub accent: Option<String>,
    pub success: Option<String>,
    pub warn: Option<String>,
    pub dim: Option<String>,
    pub highlight_fg: Option<String>,
    pub jam: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub accent: Color,
    pub success: Color,
    pub warn: Color,
    pub dim: Color,
    /// Foreground color used on highlighted/selected rows where the background
    /// is an accent (e.g. list cursor, search-result cursor, status mode chip).
    /// Defaults to Black; flip to White if you pick a dark accent.
    pub highlight_fg: Color,
    /// Border color for the right-column "shared" panes (NowPlaying / Queue /
    /// Jam) when a jam is active, plus the status-bar `jam:*` chip background.
    /// Defaults to green so it reads as "linked".
    pub jam: Color,
}

impl Theme {
    pub fn defaults() -> Self {
        Self {
            accent: Color::Cyan,
            success: Color::Green,
            warn: Color::Yellow,
            dim: Color::DarkGray,
            highlight_fg: Color::Black,
            jam: Color::Green,
        }
    }

    pub fn from_config(cc: &ColorsConfig) -> Self {
        let d = Self::defaults();
        Self {
            accent: cc.accent.as_deref().and_then(parse_color).unwrap_or(d.accent),
            success: cc
                .success
                .as_deref()
                .and_then(parse_color)
                .unwrap_or(d.success),
            warn: cc.warn.as_deref().and_then(parse_color).unwrap_or(d.warn),
            dim: cc.dim.as_deref().and_then(parse_color).unwrap_or(d.dim),
            highlight_fg: cc
                .highlight_fg
                .as_deref()
                .and_then(parse_color)
                .unwrap_or(d.highlight_fg),
            jam: cc.jam.as_deref().and_then(parse_color).unwrap_or(d.jam),
        }
    }

    pub fn to_config(self) -> ColorsConfig {
        ColorsConfig {
            accent: Some(color_to_string(self.accent)),
            success: Some(color_to_string(self.success)),
            warn: Some(color_to_string(self.warn)),
            dim: Some(color_to_string(self.dim)),
            highlight_fg: Some(color_to_string(self.highlight_fg)),
            jam: Some(color_to_string(self.jam)),
        }
    }
}

/// Parse a named color or `#rrggbb` hex. Returns None on garbage so callers
/// can fall back to the default for that slot.
pub fn parse_color(s: &str) -> Option<Color> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            return Some(Color::Rgb(r, g, b));
        }
        return None;
    }
    Some(match s.to_ascii_lowercase().as_str() {
        "reset" => Color::Reset,
        "black" => Color::Black,
        "red" => Color::Red,
        "green" => Color::Green,
        "yellow" => Color::Yellow,
        "blue" => Color::Blue,
        "magenta" => Color::Magenta,
        "cyan" => Color::Cyan,
        "gray" | "grey" => Color::Gray,
        "darkgray" | "darkgrey" => Color::DarkGray,
        "lightred" => Color::LightRed,
        "lightgreen" => Color::LightGreen,
        "lightyellow" => Color::LightYellow,
        "lightblue" => Color::LightBlue,
        "lightmagenta" => Color::LightMagenta,
        "lightcyan" => Color::LightCyan,
        "white" => Color::White,
        _ => return None,
    })
}

pub fn color_to_string(c: Color) -> String {
    match c {
        Color::Reset => "reset".into(),
        Color::Black => "black".into(),
        Color::Red => "red".into(),
        Color::Green => "green".into(),
        Color::Yellow => "yellow".into(),
        Color::Blue => "blue".into(),
        Color::Magenta => "magenta".into(),
        Color::Cyan => "cyan".into(),
        Color::Gray => "gray".into(),
        Color::DarkGray => "darkgray".into(),
        Color::LightRed => "lightred".into(),
        Color::LightGreen => "lightgreen".into(),
        Color::LightYellow => "lightyellow".into(),
        Color::LightBlue => "lightblue".into(),
        Color::LightMagenta => "lightmagenta".into(),
        Color::LightCyan => "lightcyan".into(),
        Color::White => "white".into(),
        Color::Rgb(r, g, b) => format!("#{:02x}{:02x}{:02x}", r, g, b),
        Color::Indexed(n) => format!("@{n}"),
    }
}

fn default_port() -> u16 {
    8888
}
fn default_poll_ms() -> u64 {
    1000
}

impl Config {
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.redirect_port)
    }
}

pub struct Paths {
    pub config_file: PathBuf,
    pub token_cache: PathBuf,
    pub log_dir: PathBuf,
    pub cache_root: PathBuf,
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let dirs = ProjectDirs::from("", "", "spotui")
            .ok_or_else(|| anyhow!("could not resolve user directories"))?;
        let config_dir = dirs.config_dir().to_path_buf();
        let cache_dir = dirs.cache_dir().to_path_buf();
        let log_dir = dirs.data_local_dir().join("log");
        Ok(Self {
            config_file: config_dir.join("config.toml"),
            token_cache: config_dir.join("token.json"),
            cache_root: cache_dir,
            log_dir,
        })
    }
}

/// Load the config, prompting interactively for `client_id` on first run when
/// stdin is a TTY. Falls back to writing a template + erroring out for the
/// non-interactive case (CI, redirected stdin).
pub fn load_or_create(paths: &Paths) -> Result<Config> {
    if !paths.config_file.exists() {
        if io::stdin().is_terminal() {
            return interactive_first_run(paths);
        }
        write_template(paths)?;
        return Err(anyhow!(
            "Wrote a config template to {}.\nEdit it and set client_id, then re-run.",
            paths.config_file.display()
        ));
    }

    let body = fs::read_to_string(&paths.config_file)
        .with_context(|| format!("read {}", paths.config_file.display()))?;
    let cfg: Config = toml::from_str(&body)
        .with_context(|| format!("parse {}", paths.config_file.display()))?;

    if needs_client_id(&cfg.client_id) {
        if io::stdin().is_terminal() {
            return interactive_fill_client_id(paths, cfg);
        }
        return Err(anyhow!(
            "client_id is unset in {}.\nGet one at https://developer.spotify.com/dashboard.",
            paths.config_file.display()
        ));
    }

    Ok(cfg)
}

fn needs_client_id(s: &str) -> bool {
    let t = s.trim();
    t.is_empty() || t == "REPLACE_ME"
}

fn write_template(paths: &Paths) -> Result<()> {
    if let Some(parent) = paths.config_file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(&paths.config_file, CONFIG_TEMPLATE)
        .with_context(|| format!("write {}", paths.config_file.display()))?;
    Ok(())
}

/// First-run setup walk-through. Prints the dashboard steps the user has to
/// do once, reads their client_id from stdin, and writes a fresh config.
fn interactive_first_run(paths: &Paths) -> Result<Config> {
    print_setup_banner();
    let client_id = prompt_client_id()?;
    let cfg = Config {
        client_id,
        redirect_port: default_port(),
        default_device: String::new(),
        poll_ms: default_poll_ms(),
        colors: ColorsConfig::default(),
    };
    write_config(paths, &cfg)?;
    println!("Saved config to {}.\n", paths.config_file.display());
    Ok(cfg)
}

/// Same UX as the first-run flow but the config file already exists with a
/// missing/placeholder client_id (someone deleted token.json or the template
/// wasn't filled in). Preserves whatever else is in the file.
fn interactive_fill_client_id(paths: &Paths, mut cfg: Config) -> Result<Config> {
    print_setup_banner();
    cfg.client_id = prompt_client_id()?;
    write_config(paths, &cfg)?;
    println!("Updated {}.\n", paths.config_file.display());
    Ok(cfg)
}

fn print_setup_banner() {
    println!();
    println!("=== spotui first-run setup ===");
    println!();
    println!("1. Open https://developer.spotify.com/dashboard and create an app.");
    println!("2. In the app's Edit Settings:");
    println!("     - Add this Redirect URI exactly:");
    println!("         http://127.0.0.1:8888/callback");
    println!("     - Under \"User Management\", add the email you sign in with");
    println!("       (Spotify dev mode requires it).");
    println!("3. Copy the app's Client ID and paste it below.");
    println!();
}

fn prompt_client_id() -> Result<String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    loop {
        print!("Client ID: ");
        stdout.flush().ok();
        let mut line = String::new();
        let n = stdin
            .lock()
            .read_line(&mut line)
            .context("read client_id from stdin")?;
        if n == 0 {
            // EOF (e.g. piped stdin closed). Bail clearly.
            return Err(anyhow!("no input on stdin during first-run setup"));
        }
        let id = line.trim();
        if id.is_empty() {
            println!("(empty — try again, or ctrl-c to abort)");
            continue;
        }
        return Ok(id.to_string());
    }
}

pub fn write_config(paths: &Paths, cfg: &Config) -> Result<()> {
    if let Some(parent) = paths.config_file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let body = toml::to_string_pretty(cfg).context("serialize config")?;
    let tmp = paths.config_file.with_extension("toml.tmp");
    fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &paths.config_file)
        .with_context(|| format!("rename to {}", paths.config_file.display()))?;
    Ok(())
}

pub fn ensure_dirs(paths: &Paths) -> Result<()> {
    for dir in [
        paths.config_file.parent(),
        Some(paths.cache_root.as_path()),
        Some(paths.log_dir.as_path()),
    ]
    .into_iter()
    .flatten()
    {
        if !dir.exists() {
            fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
    }
    Ok(())
}
