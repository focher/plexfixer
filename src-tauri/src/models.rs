//! Fetching a Whisper model, which is the part nobody can be bothered to do.
//!
//! Transcribing on this machine needs two files: a `whisper-cli` binary, which
//! a package manager will install, and a model, which nothing installs. The
//! model is a few hundred megabytes from Hugging Face with a name like
//! `ggml-large-v3-turbo-q5_0.bin`, and until it is on disk the feature simply
//! does not work. So the app fetches it.
//!
//! Three things make this different from `net_fetch`, which is why it is not
//! that:
//!
//! - **It is too big to hold.** `net_fetch` reads a reply into memory and caps
//!   it at eight megabytes. This streams to a file and never holds more than
//!   one chunk.
//! - **It has to follow a redirect.** Hugging Face answers a download with a
//!   302 to its CDN, and `net_fetch` follows nothing on purpose. This follows,
//!   but only to Hugging Face's own hosts.
//! - **What lands has to be what was asked for.** A model file is read by a
//!   binary this app then runs, so the download is hashed as it is written and
//!   thrown away if the hash does not match the one the catalogue pinned.
//!
//! The address is not an argument. The caller names a *file*, whose shape is
//! checked here, and the URL is built from a prefix written into the binary —
//! the same arrangement as `allowed_binary` and `net::is_allowed`, and for the
//! same reason: a caller that could hand over both the address and the
//! permission for it has not been checked at all. The hash does come from the
//! caller, which is a smaller trust: with it, a caller can ask for a different
//! file *from that one repository* and have it verified against a hash it also
//! supplied. What it cannot do is reach any other host, or put the result
//! anywhere but this app's own models folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::net::{under_host, url_lite};

/// The event a model download reports progress on.
const MODEL_PROGRESS: &str = "plexfixer://model-progress";

/// Where the models come from. A prefix, ending at the file name.
const REPOSITORY: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// Hosts a download may be redirected to.
///
/// `huggingface.co` answers with a 302 to a CDN under `hf.co` —
/// `us.aws.cdn.hf.co` today, and it has been other names before. Pinning the
/// CDN's name would break this the next time they move it, so the rule is the
/// two domains the service uses and nothing else.
const DOWNLOAD_HOSTS: &[&str] = &[
    "huggingface.co",
    "hf.co",
    // The whisper.cpp builds come from GitHub's releases, which answer with a
    // redirect to their asset host. `whisper.rs` fetches those through the
    // same door, so its hosts are in the same list.
    "github.com",
    "githubusercontent.com",
];

/// How many redirects to follow before deciding something is wrong.
const MAX_REDIRECTS: usize = 5;

/// A ceiling on any model file, well above the largest in the catalogue.
///
/// The expected size is also checked exactly, from the catalogue; this is the
/// backstop for a reply that keeps coming with no expectation to check it
/// against.
const LARGEST_MODEL: u64 = 8 * 1024 * 1024 * 1024;

/// What one chunk may be before the page is told about it again.
///
/// A progress event per chunk is thousands of events for a half-gigabyte file
/// and the webview spends longer drawing them than the download takes. Four
/// megabytes is about a hundred updates over a large model.
const PROGRESS_EVERY: u64 = 4 * 1024 * 1024;

/// And a floor on time, so a slow connection still moves the bar.
const PROGRESS_AT_LEAST_EVERY: Duration = Duration::from_millis(500);

/// Downloads that have been asked to stop, and what is in flight.
///
/// Keyed by file name because one model is one download: asking for the same
/// model twice is a mistake rather than two jobs, and the second request is
/// refused rather than racing the first into the same file.
#[derive(Default)]
pub struct Downloads {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    running: HashSet<String>,
    cancelled: HashSet<String>,
}

impl Downloads {
    /// Claim this file, or say who already has it.
    pub(crate) fn start(&self, file: &str) -> bool {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.cancelled.remove(file);
        state.running.insert(file.to_string())
    }

    pub(crate) fn finish(&self, file: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.running.remove(file);
        state.cancelled.remove(file);
    }

    pub(crate) fn cancel(&self, file: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if state.running.contains(file) {
            state.cancelled.insert(file.to_string());
        }
    }

    pub(crate) fn is_cancelled(&self, file: &str) -> bool {
        let state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.cancelled.contains(file)
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    file: String,
    received_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    file: String,
    path: String,
    size_bytes: u64,
}

/* ------------------------------------------------------------------ *
 * The two checks on what the caller said
 * ------------------------------------------------------------------ */

/// Whether `name` is a model file name and not something else wearing one.
///
/// The point of this is that the name is joined to a directory, so anything
/// that could make it a path — a separator, a parent, a drive letter, a
/// trailing dot on Windows — must not get through. The allowed set is narrow
/// enough that none of those can be expressed in it.
fn is_model_file(name: &str) -> bool {
    if !name.starts_with("ggml-") || !name.ends_with(".bin") || name.len() > 72 {
        return false;
    }
    if name.contains("..") {
        return false;
    }
    // `_` is in the set because the quantised models are named for their
    // quantisation — `ggml-medium.en-q5_0.bin` — and it is not a separator on
    // any platform.
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Whether `hash` is a SHA-256 written the way this expects it.
pub(crate) fn is_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Whether a redirect may be followed.
pub(crate) fn redirect_allowed(url: &str) -> bool {
    let Some(parsed) = url_lite::parse(url) else {
        return false;
    };
    parsed.scheme == "https" && DOWNLOAD_HOSTS.iter().any(|host| under_host(&parsed.host, host))
}

/* ------------------------------------------------------------------ *
 * Where they live
 * ------------------------------------------------------------------ */

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models"))
}

/// The folder the models are kept in, created if it is not there yet.
#[tauri::command]
pub async fn model_directory(app: AppHandle) -> Result<String, String> {
    let dir = models_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Every model already here, by file name.
///
/// Partial downloads are left out: a `.part` file is not a model, and showing
/// one as if it were is how somebody comes to point Settings at a half a model
/// and get an unreadable error out of Whisper.
#[tauri::command]
pub async fn models_installed(app: AppHandle) -> Result<Vec<Installed>, String> {
    let dir = models_dir(&app)?;
    let mut found = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Ok(found);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_model_file(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata().await else { continue };
        if !meta.is_file() {
            continue;
        }
        found.push(Installed {
            file: name,
            path: entry.path().to_string_lossy().into_owned(),
            size_bytes: meta.len(),
        });
    }
    found.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(found)
}

/// Delete one model this app fetched.
///
/// Only ever inside the app's own models folder, and only something shaped like
/// a model: this is not a general "remove a file" command.
#[tauri::command]
pub async fn model_remove(app: AppHandle, file: String) -> Result<(), String> {
    if !is_model_file(&file) {
        return Err(format!("{file} is not a model file name"));
    }
    let path = models_dir(&app)?.join(&file);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

/// Stop a download that is under way.
///
/// The loop checks between chunks, so this takes effect within one chunk
/// rather than immediately. The half-written file is removed by the loop, not
/// here, so that nothing deletes a file another task is still writing.
#[tauri::command]
pub async fn model_cancel(file: String, downloads: State<'_, Downloads>) -> Result<(), String> {
    downloads.cancel(&file);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * The download
 * ------------------------------------------------------------------ */

/// Fetch one model, hash it as it arrives, and keep it only if it matches.
///
/// `Ok(Some(path))` is a model on disk. `Ok(None)` means it was cancelled,
/// which is a thing the person did rather than a failure to report. `Err` is a
/// failure, and the partial file is gone either way.
#[tauri::command]
pub async fn model_download(
    app: AppHandle,
    file: String,
    sha256: String,
    size_bytes: u64,
) -> Result<Option<String>, String> {
    if !is_model_file(&file) {
        return Err(format!("{file} is not a model file name"));
    }
    if !is_sha256(&sha256) {
        return Err("a model is only fetched against a SHA-256 to check it with".to_string());
    }
    if size_bytes == 0 || size_bytes > LARGEST_MODEL {
        return Err(format!("{size_bytes} is not a plausible size for a model"));
    }

    let downloads = app.state::<Downloads>();
    if !downloads.start(&file) {
        return Err(format!("{file} is already being fetched"));
    }
    let outcome = fetch(&app, &file, &sha256, size_bytes).await;
    app.state::<Downloads>().finish(&file);
    outcome
}

async fn fetch(app: &AppHandle, file: &str, sha256: &str, size_bytes: u64) -> Result<Option<String>, String> {
    let dir = models_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let target = dir.join(file);
    // Already here and already right: nothing to do. Checked by hash rather
    // than by size so that a truncated file from an older build is replaced
    // rather than trusted.
    if let Ok(existing) = tokio::fs::metadata(&target).await {
        if existing.is_file() && existing.len() == size_bytes && hash_of(&target).await.as_deref() == Some(sha256) {
            return Ok(Some(target.to_string_lossy().into_owned()));
        }
    }

    // `.part` beside the model, for the same reason ffmpeg writes beside its
    // destination: the finish is a rename on one volume, so there is no moment
    // where a half-written file is sitting where a model belongs.
    let partial = dir.join(format!("{file}.part"));
    let _ = tokio::fs::remove_file(&partial).await;

    let response = start_get(&format!("{REPOSITORY}{file}"), "Hugging Face", size_bytes).await?;
    let written = stream_to_file(
        app,
        response,
        &partial,
        file,
        MODEL_PROGRESS,
        file,
        sha256,
        size_bytes,
    )
    .await;
    match written {
        Ok(true) => {
            tokio::fs::rename(&partial, &target)
                .await
                .map_err(|e| format!("could not put {} in place: {e}", target.display()))?;
            Ok(Some(target.to_string_lossy().into_owned()))
        }
        Ok(false) => {
            let _ = tokio::fs::remove_file(&partial).await;
            Ok(None)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&partial).await;
            Err(error)
        }
    }
}

/// Begin a download, with the two things worth refusing before any bytes.
///
/// `what` is the service's name, for a message that says who answered rather
/// than what library was used. The size is checked against what the reply says
/// it will send, so a file that is not the file the catalogue describes is
/// refused now rather than downloaded and then thrown away.
pub(crate) async fn start_get(url: &str, what: &str, size_bytes: u64) -> Result<reqwest::Response, String> {
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| describe(&error))?;

    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            404 => format!("{what} does not have that file."),
            status => format!("{what} answered {status}."),
        });
    }

    if let Some(stated) = response.content_length() {
        if stated != size_bytes {
            return Err(format!(
                "that file is {} MB, and this expected {} MB — the catalogue is out of date.",
                stated / (1024 * 1024),
                size_bytes / (1024 * 1024)
            ));
        }
    }

    Ok(response)
}

/// Stream the body to `partial`, hashing as it goes. `false` means cancelled.
///
/// Shared with `whisper.rs`, which fetches an archive rather than a model: the
/// streaming, the hashing, the ceiling and the cancel check are the same job
/// whatever is on the far end, and this is the security-critical half of it.
/// `label` is what progress is reported under and `cancel_key` is what a stop
/// request names, which for a model are both the file name.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_to_file(
    app: &AppHandle,
    mut response: reqwest::Response,
    partial: &Path,
    label: &str,
    event: &'static str,
    cancel_key: &str,
    sha256: &str,
    size_bytes: u64,
) -> Result<bool, String> {
    let mut handle = tokio::fs::File::create(partial)
        .await
        .map_err(|e| format!("could not write {}: {e}", partial.display()))?;
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);

    let mut received: u64 = 0;
    let mut announced: u64 = 0;
    let mut announced_at = Instant::now();
    let _ = app.emit(
        event,
        Progress { file: label.to_string(), received_bytes: 0, total_bytes: size_bytes },
    );

    loop {
        if app.state::<Downloads>().is_cancelled(cancel_key) {
            return Ok(false);
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => return Err(describe(&error)),
        };
        received += chunk.len() as u64;
        if received > size_bytes {
            return Err(format!("{label} is longer than it said it would be"));
        }
        digest.update(&chunk);
        handle
            .write_all(&chunk)
            .await
            .map_err(|e| format!("could not write {}: {e}", partial.display()))?;

        if received - announced >= PROGRESS_EVERY || announced_at.elapsed() >= PROGRESS_AT_LEAST_EVERY {
            announced = received;
            announced_at = Instant::now();
            let _ = app.emit(
                event,
                Progress { file: label.to_string(), received_bytes: received, total_bytes: size_bytes },
            );
        }
    }

    handle
        .flush()
        .await
        .map_err(|e| format!("could not finish writing {}: {e}", partial.display()))?;
    drop(handle);

    if received != size_bytes {
        return Err(format!(
            "the download stopped {} MB short",
            (size_bytes - received) / (1024 * 1024)
        ));
    }

    let got = hex(digest.finish().as_ref());
    if got != sha256 {
        return Err(format!(
            "{label} downloaded, but it is not the file the catalogue describes — it has been thrown away."
        ));
    }

    let _ = app.emit(
        event,
        Progress { file: label.to_string(), received_bytes: size_bytes, total_bytes: size_bytes },
    );
    Ok(true)
}

/// The SHA-256 of a file already on disk, or `None` if it cannot be read.
pub(crate) async fn hash_of(path: &Path) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut handle = tokio::fs::File::open(path).await.ok()?;
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    // A megabyte at a time: the files are gigabytes and this runs on the main
    // async runtime.
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = handle.read(&mut buffer).await.ok()?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Some(hex(digest.finish().as_ref()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A client that follows Hugging Face's redirects and nobody else's.
pub(crate) fn client() -> Result<reqwest::Client, String> {
    crate::net::install_crypto_provider();
    reqwest::Client::builder()
        // No overall timeout: a three-gigabyte model on a slow line takes as
        // long as it takes, and a timeout here would cancel it at the worst
        // moment. The read timeout is what catches a connection that has died.
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            if redirect_allowed(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

pub(crate) fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "huggingface.co stopped answering".to_string();
    }
    if error.is_connect() {
        return "could not reach huggingface.co".to_string();
    }
    format!("the download failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_names_are_accepted() {
        for file in [
            "ggml-base.en.bin",
            "ggml-small.en.bin",
            "ggml-medium.en-q5_0.bin",
            "ggml-large-v3-turbo-q5_0.bin",
            "ggml-large-v3.bin",
        ] {
            assert!(is_model_file(file), "{file} was refused");
        }
    }

    /// The whole point of the check: a name is joined to a directory, so
    /// nothing in it may be a path.
    #[test]
    fn a_name_that_is_really_a_path_is_not() {
        for file in [
            "../ggml-base.en.bin",
            "ggml-base.en.bin/../../../etc/passwd",
            "ggml-../base.bin",
            "ggml-base.en.bin ",
            "/etc/ggml-passwd.bin",
            "C:\\ggml-x.bin",
            "ggml-x.bin\0",
            "ffmpeg",
            "ggml-base.en.exe",
            "base.en.bin",
            "",
        ] {
            assert!(!is_model_file(file), "{file:?} was let through");
        }
    }

    #[test]
    fn a_hash_has_to_look_like_one() {
        assert!(is_sha256("394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"));
        // Too short, uppercase, and not hex at all.
        assert!(!is_sha256("3942217"));
        assert!(!is_sha256("394221709CD5AD1F40C46E6031CA61BCE88931E6E088C188294C6D5A55FFA7E2"));
        assert!(!is_sha256("zzzz21709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"));
    }

    /// Hugging Face answers with a 302 to a CDN under `hf.co`, and that is the
    /// only place a redirect goes.
    #[test]
    fn a_redirect_follows_hugging_face_and_nothing_else() {
        assert!(redirect_allowed("https://us.aws.cdn.hf.co/repos/abc/ggml-base.en.bin"));
        assert!(redirect_allowed("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"));
        for url in [
            "http://us.aws.cdn.hf.co/repos/abc/ggml-base.en.bin",
            "https://nothf.co/x.bin",
            "https://hf.co.example.net/x.bin",
            "https://example.net/x.bin",
            "file:///etc/passwd",
        ] {
            assert!(!redirect_allowed(url), "{url} would have been followed");
        }
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff, 0xa0]), "000fffa0");
    }

    /// Asking twice for the same model is a mistake, not two downloads.
    #[test]
    fn one_download_per_file() {
        let downloads = Downloads::default();
        assert!(downloads.start("ggml-base.en.bin"));
        assert!(!downloads.start("ggml-base.en.bin"));
        assert!(downloads.start("ggml-large-v3.bin"));

        assert!(!downloads.is_cancelled("ggml-base.en.bin"));
        downloads.cancel("ggml-base.en.bin");
        assert!(downloads.is_cancelled("ggml-base.en.bin"));

        downloads.finish("ggml-base.en.bin");
        assert!(!downloads.is_cancelled("ggml-base.en.bin"));
        assert!(downloads.start("ggml-base.en.bin"));
    }

    /// Cancelling something that is not running must not leave a flag behind
    /// for the next download of it to trip over.
    #[test]
    fn cancelling_what_is_not_running_does_nothing() {
        let downloads = Downloads::default();
        downloads.cancel("ggml-base.en.bin");
        assert!(!downloads.is_cancelled("ggml-base.en.bin"));
        assert!(downloads.start("ggml-base.en.bin"));
        assert!(!downloads.is_cancelled("ggml-base.en.bin"));
    }
}
