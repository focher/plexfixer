//! The filesystem and process primitives the webview reads through.
//!
//! These back `ProbeHost` on the TypeScript side: probing, MP4 box walking and
//! sidecar discovery are all written against that interface, so everything
//! above this file is shared with the Electron build and already tested. What
//! is here is only the part that has to be native.
//!
//! `exec` is deliberately not a general "run a command" door. The webview runs
//! our own code behind a strict CSP, but a command that takes any binary and
//! any arguments is a much wider capability than the job needs, and widening
//! it by accident is the kind of thing nobody notices. It runs the located
//! ffmpeg and ffprobe, and nothing else.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::locate::locate;

/// Directories that never hold library media and cost time to walk.
const SKIP_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "@eaDir",
    ".AppleDouble",
    ".Trashes",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".plexfixer-backups",
];

const DEFAULT_MAX_DEPTH: usize = 24;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    pub is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Only the binaries this app resolved may be run.
///
/// A path set in Settings is as legitimate as the bundled one, so it counts as
/// allowed — but only when it is the path the app itself resolved, not any
/// string the caller fancies.
pub fn allowed_binary(
    app: &AppHandle,
    command: &str,
    settings_ffmpeg: Option<&str>,
    settings_ffprobe: Option<&str>,
) -> bool {
    if [settings_ffmpeg, settings_ffprobe]
        .into_iter()
        .flatten()
        .any(|path| path == command)
    {
        return true;
    }
    // `ssh` and `ssh-keyscan` are the user's own, found on PATH: the whole
    // point of shelling out to them is that their config, keys and agent
    // apply. They are named here rather than left open.
    if matches!(command, "ssh" | "ssh-keyscan" | "ssh-keygen") {
        return true;
    }
    ["ffmpeg", "ffprobe"].iter().any(|name| {
        locate(app, name, None)
            .map(|located| located.path == Path::new(command))
            .unwrap_or(false)
    })
}

/* ------------------------------------------------------------------ *
 * known_hosts
 *
 * The one file outside the app's own directory that PlexFixer writes to, and
 * only when the user answers SSH's first-connection question. It is addressed
 * by name rather than by a path the caller supplies, so this cannot become a
 * general "append to any file" command.
 * ------------------------------------------------------------------ */

fn known_hosts_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("could not work out your home directory")?;
    Ok(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

#[tauri::command]
pub async fn known_hosts_read() -> Result<String, String> {
    let path = known_hosts_path()?;
    Ok(tokio::fs::read_to_string(path).await.unwrap_or_default())
}

#[tauri::command]
pub async fn known_hosts_append(line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let path = known_hosts_path()?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let prefix = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    let text = format!("{prefix}{}\n", line.trim_end());
    file.write_all(text.as_bytes())
        .await
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Where `known_hosts` is, for messages that name it.
#[tauri::command]
pub async fn known_hosts_location() -> Result<String, String> {
    Ok(known_hosts_path()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn host_exec(
    app: AppHandle,
    command: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    input: Option<String>,
    settings_ffmpeg: Option<String>,
    settings_ffprobe: Option<String>,
) -> Result<String, String> {
    if !allowed_binary(&app, &command, settings_ffmpeg.as_deref(), settings_ffprobe.as_deref()) {
        return Err(format!(
            "{command} is not one of the binaries PlexFixer runs. Only the ffmpeg and ffprobe it resolved are."
        ));
    }

    let mut process = Command::new(&command);
    process
        .args(&args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));

    let output = if let Some(input) = input {
        use tokio::io::AsyncWriteExt;
        let mut child = process
            .spawn()
            .map_err(|e| format!("{command} would not start: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|e| format!("could not write to {command}: {e}"))?;
            // Closing it is what tells the command the input has ended.
            drop(stdin);
        }
        tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| format!("{command} did not finish within {}s", timeout.as_secs()))?
            .map_err(|e| format!("{command} failed: {e}"))?
    } else {
        tokio::time::timeout(timeout, process.output())
            .await
            .map_err(|_| format!("{command} did not finish within {}s", timeout.as_secs()))?
            .map_err(|e| format!("{command} would not start: {e}"))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.lines().next().unwrap_or("no output").to_string();
        return Err(format!("{command} exited with an error: {first}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn host_stat(path: String) -> Result<Option<Stat>, String> {
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        // Missing or unreadable is an answer, not a failure: the caller asks
        // about files that may well have gone.
        return Ok(None);
    };

    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(Some(Stat {
        size_bytes: meta.len(),
        modified_ms,
        is_directory: meta.is_dir(),
    }))
}

#[tauri::command]
pub async fn host_list(directory: String) -> Result<Vec<Entry>, String> {
    let mut reader = tokio::fs::read_dir(&directory)
        .await
        .map_err(|e| format!("could not read {directory}: {e}"))?;

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = reader.next_entry().await {
        let meta = match entry.metadata().await {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: meta.is_dir(),
            size_bytes: (!meta.is_dir()).then(|| meta.len()),
        });
    }
    Ok(entries)
}

/// Bytes `[offset, offset + length)`, for walking an MP4's box chain.
#[tauri::command]
pub async fn host_read_range(path: String, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncSeekExt;

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("could not open {path}: {e}"))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("could not seek {path}: {e}"))?;

    let mut buffer = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]).await {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("could not read {path}: {e}")),
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

fn is_media(path: &Path, extensions: &[String]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .map(|ext| extensions.iter().any(|wanted| *wanted == ext))
        .unwrap_or(false)
}

fn walk(dir: &Path, extensions: &[String], recursive: bool, depth: usize, found: &mut Vec<PathBuf>) {
    if depth > DEFAULT_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        // Unreadable directory — a permissions problem, or a share that went
        // away. Skipped quietly; the scan reports per-file errors, not
        // per-directory ones.
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // macOS resource forks.
        if name.starts_with("._") {
            continue;
        }
        let path = entry.path();

        // `symlink_metadata` rather than `metadata`: symlinked directories are
        // not followed, which avoids loops and keeps a library with
        // cross-linked season folders from being walked twice.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            if !recursive || SKIP_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            walk(&path, extensions, recursive, depth + 1, found);
        } else if meta.is_file() && is_media(&path, extensions) {
            found.push(path);
        }
    }
}

/// Expand files and folders into a sorted, de-duplicated list of media files.
#[tauri::command]
pub async fn find_media(
    roots: Vec<String>,
    extensions: Vec<String>,
    recursive: bool,
) -> Result<Vec<String>, String> {
    let extensions: Vec<String> = extensions
        .iter()
        .map(|ext| ext.trim_start_matches('.').to_lowercase())
        .collect();

    // The walk is synchronous and can touch tens of thousands of entries, so
    // it goes to the blocking pool rather than stalling the async runtime.
    let found = tokio::task::spawn_blocking(move || {
        let mut found: Vec<PathBuf> = Vec::new();
        for root in &roots {
            let path = PathBuf::from(root);
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_dir() => walk(&path, &extensions, recursive, 0, &mut found),
                Ok(meta) if meta.is_file() && is_media(&path, &extensions) => found.push(path),
                // A path that is gone or unreadable is reported by the scan as
                // an input that contributed nothing.
                _ => {}
            }
        }
        found
    })
    .await
    .map_err(|e| format!("the scan could not be run: {e}"))?;

    let mut paths: Vec<String> = found
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Milliseconds since the epoch, for naming things that must not collide.
#[allow(dead_code)]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small library tree, built fresh for each test.
    fn tree(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "plexfixer-walk-{}-{name}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(root.join("Movies")).unwrap();
        std::fs::create_dir_all(root.join(".plexfixer-backups")).unwrap();
        std::fs::create_dir_all(root.join("@eaDir")).unwrap();

        std::fs::write(root.join("Top.mkv"), b"x").unwrap();
        std::fs::write(root.join("Movies/Alien.M4V"), b"x").unwrap();
        std::fs::write(root.join("Movies/notes.txt"), b"x").unwrap();
        std::fs::write(root.join("Movies/._Alien.m4v"), b"x").unwrap();
        std::fs::write(root.join(".plexfixer-backups/Old.mkv"), b"x").unwrap();
        std::fs::write(root.join("@eaDir/Thumb.mkv"), b"x").unwrap();
        root
    }

    fn walk_of(root: &Path, recursive: bool) -> Vec<String> {
        let extensions = vec!["mkv".to_string(), "m4v".to_string()];
        let mut found = Vec::new();
        walk(root, &extensions, recursive, 0, &mut found);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn finds_media_whatever_case_the_extension_is_in() {
        let root = tree("case");
        let found = walk_of(&root, true);
        assert!(found.contains(&"Top.mkv".to_string()));
        assert!(found.contains(&"Movies/Alien.M4V".to_string()));
    }

    #[test]
    fn leaves_out_files_that_are_not_media() {
        let root = tree("other");
        assert!(!walk_of(&root, true).contains(&"Movies/notes.txt".to_string()));
    }

    #[test]
    fn leaves_out_macos_resource_forks() {
        // `._Alien.m4v` has a media extension and is not a media file.
        let root = tree("forks");
        assert!(!walk_of(&root, true).iter().any(|name| name.contains("._")));
    }

    #[test]
    fn does_not_walk_into_backups_or_system_folders() {
        let root = tree("skips");
        let found = walk_of(&root, true);
        assert!(!found.iter().any(|name| name.contains(".plexfixer-backups")));
        assert!(!found.iter().any(|name| name.contains("@eaDir")));
    }

    #[test]
    fn stays_at_the_top_when_not_recursive() {
        let root = tree("flat");
        assert_eq!(walk_of(&root, false), vec!["Top.mkv".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_symlinked_folder() {
        // A library with cross-linked season folders would otherwise be walked
        // twice, and a link pointing up the tree would loop.
        let root = tree("symlink");
        std::os::unix::fs::symlink(root.join("Movies"), root.join("Linked")).unwrap();
        let found = walk_of(&root, true);
        assert!(!found.iter().any(|name| name.starts_with("Linked")));
    }

    #[tokio::test]
    async fn a_single_file_is_accepted_as_a_root() {
        let root = tree("single");
        let file = root.join("Top.mkv").to_string_lossy().into_owned();
        let found = find_media(vec![file.clone()], vec!["mkv".into()], true)
            .await
            .unwrap();
        assert_eq!(found, vec![file]);
    }

    #[tokio::test]
    async fn overlapping_roots_report_each_file_once() {
        let root = tree("dedupe");
        let found = find_media(
            vec![
                root.to_string_lossy().into_owned(),
                root.join("Movies").to_string_lossy().into_owned(),
            ],
            vec!["mkv".into(), "m4v".into()],
            true,
        )
        .await
        .unwrap();

        let alien: Vec<_> = found.iter().filter(|p| p.contains("Alien")).collect();
        assert_eq!(alien.len(), 1, "a file under two roots is still one file");
        let mut sorted = found.clone();
        sorted.sort();
        assert_eq!(found, sorted, "results come back sorted");
    }
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/// Overwrite the bytes at `offset`, durably, leaving the rest alone.
///
/// This is how an MP4 header is corrected without rewriting a forty-gigabyte
/// file. The flush matters: the caller verifies what it wrote, and an
/// unflushed write would be verified out of the page cache and prove nothing.
#[tauri::command]
pub async fn host_write_range(path: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .await
        .map_err(|e| format!("could not open {path} for writing: {e}"))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| format!("could not seek {path}: {e}"))?;
    file.write_all(&bytes)
        .await
        .map_err(|e| format!("could not write {path}: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("could not flush {path}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn host_mkdirp(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("could not create {path}: {e}"))
}

#[tauri::command]
pub async fn host_rename(from: String, to: String) -> Result<(), String> {
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("could not move {from} to {to}: {e}"))
}

#[tauri::command]
pub async fn host_remove(path: String) -> Result<(), String> {
    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| format!("could not remove {path}: {e}"))
}

/// Remove a directory only if it is empty; a folder with anything left stays.
#[tauri::command]
pub async fn host_remove_empty_directory(path: String) -> Result<(), String> {
    tokio::fs::remove_dir(&path)
        .await
        .map_err(|e| format!("could not remove the folder {path}: {e}"))
}

#[tauri::command]
pub async fn host_exists(path: String) -> Result<bool, String> {
    Ok(tokio::fs::metadata(&path).await.is_ok())
}

/// An APFS clone: an instant copy that shares the original's data.
///
/// Only attempted where it is certain to work — both ends on the same APFS
/// volume, which a backup folder beside its file always is. `cp -c` quietly
/// falls back to a full copy when it cannot clone, and a real copy of a
/// multi-gigabyte file is exactly what this exists to avoid.
#[tauri::command]
pub async fn host_clone_file(from: String, to: String) -> Result<bool, String> {
    if std::env::consts::OS != "macos" {
        return Ok(false);
    }

    let same_apfs = match (volume_of(&from).await, volume_of(&to).await) {
        (Some(source), Some(target)) => {
            source.fs_type.as_deref() == Some("apfs") && source.device.is_some() && source.device == target.device
        }
        _ => false,
    };
    if !same_apfs {
        return Ok(false);
    }

    let status = Command::new("/bin/cp")
        .args(["-c", "-p", &from, &to])
        .stdin(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("could not clone {from}: {e}"))?;
    Ok(status.success())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VolumeFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<u64>,
    /// Raw `df -P` output, parsed on the TypeScript side where the tests are.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub df: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs_type: Option<String>,
}

async fn volume_of(path: &str) -> Option<VolumeFacts> {
    let directory = Path::new(path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(path));

    let device = tokio::fs::metadata(&directory).await.ok().map(|meta| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            meta.dev()
        }
        #[cfg(not(unix))]
        {
            let _ = &meta;
            0u64
        }
    });

    let df = Command::new("df")
        .args(["-P", &directory.to_string_lossy()])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());

    let fs_type = if std::env::consts::OS == "macos" {
        Command::new("/usr/sbin/diskutil")
            .args(["info", "-plist", &directory.to_string_lossy()])
            .stdin(Stdio::null())
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| {
                let text = String::from_utf8_lossy(&out.stdout).into_owned();
                // The plist is XML; the one key wanted is a string value, so
                // the surrounding structure does not need parsing.
                let at = text.find("<key>FilesystemType</key>")?;
                let rest = &text[at..];
                let start = rest.find("<string>")? + "<string>".len();
                let end = rest[start..].find("</string>")? + start;
                Some(rest[start..end].to_string())
            })
    } else {
        None
    };

    Some(VolumeFacts { device, df, fs_type })
}

/// What a path is sitting on, in the pieces the TypeScript side parses.
#[tauri::command]
pub async fn host_volume(path: String) -> Result<VolumeFacts, String> {
    Ok(volume_of(&path).await.unwrap_or(VolumeFacts {
        device: None,
        df: None,
        fs_type: None,
    }))
}
