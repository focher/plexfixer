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
//! ffmpeg and ffprobe, the user's own ssh tools, and nothing else.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::locate::{locate, locate_qt_faststart};
use crate::settings::Store;

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

/// The most `host_read_range` will read in one call.
///
/// The box walk asks for sixteen bytes at a time and a header for a few
/// kilobytes; the length is a number from the caller, and a buffer is
/// allocated for it before anything is read.
const LONGEST_READ: u32 = 64 * 1024 * 1024;

/// Whether `command` is one of the binaries this app runs.
///
/// Separate from where the answers come from so it can be tested: `chosen` is
/// what Settings names, `located` is what the app found by itself.
fn is_allowed(command: &str, chosen: &[Option<String>], located: &[PathBuf]) -> bool {
    // `ssh` and friends are the user's own, found on PATH: the whole point of
    // shelling out to them is that their config, keys and agent apply. They
    // are named here rather than left open.
    if matches!(command, "ssh" | "ssh-keyscan" | "ssh-keygen") {
        return true;
    }
    if chosen.iter().flatten().any(|path| path == command) {
        return true;
    }
    located.iter().any(|path| path == Path::new(command))
}

/// Only the binaries this app resolved may be run.
///
/// A path set in Settings is as legitimate as the bundled one, so it counts —
/// and it is read here, from the settings this side saved. It used to arrive
/// as an argument beside the command it was vouching for, which made the check
/// one the caller could pass by naming the same path twice.
///
/// `whisperPath` joins them for the same reason and on the same terms: a
/// transcription runs a Whisper build that this app does not ship and cannot
/// locate, so the only thing that can name it is a person typing it into
/// Settings. Nothing the caller says widens that either.
///
/// `qt-faststart` is resolved the same way the environment resolves it: beside
/// the ffmpeg in use (which is itself one of these), or bundled, or on PATH.
/// Nothing the caller says can widen that.
pub async fn allowed_binary(app: &AppHandle, command: &str) -> bool {
    let settings = app.state::<Store>().settings().await;
    let chosen = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
    };
    let mut located: Vec<PathBuf> = ["ffmpeg", "ffprobe"]
        .iter()
        .filter_map(|name| locate(app, name, None).map(|found| found.path))
        .collect();
    let ffmpeg = locate(app, "ffmpeg", chosen("ffmpegPath").as_deref()).map(|found| found.path);
    if let Some(qt) = ffmpeg.and_then(|ffmpeg| locate_qt_faststart(app, &ffmpeg)) {
        located.push(qt);
    }

    is_allowed(
        command,
        &[chosen("ffmpegPath"), chosen("ffprobePath"), chosen("whisperPath")],
        &located,
    )
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
) -> Result<String, String> {
    if !allowed_binary(&app, &command).await {
        return Err(format!(
            "{command} is not one of the binaries PlexFixer runs. Only the ffmpeg and ffprobe it resolved are."
        ));
    }

    let mut process = Command::new(&command);
    process
        .args(&args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A command that runs past its time is given up on below, and giving
        // up on it has to stop it: without this the wait is abandoned and the
        // process is not, so every probe that hangs leaves one behind.
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: a command run for the page must not flash a console.
        process.creation_flags(0x0800_0000);
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));

    let mut child = process
        .spawn()
        .map_err(|e| format!("{command} would not start: {e}"))?;

    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        // Written alongside the read rather than before it. A command that
        // answers as it goes fills its output pipe while still being fed, and
        // writing everything first would leave each side waiting on the other.
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            // Closing it is what tells the command the input has ended.
            drop(stdin);
        });
    }

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("{command} did not finish within {}s", timeout.as_secs()))?
        .map_err(|e| format!("{command} failed: {e}"))?;

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

    if length > LONGEST_READ {
        return Err(format!("{length} bytes is more than PlexFixer reads from a file at once"));
    }

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

/// Walk a directory, collecting the media files under it.
///
/// `entered` holds the canonical path of every directory already walked, which
/// is what makes it safe to follow links. A library keeps seasons, whole
/// drives or a second copy of a collection behind a link as a matter of
/// course — and on Windows a junction is a link too, so refusing to follow one
/// silently loses whole folders someone has asked to scan. Following them
/// needs only that nowhere is entered twice: a link pointing back up the tree
/// stops on its second arrival rather than looping, and a cross-linked season
/// folder is walked once rather than reported under both paths.
fn walk(
    dir: &Path,
    extensions: &[String],
    recursive: bool,
    depth: usize,
    found: &mut Vec<PathBuf>,
    entered: &mut HashSet<PathBuf>,
) {
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

        // `metadata` rather than `symlink_metadata`: a link is followed to
        // whatever it points at, and judged on that. A linked folder full of
        // films is a folder full of films.
        let Ok(meta) = std::fs::metadata(&path) else {
            // A link with nothing at the end of it, or an entry that went away
            // between being listed and being asked about.
            continue;
        };

        if meta.is_dir() {
            if !recursive || SKIP_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            // Where this really is, so that arriving by two different routes
            // counts as arriving once. A directory that cannot be resolved is
            // left alone rather than guessed at.
            let Ok(real) = std::fs::canonicalize(&path) else {
                continue;
            };
            if !entered.insert(real) {
                continue;
            }
            walk(&path, extensions, recursive, depth + 1, found, entered);
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
        // Shared across the roots: two chosen folders that overlap, or one
        // that is reachable from inside another, are walked once between them.
        let mut entered: HashSet<PathBuf> = HashSet::new();
        for root in &roots {
            let path = PathBuf::from(root);
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_dir() => {
                    if let Ok(real) = std::fs::canonicalize(&path) {
                        if !entered.insert(real) {
                            continue;
                        }
                    }
                    walk(&path, &extensions, recursive, 0, &mut found, &mut entered)
                }
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
        let mut entered = HashSet::new();
        walk(root, &extensions, recursive, 0, &mut found, &mut entered);
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
    fn follows_a_linked_folder() {
        // A library keeps a season, a second drive or a whole collection
        // behind a link routinely, and on Windows a junction is a link too.
        // Skipping them lost entire folders someone had asked to scan.
        let root = tree("symlink");
        let elsewhere = root.parent().unwrap().join(format!(
            "plexfixer-linked-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("Linked.mkv"), b"x").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("Linked")).unwrap();

        let found = walk_of(&root, true);
        assert!(
            found.contains(&"Linked/Linked.mkv".to_string()),
            "a linked folder's media should be found: {found:?}"
        );
        std::fs::remove_dir_all(&elsewhere).ok();
    }

    #[cfg(unix)]
    #[test]
    fn walks_a_cross_linked_folder_only_once() {
        // Following links is only safe because nowhere is entered twice. The
        // film under `Movies` must not also be reported under the link.
        let root = tree("crosslink");
        std::os::unix::fs::symlink(root.join("Movies"), root.join("AlsoMovies")).unwrap();
        let found = walk_of(&root, true);
        let films: Vec<&String> = found.iter().filter(|name| name.ends_with("Alien.M4V")).collect();
        assert_eq!(films.len(), 1, "expected one copy of the film, got {films:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_pointing_up_the_tree_terminates() {
        // The case the old skip existed to prevent: without the record of
        // where it has been, this walks until the depth limit stops it.
        let root = tree("loop");
        std::os::unix::fs::symlink(&root, root.join("Movies/Up")).unwrap();
        let found = walk_of(&root, true);
        assert!(found.contains(&"Top.mkv".to_string()));
        assert!(
            !found.iter().any(|name| name.matches("Up").count() > 1),
            "the walk went round the loop: {found:?}"
        );
    }

    #[test]
    fn a_binary_nobody_resolved_is_refused() {
        // The check this replaces took the "path from Settings" from the same
        // caller that named the command, so naming it twice passed.
        assert!(!is_allowed("/bin/sh", &[None, None], &[PathBuf::from("/app/bin/ffmpeg")]));
    }

    #[test]
    fn the_located_binaries_are_allowed() {
        let located = [PathBuf::from("/app/bin/ffmpeg"), PathBuf::from("/app/bin/ffprobe")];
        assert!(is_allowed("/app/bin/ffmpeg", &[None, None], &located));
        assert!(is_allowed("/app/bin/ffprobe", &[None, None], &located));
    }

    #[test]
    fn a_path_saved_in_settings_is_allowed() {
        let chosen = [Some("/opt/ffmpeg/bin/ffmpeg".to_string()), None];
        assert!(is_allowed("/opt/ffmpeg/bin/ffmpeg", &chosen, &[]));
        assert!(!is_allowed("/opt/ffmpeg/bin/ffprobe", &chosen, &[]));
    }

    #[test]
    fn the_ssh_tools_are_allowed_by_name_only() {
        assert!(is_allowed("ssh", &[None, None], &[]));
        assert!(is_allowed("ssh-keygen", &[None, None], &[]));
        assert!(!is_allowed("/tmp/ssh", &[None, None], &[]));
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

    // `--` so a path is a path whatever it begins with.
    let status = Command::new("/bin/cp")
        .args(["-c", "-p", "--", &from, &to])
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

    #[cfg(unix)]
    let device = tokio::fs::metadata(&directory).await.ok().map(|meta| {
        use std::os::unix::fs::MetadataExt;
        meta.dev()
    });
    // Windows metadata carries no device number. Reporting 0 for every path,
    // as this did, makes every pair of paths compare equal — so a repair
    // writing from C: to D: would have been diagnosed as staying on one
    // volume. `None` is the truthful answer, and leaves `sameVolume`
    // undefined rather than confidently wrong.
    #[cfg(not(unix))]
    let device: Option<u64> = None;

    let df = Command::new("df")
        .args(["-P", "--", &directory.to_string_lossy()])
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
