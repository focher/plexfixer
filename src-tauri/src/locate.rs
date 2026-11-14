//! Finding the ffmpeg and ffprobe binaries.
//!
//! Packaged builds ship static binaries under `bin/<platform>-<arch>/`; a dev
//! run uses the repo's `resources/bin/<platform>-<arch>/` if `npm run
//! fetch:ffmpeg` has populated it, and otherwise falls back to PATH so a
//! Homebrew or winget install works out of the box. A path set in Settings
//! always wins.
//!
//! The platform folder names come from the fetch script, which names them the
//! way Node does — `darwin-arm64`, `win32-x64` — so Rust's own OS and
//! architecture names are mapped onto those rather than the other way round.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Node's `process.platform` for the machine this is running on.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node's `process.arch` for the machine this is running on.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

pub fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[derive(Clone, Debug)]
pub struct Located {
    pub path: PathBuf,
    /// "settings", "bundled" or "path", matching `EnvironmentInfo`.
    pub source: &'static str,
}

/// Every folder a bundled binary might be in, packaged or not.
fn bundled_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let platform_dir = format!("{}-{}", node_platform(), node_arch());
    let mut candidates = Vec::new();

    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("bin").join(&platform_dir));
        // `cargo tauri dev` resolves resources inside target/debug, so the
        // repo's own folder is checked too rather than making a dev run
        // silently fall through to PATH.
        candidates.push(resources.join("resources/bin").join(&platform_dir));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources/bin").join(&platform_dir));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("resources/bin").join(&platform_dir));
        }
    }

    candidates
}

/// Search PATH without shelling out to `which`.
fn search_path(name: &str) -> Option<PathBuf> {
    let wanted = exe_name(name);

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();

    // An app launched from Finder or Explorer inherits a minimal PATH, so the
    // usual install locations are checked explicitly.
    let extra: &[&str] = match std::env::consts::OS {
        "macos" => &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
        "linux" => &["/usr/bin", "/usr/local/bin", "/snap/bin"],
        _ => &[],
    };
    dirs.extend(extra.iter().map(PathBuf::from));

    dirs.into_iter()
        .map(|dir| dir.join(&wanted))
        .find(|candidate| candidate.is_file())
}

/// Resolve a binary: an explicit override first, then the bundled copy, then
/// PATH. `None` when nothing usable is there.
pub fn locate(app: &AppHandle, name: &str, override_path: Option<&str>) -> Option<Located> {
    if let Some(path) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let path = Path::new(path);
        if path.is_file() {
            return Some(Located {
                path: path.to_path_buf(),
                source: "settings",
            });
        }
    }

    let wanted = exe_name(name);
    for dir in bundled_dirs(app) {
        let candidate = dir.join(&wanted);
        if candidate.is_file() {
            return Some(Located {
                path: candidate,
                source: "bundled",
            });
        }
    }

    search_path(name).map(|path| Located {
        path,
        source: "path",
    })
}
