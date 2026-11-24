//! Installing a whisper.cpp build, so that nobody has to.
//!
//! `models.rs` fetches the weights. This fetches the program that reads them,
//! which is the other half of the same problem: local transcription needs a
//! `whisper-cli` binary, nothing on a fresh machine has one, and the
//! instructions for getting one are a GitHub releases page where the builds
//! hang off rolling `b####` tags rather than the version tags, and where the
//! only one worth having on a machine with an NVIDIA card is a 736 MB zip
//! among eleven others. That is not a thing to ask somebody to work out.
//!
//! So this downloads the build they pick, checks it against the SHA-256 GitHub
//! publishes for the asset, extracts it into the app's own folder and finds the
//! binary inside. Nothing is installed system-wide, nothing is put on PATH, and
//! removing it is deleting one folder.
//!
//! **Only whisper.cpp's own Windows and Linux builds exist.** Upstream
//! publishes no macOS binary — only an xcframework for embedding — so on macOS
//! there is nothing to download and the app looks for one that is already
//! there instead: `brew install whisper.cpp` puts `whisper-cli` on PATH, and
//! `resolve` finds it without anything being typed into Settings.
//!
//! The same rule as everywhere else: the address is not an argument. The
//! caller names a tag and an asset, both of whose shapes are checked here, and
//! the URL is built from a prefix compiled into the binary. The path of the
//! binary inside the archive is not taken from the caller at all — the tree is
//! searched for it afterwards, so there is nothing to point anywhere.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::locate::{exe_name, locate};
use crate::models::{is_sha256, start_get, stream_to_file, Downloads};

/// Where the builds come from. A prefix, ending before the tag.
const RELEASES: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/";

/// The event an install reports download progress on.
const PROGRESS: &str = "plexfixer://whisper-progress";

/// And the one that says which part of an install is happening.
const STAGE: &str = "plexfixer://whisper-stage";

/// A ceiling on an archive. The CUDA build is 736 MB; nothing is near this.
const LARGEST_ARCHIVE: u64 = 4 * 1024 * 1024 * 1024;

/// The names whisper.cpp's command-line program has shipped under, newest
/// first. The TypeScript side knows the same three.
const BINARY_NAMES: &[&str] = &["whisper-cli", "whisper", "main"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stage {
    asset: String,
    /// `downloading`, `extracting`, or `done`.
    stage: &'static str,
}

/// A build that is installed, named by the asset it came from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBuild {
    /// The asset's file name without its extension, which is the folder's name.
    name: String,
    /// The `whisper-cli` inside it.
    path: String,
    /// What the whole tree takes up.
    size_bytes: u64,
}

/// Where a usable `whisper-cli` was found, and how.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    path: Option<String>,
    /// `settings`, `installed`, `path`, or `none`.
    source: &'static str,
}

/* ------------------------------------------------------------------ *
 * What the caller is allowed to have said
 * ------------------------------------------------------------------ */

/// Whether `tag` is one of whisper.cpp's build tags.
///
/// They are `b` and a number — `b5907` — and the version tags (`v1.9.6`) carry
/// no assets at all, which is the trap this exists to make unreachable.
fn is_build_tag(tag: &str) -> bool {
    tag.len() >= 2
        && tag.len() <= 12
        && tag.starts_with('b')
        && tag[1..].chars().all(|c| c.is_ascii_digit())
}

/// Whether `asset` is an archive name and not a path wearing one.
///
/// Joined to a directory on the way in and used as a folder name on the way
/// out, so nothing in it may be a separator, a parent, or a drive.
fn is_asset_name(asset: &str) -> bool {
    let stem = match asset.strip_suffix(".zip").or_else(|| asset.strip_suffix(".tar.gz")) {
        Some(stem) => stem,
        None => return false,
    };
    !stem.is_empty()
        && stem.len() <= 64
        && stem.starts_with("whisper-")
        && !stem.contains("..")
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// The folder one build is installed in: the asset's name without its suffix.
fn folder_for(asset: &str) -> Option<&str> {
    asset.strip_suffix(".zip").or_else(|| asset.strip_suffix(".tar.gz"))
}

/* ------------------------------------------------------------------ *
 * Where they live
 * ------------------------------------------------------------------ */

fn builds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper"))
}

/// The `whisper-cli` under `dir`, looked for a few levels down.
///
/// The Windows archives put everything in a `Release/` folder and the Linux
/// ones in `build/bin`, so this searches rather than assuming either. The depth
/// limit is what stops a surprising archive from turning this into a walk of
/// something enormous.
///
/// The order of `BINARY_NAMES` is load-bearing and not a preference. Recent
/// archives ship **both** `whisper-cli.exe` and a 28 KB `main.exe` that exists
/// only to print a notice saying the program was renamed. Taking whichever the
/// directory happened to list first would install that stub about half the
/// time, and the failure would arrive much later as Whisper "running" and
/// producing no subtitle.
fn find_binary(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            directories.push(path);
        } else {
            files.push(path);
        }
    }

    for wanted in BINARY_NAMES {
        let wanted = exe_name(wanted);
        if let Some(found) = files
            .iter()
            .find(|path| path.file_name().is_some_and(|name| name.to_string_lossy() == wanted))
        {
            return Some(found.clone());
        }
    }
    // Files before directories, so a binary at this level wins over one deeper.
    directories.sort();
    directories.into_iter().find_map(|dir| find_binary(&dir, depth - 1))
}

/// What a folder takes up, for showing what removing it would get back.
fn tree_size(dir: &Path, depth: usize) -> u64 {
    if depth == 0 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += tree_size(&path, depth - 1);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// Every `whisper-cli` from a build this app installed, newest install first.
///
/// All of them, because `allowed_binary` has to allow all of them: somebody who
/// installed the processor build and then the CUDA one has two, either may be
/// the one Settings names, and a binary the app put there itself is as
/// legitimate as a path somebody typed. Without this the app would install a
/// program and then refuse to run it.
pub fn installed_binaries(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = builds_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut installs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|path| {
            let when = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (when, path)
        })
        .collect();
    // By when it was installed rather than by name: the one put there last is
    // the one that was wanted, where a lexicographic sort would prefer the
    // processor build over the CUDA one for no reason at all.
    installs.sort_by(|a, b| b.0.cmp(&a.0));
    installs
        .into_iter()
        .filter_map(|(_, path)| find_binary(&path, 4))
        .collect()
}

/// The most recently installed one, which is the one a resolver should use.
pub fn installed_binary(app: &AppHandle) -> Option<PathBuf> {
    installed_binaries(app).into_iter().next()
}

#[tauri::command]
pub async fn whisper_installed(app: AppHandle) -> Result<Vec<InstalledBuild>, String> {
    let dir = builds_dir(&app)?;
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(found);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // A half-extracted folder is not an install; it has no binary in it.
        let Some(binary) = find_binary(&path, 4) else { continue };
        found.push(InstalledBuild {
            name,
            path: binary.to_string_lossy().into_owned(),
            size_bytes: tree_size(&path, 4),
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// The `whisper-cli` this machine will actually run, and where it came from.
///
/// Settings first, because a path somebody typed is a decision. Then a build
/// this app installed. Then PATH, which is what finds a Homebrew install on a
/// Mac — the platform upstream publishes no binary for, and the reason this
/// looks at all rather than only at its own folder.
#[tauri::command]
pub async fn whisper_resolve(app: AppHandle) -> Result<Resolved, String> {
    let chosen = app
        .state::<crate::settings::Store>()
        .settings()
        .await
        .get("whisperPath")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned);

    if let Some(path) = chosen {
        if Path::new(&path).is_file() {
            return Ok(Resolved { path: Some(path), source: "settings" });
        }
    }
    if let Some(path) = installed_binary(&app) {
        return Ok(Resolved { path: Some(path.to_string_lossy().into_owned()), source: "installed" });
    }
    for name in BINARY_NAMES {
        if let Some(found) = locate(&app, name, None) {
            return Ok(Resolved {
                path: Some(found.path.to_string_lossy().into_owned()),
                source: "path",
            });
        }
    }
    Ok(Resolved { path: None, source: "none" })
}

/// Delete one installed build, by the folder name `whisper_installed` gave.
#[tauri::command]
pub async fn whisper_remove(app: AppHandle, name: String) -> Result<(), String> {
    // Checked as the archive it came from, which is the same rule that let
    // the folder be created in the first place.
    if !is_asset_name(&format!("{name}.zip")) {
        return Err(format!("{name} is not a build this app installed"));
    }
    let path = builds_dir(&app)?.join(&name);
    match tokio::fs::remove_dir_all(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

/// Stop an install that is downloading.
#[tauri::command]
pub async fn whisper_cancel(asset: String, downloads: State<'_, Downloads>) -> Result<(), String> {
    downloads.cancel(&asset);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Installing
 * ------------------------------------------------------------------ */

/// Fetch one build, check it, extract it, and say where the binary ended up.
///
/// `Ok(Some(path))` is a `whisper-cli` ready to run. `Ok(None)` means it was
/// cancelled. `Err` is a failure, and nothing half-installed is left behind.
#[tauri::command]
pub async fn whisper_install(
    app: AppHandle,
    tag: String,
    asset: String,
    sha256: String,
    size_bytes: u64,
) -> Result<Option<String>, String> {
    if !is_build_tag(&tag) {
        return Err(format!("{tag} is not one of whisper.cpp's build tags"));
    }
    if !is_asset_name(&asset) {
        return Err(format!("{asset} is not one of its build archives"));
    }
    if !is_sha256(&sha256) {
        return Err("a build is only fetched against a SHA-256 to check it with".to_string());
    }
    if size_bytes == 0 || size_bytes > LARGEST_ARCHIVE {
        return Err(format!("{size_bytes} is not a plausible size for a build"));
    }

    if !app.state::<Downloads>().start(&asset) {
        return Err(format!("{asset} is already being installed"));
    }
    let outcome = install(&app, &tag, &asset, &sha256, size_bytes).await;
    app.state::<Downloads>().finish(&asset);
    let _ = app.emit(STAGE, Stage { asset, stage: "done" });
    outcome
}

async fn install(
    app: &AppHandle,
    tag: &str,
    asset: &str,
    sha256: &str,
    size_bytes: u64,
) -> Result<Option<String>, String> {
    let root = builds_dir(app)?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| format!("could not create {}: {e}", root.display()))?;

    let folder = folder_for(asset).ok_or("that is not an archive name")?;
    let target = root.join(folder);
    // Already installed and the binary is still where it was.
    if let Some(binary) = find_binary(&target, 4) {
        return Ok(Some(binary.to_string_lossy().into_owned()));
    }

    let archive = root.join(format!("{asset}.part"));
    let _ = tokio::fs::remove_file(&archive).await;

    let _ = app.emit(STAGE, Stage { asset: asset.to_string(), stage: "downloading" });
    let url = format!("{RELEASES}{tag}/{asset}");
    let response = start_get(&url, "GitHub", size_bytes).await?;
    let written = stream_to_file(app, response, &archive, asset, PROGRESS, asset, sha256, size_bytes).await;

    match written {
        Ok(true) => {}
        Ok(false) => {
            let _ = tokio::fs::remove_file(&archive).await;
            return Ok(None);
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&archive).await;
            return Err(error);
        }
    }

    // Into a folder of its own and renamed into place, so an interrupted
    // extraction never looks like an install. A leftover from a previous
    // attempt goes first.
    let _ = app.emit(STAGE, Stage { asset: asset.to_string(), stage: "extracting" });
    let staging = root.join(format!("{folder}.unpacking"));
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| format!("could not create {}: {e}", staging.display()))?;

    let unpacked = extract(&archive, &staging).await;
    let _ = tokio::fs::remove_file(&archive).await;
    if let Err(error) = unpacked {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }

    let Some(binary) = find_binary(&staging, 4) else {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(format!(
            "{asset} unpacked, but there is no whisper-cli in it — this build is not one PlexFixer can use."
        ));
    };
    // The zips do not carry a permission bit, so the binary arrives unexecutable.
    make_executable(&binary).await;

    let _ = tokio::fs::remove_dir_all(&target).await;
    tokio::fs::rename(&staging, &target)
        .await
        .map_err(|e| format!("could not put the build in place: {e}"))?;

    let installed = find_binary(&target, 4)
        .ok_or("the build moved into place but its binary cannot be found")?;
    Ok(Some(installed.to_string_lossy().into_owned()))
}

/// Unpack an archive with whatever this machine has.
///
/// bsdtar reads zips and ships with macOS and Windows 10 and later; `unzip`
/// covers the Linux case where `tar` is GNU tar and reads no zips at all. The
/// same two commands the ffmpeg fetch script uses, for the same reason: no
/// archive crate, and nothing to keep up to date.
async fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let first = run("tar", &["-xf".as_ref(), archive.as_os_str(), "-C".as_ref(), into.as_os_str()]).await;
    if first.is_ok() {
        return Ok(());
    }
    if archive.to_string_lossy().ends_with(".zip") {
        if let Ok(()) = run(
            "unzip",
            &["-q".as_ref(), "-o".as_ref(), archive.as_os_str(), "-d".as_ref(), into.as_os_str()],
        )
        .await
        {
            return Ok(());
        }
    }
    first.map_err(|error| format!("the archive could not be unpacked: {error}"))
}

async fn run(command: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let mut builder = tokio::process::Command::new(command);
    builder.args(args);
    builder.stdin(std::process::Stdio::null());
    builder.stdout(std::process::Stdio::null());
    builder.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW, for the same reason ffmpeg gets it: no console
        // window is to appear in front of somebody who pressed a button in an
        // app.
        builder.creation_flags(0x0800_0000);
    }

    let output = builder
        .output()
        .await
        .map_err(|e| format!("{command} would not run: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(format!("{command} failed: {}", said.trim().lines().last().unwrap_or("no reason given")))
}

#[cfg(unix)]
async fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = tokio::fs::metadata(path).await {
        let mut permissions = meta.permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        let _ = tokio::fs::set_permissions(path, permissions).await;
    }
}

#[cfg(not(unix))]
async fn make_executable(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_tags_are_the_rolling_ones() {
        assert!(is_build_tag("b5907"));
        assert!(is_build_tag("b1"));
        // The version tags carry no assets at all, which is the whole trap.
        assert!(!is_build_tag("v1.9.6"));
        assert!(!is_build_tag("master"));
        assert!(!is_build_tag("b"));
        assert!(!is_build_tag("b5907/../../etc"));
        assert!(!is_build_tag(""));
    }

    #[test]
    fn the_real_asset_names_are_accepted() {
        for asset in [
            "whisper-bin-x64.zip",
            "whisper-bin-win-cuda-12.4.0-x64.zip",
            "whisper-bin-ubuntu-x64.tar.gz",
        ] {
            assert!(is_asset_name(asset), "{asset} was refused");
        }
    }

    /// The name becomes a folder name, so nothing in it may be a path.
    #[test]
    fn an_asset_name_that_is_really_a_path_is_not() {
        for asset in [
            "../whisper-bin-x64.zip",
            "whisper-bin-x64.zip/../../x",
            "whisper-../x.zip",
            "/tmp/whisper-bin-x64.zip",
            "C:\\whisper-bin-x64.zip",
            "ffmpeg.zip",
            "whisper-bin-x64.exe",
            "whisper-bin-x64",
            ".zip",
            "",
        ] {
            assert!(!is_asset_name(asset), "{asset:?} was let through");
        }
    }

    #[test]
    fn a_folder_is_the_asset_without_its_suffix() {
        assert_eq!(folder_for("whisper-bin-x64.zip"), Some("whisper-bin-x64"));
        assert_eq!(folder_for("whisper-bin-ubuntu-x64.tar.gz"), Some("whisper-bin-ubuntu-x64"));
        assert_eq!(folder_for("whisper-bin-x64"), None);
    }

    /// A tree with the binary two levels down, which is where the Windows
    /// archives put it, and one with nothing in it at all.
    #[test]
    fn the_binary_is_found_wherever_the_archive_put_it() {
        let root = std::env::temp_dir().join(format!("plexfixer-whisper-{}", std::process::id()));
        let release = root.join("Release");
        std::fs::create_dir_all(&release).expect("a temporary tree");
        std::fs::write(release.join("ggml-base.dll"), b"x").expect("a file");
        std::fs::write(release.join(exe_name("whisper-cli")), b"x").expect("a file");

        // The stub that only prints "this program was renamed", which recent
        // archives ship beside the real one.
        std::fs::write(release.join(exe_name("main")), b"x").expect("a file");

        let found = find_binary(&root, 4).expect("the binary should be found");
        assert_eq!(found.file_name().unwrap().to_string_lossy(), exe_name("whisper-cli"));
        // Not deep enough to reach it.
        assert!(find_binary(&root, 1).is_none());
        assert!(tree_size(&root, 4) >= 2);

        std::fs::remove_dir_all(&root).ok();
    }
}
