//! Scripts the user adds — checks and repairs: discovery, approval, running.
//!
//! A script lives in its own folder under `<app data>/checks/<id>/` or
//! `<app data>/repairs/<id>/`, beside a
//! `plugin.json` that names it and says how to start it. Nothing in there runs
//! until the user has approved it, and the approval is of exactly the files
//! that were there: the folder is hashed when it is approved, and hashed again
//! every time it is about to run. Change one byte and it is no longer approved.
//!
//! What a script is and what it may do is decided in TypeScript, next to its
//! tests. This side holds only the parts that have to be true for running it
//! to be safe: what is in the folder, whether that is what was approved, and
//! the command line, which is the manifest's and never the caller's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::process::Command;

use crate::process::{spawn_streaming, Processes};
use crate::settings::{read_data_file, write_data_file, Store};

/// More files than this in one script's folder, and it is not a script.
const MOST_FILES: usize = 256;
/// The same for bytes: a repair script is a script, not a toolchain.
const MOST_BYTES: u64 = 16 * 1024 * 1024;
/// The manifest is read whole; nothing sensible is this large.
const LONGEST_MANIFEST: u64 = 256 * 1024;

const TRUST_FILE: &str = "script-trust.json";
const MANIFEST: &str = "plugin.json";

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Relative to the script's folder, with `/` between parts.
    path: String,
    size: u64,
}

/// One folder under `repairs/`, as found.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    id: String,
    dir: String,
    /// `plugin.json` as written, for TypeScript to read; absent when unreadable.
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    /// What the folder hashes to now.
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    /// What it hashed to when it was approved, if it ever was.
    #[serde(skip_serializing_if = "Option::is_none")]
    trusted_hash: Option<String>,
    files: Vec<FileEntry>,
    /// Why the folder cannot be a script, when it cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

/* ------------------------------------------------------------------ *
 * The folder and its hash
 * ------------------------------------------------------------------ */

/// Every file under `dir`, sorted, refusing anything that is not plainly a file.
///
/// Dotfiles are left out — `.DS_Store` and editor droppings should not make an
/// approved script unapproved — and symbolic links are refused outright: a link
/// is a way for the files that run to be somewhere other than what was hashed.
fn files_in(dir: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    fn walk(root: &Path, at: &Path, found: &mut Vec<(String, PathBuf, u64)>) -> Result<(), String> {
        let entries = std::fs::read_dir(at).map_err(|e| format!("could not read {}: {e}", at.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if kind.file_type().is_symlink() {
                return Err(format!("{name} is a link; scripts may only contain plain files"));
            }
            if kind.is_dir() {
                walk(root, &path, found)?;
            } else if kind.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                found.push((relative, path, kind.len()));
                if found.len() > MOST_FILES {
                    return Err(format!("more than {MOST_FILES} files"));
                }
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    walk(dir, dir, &mut found)?;
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let total: u64 = found.iter().map(|(_, _, size)| size).sum();
    if total > MOST_BYTES {
        return Err(format!("more than {} MB of files", MOST_BYTES / 1024 / 1024));
    }
    Ok(found)
}

/// SHA-256 over every file's relative path, length and bytes, in path order.
fn hash_folder(dir: &Path) -> Result<(String, Vec<FileEntry>), String> {
    let files = files_in(dir)?;
    let mut hasher = Sha256::new();
    for (relative, path, _) in &files {
        let bytes = std::fs::read(path).map_err(|e| format!("could not read {relative}: {e}"))?;
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update([0u8]);
        hasher.update(&bytes);
    }
    let digest = hasher.finalize();
    let hex = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let entries = files
        .into_iter()
        .map(|(path, _, size)| FileEntry { path, size })
        .collect();
    Ok((hex, entries))
}

/// What a script's id may be: it is a folder name and part of a flag id.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

/// The command line the manifest gives, with `{pluginDir}` filled in.
///
/// Only the manifest says what runs. Nothing from the caller reaches the
/// command line: what a script is told about the file arrives on stdin.
fn command_of(manifest: &Value, id: &str, dir: &Path) -> Result<Vec<String>, String> {
    if manifest.get("id").and_then(Value::as_str) != Some(id) {
        return Err(format!("plugin.json must say \"id\": \"{id}\", the name of its folder"));
    }
    let parts = manifest
        .get("command")
        .and_then(Value::as_array)
        .ok_or("plugin.json needs a \"command\": a list of the program and its arguments")?;
    let dir_text = dir.to_string_lossy();
    let argv = parts
        .iter()
        .map(|part| {
            part.as_str()
                .map(|text| text.replace("{pluginDir}", &dir_text))
                .ok_or_else(|| "every part of \"command\" must be text".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if argv.first().map(|program| program.trim().is_empty()).unwrap_or(true) {
        return Err("\"command\" must start with the program to run".into());
    }
    Ok(argv)
}

/* ------------------------------------------------------------------ *
 * Where things are
 * ------------------------------------------------------------------ */

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The folder a kind of script lives in. Only the two kinds there are: the
/// kind is a folder name, and nothing from the caller may become a path.
fn scripts_dir(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    match kind {
        "checks" | "repairs" => Ok(data_dir(app)?.join(kind)),
        other => Err(format!("{other} is not a kind of script")),
    }
}

/// Approvals are kept per kind: a check and a repair may share a name.
fn trust_key(kind: &str, id: &str) -> String {
    format!("{kind}/{id}")
}

async fn trusted(app: &AppHandle) -> BTreeMap<String, String> {
    let Ok(dir) = data_dir(app) else { return BTreeMap::new() };
    read_data_file(&dir, TRUST_FILE)
        .await
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

async fn save_trusted(app: &AppHandle, trust: &BTreeMap<String, String>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(trust).map_err(|e| e.to_string())?;
    write_data_file(&data_dir(app)?, TRUST_FILE, &text).await
}

fn read_manifest(dir: &Path) -> Result<String, String> {
    let path = dir.join(MANIFEST);
    let size = std::fs::metadata(&path)
        .map_err(|_| "there is no plugin.json in the folder".to_string())?
        .len();
    if size > LONGEST_MANIFEST {
        return Err("plugin.json is too large".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("could not read plugin.json: {e}"))
}

fn listing_of(id: String, dir: PathBuf, trusted_hash: Option<String>) -> Listing {
    let base = Listing {
        id: id.clone(),
        dir: dir.to_string_lossy().into_owned(),
        manifest: None,
        hash: None,
        trusted_hash,
        files: Vec::new(),
        problem: None,
    };
    if !valid_id(&id) {
        return Listing {
            problem: Some("folder names may use only lower-case letters, digits and dashes".into()),
            ..base
        };
    }
    let manifest = read_manifest(&dir);
    match hash_folder(&dir) {
        Ok((hash, files)) => Listing {
            manifest: manifest.as_ref().ok().cloned(),
            problem: manifest.err(),
            hash: Some(hash),
            files,
            ..base
        },
        Err(problem) => Listing {
            problem: Some(problem),
            ..base
        },
    }
}

/* ------------------------------------------------------------------ *
 * Writing a script from the form
 * ------------------------------------------------------------------ */

/// The largest file the form reads or writes; a script, not a data set.
const LONGEST_SOURCE: u64 = 1024 * 1024;
/// The most files the form writes in one go.
const MOST_SOURCES: usize = 32;

/// One of a script's files, as the form sees it.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    /// Relative to the script's folder, with `/` between parts.
    name: String,
    size: u64,
    /// The text, when the file is text and small enough to edit.
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    files: Vec<SourceFile>,
}

/// A name the form may write: one plain file in the script's folder.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name != MANIFEST
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

fn read_source(dir: &Path) -> Result<ScriptSource, String> {
    let manifest = read_manifest(dir).ok();
    let files = files_in(dir)?
        .into_iter()
        .filter(|(name, _, _)| name != MANIFEST)
        .map(|(name, path, size)| {
            let content = (size <= LONGEST_SOURCE)
                .then(|| std::fs::read(&path).ok())
                .flatten()
                .and_then(|bytes| String::from_utf8(bytes).ok());
            SourceFile { name, size, content }
        })
        .collect();
    Ok(ScriptSource { manifest, files })
}

/// Write a script's manifest and files under `root/<id>`.
///
/// `previous` is the id it was saved under before, or `None` for a new
/// script, which may not take the folder of one that is already there. Files
/// not named in `write` or `remove` are left as they are.
fn save_source(
    root: &Path,
    id: &str,
    previous: Option<&str>,
    manifest: &str,
    write: &BTreeMap<String, String>,
    remove: &[String],
) -> Result<(), String> {
    if !valid_id(id) {
        return Err("the id may use only lower-case letters, digits and dashes".into());
    }
    let parsed: Value = serde_json::from_str(manifest).map_err(|e| format!("the manifest is not JSON: {e}"))?;
    if parsed.get("id").and_then(Value::as_str) != Some(id) {
        return Err(format!("the manifest must be for {id}"));
    }
    if manifest.len() as u64 > LONGEST_MANIFEST {
        return Err("the manifest is too large".into());
    }
    if write.len() > MOST_SOURCES {
        return Err(format!("a script may be saved with at most {MOST_SOURCES} files"));
    }
    if let Some(name) = write.keys().chain(remove).find(|name| !plain_name(name)) {
        return Err(format!("\"{name}\" cannot be a file name here"));
    }
    if let Some((name, _)) = write.iter().find(|(_, text)| text.len() as u64 > LONGEST_SOURCE) {
        return Err(format!("{name} is larger than 1 MB"));
    }

    let dir = root.join(id);
    match previous {
        None => {
            if dir.exists() {
                return Err(format!("there is already a script called {id}"));
            }
            std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {id}: {e}"))?;
        }
        Some(previous) if previous != id => {
            if !valid_id(previous) {
                return Err(format!("{previous} is not a script id"));
            }
            if dir.exists() {
                return Err(format!("there is already a script called {id}"));
            }
            std::fs::rename(root.join(previous), &dir).map_err(|e| format!("could not rename {previous}: {e}"))?;
        }
        Some(_) => {
            if !dir.is_dir() {
                return Err(format!("there is no script called {id}"));
            }
        }
    }

    for name in remove.iter().filter(|name| !write.contains_key(*name)) {
        match std::fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("could not remove {name}: {e}")),
            _ => {}
        }
    }
    for (name, text) in write {
        std::fs::write(dir.join(name), text).map_err(|e| format!("could not write {name}: {e}"))?;
    }
    std::fs::write(dir.join(MANIFEST), manifest).map_err(|e| format!("could not write the manifest: {e}"))
}

/// A picked file, as text the form can hold.
fn imported(path: &Path) -> Result<SourceFile, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| plain_name(name))
        .ok_or("that file's name cannot be used in a script")?;
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > LONGEST_SOURCE {
        return Err(format!("{name} is larger than 1 MB"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("could not read {name}: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|_| format!("{name} is not a text file"))?;
    Ok(SourceFile { name, size, content: Some(content) })
}

type ExampleFiles = Vec<(&'static str, &'static str)>;

/// The examples that ship inside the app, by kind and name.
fn example_files(kind: &str, example: &str) -> Option<(&'static str, ExampleFiles)> {
    match (kind, example) {
        ("checks", "subtitle-ads") => Some((
            "subtitle-ads",
            vec![
                (MANIFEST, include_str!("../../examples/checks/subtitle-ads/plugin.json")),
                ("check.py", include_str!("../../examples/checks/subtitle-ads/check.py")),
            ],
        )),
        ("repairs", "subtitle-scrub") => Some((
            "subtitle-scrub",
            vec![
                (MANIFEST, include_str!("../../examples/repairs/subtitle-scrub/plugin.json")),
                ("scrub.py", include_str!("../../examples/repairs/subtitle-scrub/scrub.py")),
            ],
        )),
        _ => None,
    }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/// Every folder under `repairs/`, hashed.
#[tauri::command]
pub async fn plugins_list(app: AppHandle, kind: String) -> Result<Vec<Listing>, String> {
    let root = scripts_dir(&app, &kind)?;
    let trust = trusted(&app).await;
    tokio::task::spawn_blocking(move || {
        let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
        let mut listings: Vec<Listing> = entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with('.'))
            .map(|id| {
                let dir = root.join(&id);
                let trusted_hash = trust.get(&trust_key(&kind, &id)).cloned();
                listing_of(id, dir, trusted_hash)
            })
            .collect();
        listings.sort_by(|a, b| a.id.cmp(&b.id));
        listings
    })
    .await
    .map_err(|e| e.to_string())
}

/// A script's files as the form edits them: its manifest, and the text of the rest.
#[tauri::command]
pub async fn plugins_read(app: AppHandle, kind: String, id: String) -> Result<ScriptSource, String> {
    if !valid_id(&id) {
        return Err(format!("{id} is not a script id"));
    }
    let dir = scripts_dir(&app, &kind)?.join(&id);
    tokio::task::spawn_blocking(move || read_source(&dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Write a script from the form: a new one, or an existing one under its old id.
///
/// Whatever is written, the folder's hash changes with it, so a script saved
/// here is no longer approved and has to be approved again before it runs.
/// When the id changes the folder moves, and the old id's approval goes.
#[tauri::command]
pub async fn plugins_save(
    app: AppHandle,
    kind: String,
    id: String,
    previous_id: Option<String>,
    manifest: String,
    write: BTreeMap<String, String>,
    remove: Vec<String>,
) -> Result<(), String> {
    let root = scripts_dir(&app, &kind)?;
    let saved = {
        let (id, previous_id) = (id.clone(), previous_id.clone());
        tokio::task::spawn_blocking(move || {
            save_source(&root, &id, previous_id.as_deref(), &manifest, &write, &remove)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    saved?;
    if let Some(previous) = previous_id.filter(|previous| *previous != id) {
        let mut trust = trusted(&app).await;
        if trust.remove(&trust_key(&kind, &previous)).is_some() {
            save_trusted(&app, &trust).await?;
        }
    }
    Ok(())
}

/// A file the user picks, read as text for the form to put in a script.
///
/// The webview never names the path: the native picker does, and only what
/// was picked is read. `None` when the user cancels.
#[tauri::command]
pub async fn plugins_import_file(app: AppHandle) -> Result<Option<SourceFile>, String> {
    let (answer, asked) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose the script file")
        .pick_file(move |picked| {
            let _ = answer.send(picked);
        });
    let Some(picked) = asked.await.unwrap_or(None) else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || imported(&path).map(Some))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a script, after asking in a native dialog; true when it is gone.
#[tauri::command]
pub async fn plugins_delete(app: AppHandle, kind: String, id: String) -> Result<bool, String> {
    if !valid_id(&id) {
        return Err(format!("{id} is not a script id"));
    }
    let dir = scripts_dir(&app, &kind)?.join(&id);
    let (answer, asked) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!("Delete the script \"{id}\" and all of its files? This cannot be undone."))
        .title("Delete this script?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Delete".into(), "Cancel".into()))
        .show(move |confirmed| {
            let _ = answer.send(confirmed);
        });
    if !asked.await.unwrap_or(false) {
        return Ok(false);
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("could not delete {id}: {e}"))?;
    let mut trust = trusted(&app).await;
    if trust.remove(&trust_key(&kind, &id)).is_some() {
        save_trusted(&app, &trust).await?;
    }
    Ok(true)
}

/// Add one of the examples that ship with the app, as a new script; its id.
#[tauri::command]
pub async fn plugins_add_example(app: AppHandle, kind: String, example: String) -> Result<String, String> {
    let (id, files) = example_files(&kind, &example).ok_or_else(|| format!("there is no example called {example}"))?;
    let root = scripts_dir(&app, &kind)?;
    tokio::task::spawn_blocking(move || {
        let manifest = files.iter().find(|(name, _)| *name == MANIFEST).map(|(_, text)| *text).unwrap_or("");
        let write = files
            .iter()
            .filter(|(name, _)| *name != MANIFEST)
            .map(|(name, text)| (name.to_string(), text.to_string()))
            .collect();
        save_source(&root, id, None, manifest, &write, &[]).map(|_| id.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ask the user, in a native dialog, to approve a script as it is now.
///
/// The dialog is built here from what this side read off the disk — the
/// command, the files and the hash — so nothing the webview says can make a
/// script look like something it is not, and the approval is recorded only
/// for the hash shown.
#[tauri::command]
pub async fn plugins_trust(app: AppHandle, kind: String, id: String) -> Result<bool, String> {
    if !valid_id(&id) {
        return Err(format!("{id} is not a script id"));
    }
    let dir = scripts_dir(&app, &kind)?.join(&id);
    let listing = {
        let dir = dir.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || listing_of(id, dir, None))
            .await
            .map_err(|e| e.to_string())?
    };
    if let Some(problem) = listing.problem {
        return Err(problem);
    }
    let (Some(text), Some(hash)) = (listing.manifest, listing.hash) else {
        return Err("the script could not be read".into());
    };
    let manifest: Value = serde_json::from_str(&text).map_err(|e| format!("plugin.json is not JSON: {e}"))?;
    let argv = command_of(&manifest, &id, &dir)?;
    let name = manifest.get("name").and_then(Value::as_str).unwrap_or(&id);
    let files = listing
        .files
        .iter()
        .map(|file| format!("  {} ({} bytes)", file.path, file.size))
        .collect::<Vec<_>>()
        .join("\n");
    let role = if kind == "checks" { "check" } else { "repair" };
    let message = format!(
        "This {role} script, \"{name}\", will be able to run on this computer, as you, on the media files it is given.\n\n\
         It starts:\n  {}\n\nThe program is found on your PATH as it is when it runs; only the files below are \
         checked.\n\nFiles:\n{files}\n\nFingerprint {}\n\nApprove it only if you know what it does. Any change to \
         these files withdraws the approval.",
        argv.join(" "),
        &hash[..16]
    );

    let (answer, asked) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(if kind == "checks" { "Approve this check script?" } else { "Approve this repair script?" })
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Approve".into(), "Cancel".into()))
        .show(move |approved| {
            let _ = answer.send(approved);
        });
    let approved = asked.await.unwrap_or(false);
    if approved {
        let mut trust = trusted(&app).await;
        trust.insert(trust_key(&kind, &id), hash);
        save_trusted(&app, &trust).await?;
    }
    Ok(approved)
}

/// Withdraw a script's approval.
#[tauri::command]
pub async fn plugins_revoke(app: AppHandle, kind: String, id: String) -> Result<(), String> {
    scripts_dir(&app, &kind)?;
    let mut trust = trusted(&app).await;
    if trust.remove(&trust_key(&kind, &id)).is_some() {
        save_trusted(&app, &trust).await?;
    }
    Ok(())
}

/// Run an approved script, streaming its output like any other process.
///
/// Checked again here, every time: the folder must hash to what was approved,
/// and the work must be on this computer — a script is approved to run here,
/// not on whatever machine the remote host setting points at.
#[tauri::command]
pub async fn plugin_start(
    app: AppHandle,
    kind: String,
    id: String,
    process_id: String,
    input: String,
    processes: State<'_, Processes>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("{id} is not a script id"));
    }
    let remote = app
        .state::<Store>()
        .settings()
        .await
        .get("remoteEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if remote {
        return Err("Repair scripts only run on this computer, and the remote host is switched on.".into());
    }

    let dir = scripts_dir(&app, &kind)?.join(&id);
    let approved = trusted(&app).await.get(&trust_key(&kind, &id)).cloned();
    let (hash, text) = {
        let dir = dir.clone();
        tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
            let (hash, _) = hash_folder(&dir)?;
            Ok((hash, read_manifest(&dir)?))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    match approved {
        None => return Err(format!("{id} has not been approved. Approve it under Settings → Checks & repairs.")),
        Some(approved) if approved != hash => {
            return Err(format!("{id} has changed since it was approved. Review it and approve it again."))
        }
        Some(_) => {}
    }

    let manifest: Value = serde_json::from_str(&text).map_err(|e| format!("plugin.json is not JSON: {e}"))?;
    let argv = command_of(&manifest, &id, &dir)?;
    let mut builder = Command::new(&argv[0]);
    builder.args(&argv[1..]).current_dir(&dir);
    spawn_streaming(&app, process_id, builder, argv.join(" "), Some(input), &processes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plexfixer-plugins-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_hash_is_stable_and_follows_every_byte() {
        let dir = scratch("hash");
        std::fs::write(dir.join("plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(dir.join("lib/scrub.py"), "print('hi')").unwrap();
        let (first, files) = hash_folder(&dir).unwrap();
        assert_eq!(hash_folder(&dir).unwrap().0, first);
        assert_eq!(
            files,
            vec![
                FileEntry { path: "lib/scrub.py".into(), size: 11 },
                FileEntry { path: "plugin.json".into(), size: 2 }
            ]
        );

        std::fs::write(dir.join("lib/scrub.py"), "print('ho')").unwrap();
        let edited = hash_folder(&dir).unwrap().0;
        assert_ne!(edited, first);

        std::fs::write(dir.join("extra.txt"), "").unwrap();
        assert_ne!(hash_folder(&dir).unwrap().0, edited);
    }

    #[test]
    fn dotfiles_do_not_count() {
        let dir = scratch("dot");
        std::fs::write(dir.join("plugin.json"), "{}").unwrap();
        let before = hash_folder(&dir).unwrap().0;
        std::fs::write(dir.join(".DS_Store"), "junk").unwrap();
        assert_eq!(hash_folder(&dir).unwrap().0, before);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_refused() {
        let dir = scratch("link");
        std::fs::write(dir.join("plugin.json"), "{}").unwrap();
        std::os::unix::fs::symlink("/bin/sh", dir.join("sh")).unwrap();
        assert!(hash_folder(&dir).unwrap_err().contains("link"));
    }

    #[test]
    fn too_many_files_are_refused() {
        let dir = scratch("many");
        for n in 0..=MOST_FILES {
            std::fs::write(dir.join(format!("f{n}")), "").unwrap();
        }
        assert!(hash_folder(&dir).unwrap_err().contains("more than"));
    }

    #[test]
    fn ids_are_plain() {
        assert!(valid_id("subtitle-scrub"));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("Scrub"));
        assert!(!valid_id(""));
        assert!(!valid_id("-x"));
    }

    #[test]
    fn the_command_is_the_manifests_with_only_the_folder_filled_in() {
        let dir = PathBuf::from("/data/repairs/scrub");
        let manifest = json!({ "id": "scrub", "command": ["python3", "{pluginDir}/scrub.py", "--fast"] });
        assert_eq!(
            command_of(&manifest, "scrub", &dir).unwrap(),
            vec!["python3", "/data/repairs/scrub/scrub.py", "--fast"]
        );
    }

    #[test]
    fn a_manifest_for_another_folder_or_without_a_command_is_refused() {
        let dir = PathBuf::from("/x");
        assert!(command_of(&json!({ "id": "other", "command": ["a"] }), "scrub", &dir).is_err());
        assert!(command_of(&json!({ "id": "scrub" }), "scrub", &dir).is_err());
        assert!(command_of(&json!({ "id": "scrub", "command": [] }), "scrub", &dir).is_err());
        assert!(command_of(&json!({ "id": "scrub", "command": ["a", 3] }), "scrub", &dir).is_err());
    }

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries.iter().map(|(name, text)| (name.to_string(), text.to_string())).collect()
    }

    #[test]
    fn a_saved_script_reads_back() {
        let root = scratch("save");
        let manifest = r#"{"id":"scrub","command":["python3"]}"#;
        save_source(&root, "scrub", None, manifest, &files(&[("scrub.py", "print(1)")]), &[]).unwrap();
        let source = read_source(&root.join("scrub")).unwrap();
        assert_eq!(source.manifest.as_deref(), Some(manifest));
        assert_eq!(
            source.files,
            vec![SourceFile { name: "scrub.py".into(), size: 8, content: Some("print(1)".into()) }]
        );

        // A second new script may not take the folder.
        assert!(save_source(&root, "scrub", None, manifest, &BTreeMap::new(), &[]).is_err());

        // Saving again replaces what is named, removes what is asked, keeps the rest.
        std::fs::write(root.join("scrub/keep.txt"), "kept").unwrap();
        save_source(&root, "scrub", Some("scrub"), manifest, &files(&[("new.py", "x")]), &["scrub.py".into()]).unwrap();
        let names: Vec<_> = read_source(&root.join("scrub")).unwrap().files.into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["keep.txt", "new.py"]);
    }

    #[test]
    fn a_new_id_moves_the_folder() {
        let root = scratch("rename");
        save_source(&root, "old", None, r#"{"id":"old"}"#, &files(&[("a.py", "a")]), &[]).unwrap();
        save_source(&root, "new", Some("old"), r#"{"id":"new"}"#, &BTreeMap::new(), &[]).unwrap();
        assert!(!root.join("old").exists());
        assert!(root.join("new/a.py").is_file());
    }

    #[test]
    fn only_plain_names_in_its_own_folder_are_written() {
        let root = scratch("names");
        let manifest = r#"{"id":"s"}"#;
        for bad in ["../escape.py", "sub/dir.py", ".hidden", "plugin.json", ""] {
            assert!(save_source(&root, "s", None, manifest, &files(&[(bad, "x")]), &[]).is_err(), "{bad}");
        }
        assert!(save_source(&root, "s", None, manifest, &BTreeMap::new(), &["../x".into()]).is_err());
        assert!(save_source(&root, "s", None, r#"{"id":"other"}"#, &BTreeMap::new(), &[]).is_err());
        assert!(save_source(&root, "../s", None, r#"{"id":"../s"}"#, &BTreeMap::new(), &[]).is_err());
    }

    #[test]
    fn the_examples_are_for_their_own_folders() {
        for (kind, example) in [("checks", "subtitle-ads"), ("repairs", "subtitle-scrub")] {
            let (id, files) = example_files(kind, example).unwrap();
            let manifest: Value = serde_json::from_str(files[0].1).unwrap();
            assert_eq!(manifest["id"], id);
            assert!(files.iter().skip(1).all(|(name, _)| plain_name(name)));
        }
        assert!(example_files("checks", "subtitle-scrub").is_none());
    }
}
