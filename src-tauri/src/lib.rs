//! PlexFixer's native side.
//!
//! The split with the Electron build it replaces is deliberate and worth
//! stating once: **Rust does the things only a native process can do — spawn
//! ffmpeg, walk a filesystem, open a native dialog, write the settings file —
//! and TypeScript keeps every decision.** The analysis engine, the
//! compatibility rules, the H.264 SPS parser, the repair-command builder and
//! the Dolby Vision logic all stay in `src/shared`, where they already have
//! tests, and they run in the webview exactly as they ran in the renderer.
//!
//! That is what makes this port survivable: the half of the app worth being
//! careful about never moves.

mod environment;
mod host;
mod locate;
mod menu;
mod process;
mod settings;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use environment::Environment;
use settings::Store;

/// The environment probe runs real test encodes, so it is cached against the
/// inputs that change it and only redone when one of them does.
#[derive(Default)]
struct EnvironmentCache {
    inner: Mutex<Option<(String, Environment)>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct About {
    version: String,
    packaged: bool,
    /// The Tauri runtime's version, for the About panel.
    tauri: String,
    /// WKWebView on macOS, WebView2 on Windows.
    webview: String,
    platform: String,
    arch: String,
    system_version: String,
    user_data_path: String,
}

#[tauri::command]
async fn settings_get(store: State<'_, Store>) -> Result<Map<String, Value>, String> {
    Ok(store.settings().await)
}

#[tauri::command]
async fn settings_update(
    patch: Map<String, Value>,
    store: State<'_, Store>,
) -> Result<Map<String, Value>, String> {
    store.update(patch).await
}

#[tauri::command]
async fn settings_reset(store: State<'_, Store>) -> Result<Map<String, Value>, String> {
    store.reset().await
}

#[tauri::command]
async fn overrides_get(store: State<'_, Store>) -> Result<Map<String, Value>, String> {
    Ok(store.overrides().await)
}

#[tauri::command]
async fn overrides_set(
    path: String,
    mode: Option<String>,
    store: State<'_, Store>,
) -> Result<Map<String, Value>, String> {
    store.set_override(path, mode).await
}

#[tauri::command]
async fn environment_resolve(
    app: AppHandle,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    dolby_vision_filter: String,
    force: bool,
    cache: State<'_, EnvironmentCache>,
) -> Result<Environment, String> {
    let key = format!(
        "{}|{}|{}",
        ffmpeg_path.as_deref().unwrap_or(""),
        ffprobe_path.as_deref().unwrap_or(""),
        dolby_vision_filter
    );

    let mut guard = cache.inner.lock().await;
    if !force {
        if let Some((cached_key, cached)) = guard.as_ref() {
            if cached_key == &key {
                return Ok(cached.clone());
            }
        }
    }

    let resolved = environment::resolve(
        &app,
        ffmpeg_path.as_deref(),
        ffprobe_path.as_deref(),
        &dolby_vision_filter,
    )
    .await;

    *guard = Some((key, resolved.clone()));
    Ok(resolved)
}

#[tauri::command]
fn about(app: AppHandle) -> Result<About, String> {
    let user_data_path = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(About {
        version: env!("CARGO_PKG_VERSION").to_string(),
        // A dev run reports the working tree's version, not a build's.
        packaged: !cfg!(debug_assertions),
        tauri: tauri::VERSION.to_string(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        platform: locate::node_platform().to_string(),
        arch: locate::node_arch().to_string(),
        system_version: tauri_plugin_os::version().to_string(),
        user_data_path,
    })
}

/// The raw command line, minus the executable.
///
/// It is handed over unparsed: `@shared/launch` already knows how to read
/// `--volume` and bare paths, and it has tests.
/// A JSON file in the app's data directory, by name.
///
/// Only names this app writes are allowed through: the webview asking for an
/// arbitrary path would make this a general file-read command, which is a far
/// wider door than the backup record needs.
fn data_file_name(name: &str) -> Result<&'static str, String> {
    match name {
        "backups" => Ok("backups.json"),
        other => Err(format!("{other} is not one of PlexFixer's data files")),
    }
}

#[tauri::command]
async fn data_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let file = data_file_name(&name)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(settings::read_data_file(&dir, file).await)
}

#[tauri::command]
async fn data_write(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let file = data_file_name(&name)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings::write_data_file(&dir, file, &contents).await
}

/// Write a report to a file the user picked.
///
/// The path comes from the native save dialog, which is the user naming it;
/// nothing else here writes outside the app's own directory.
#[tauri::command]
async fn save_text(path: String, contents: String) -> Result<String, String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("could not write {path}: {e}"))?;
    Ok(path)
}

#[tauri::command]
fn launch_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Two instances writing the same settings file would fight, so a second
        // launch focuses the window already open and hands it the paths it was
        // given — "plexfixer /some/folder" while running should scan that folder.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("plexfixer://open-paths", argv);
        }));
    }

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(Store::new(data_dir.join("settings.json")));
            app.manage(EnvironmentCache::default());
            app.manage(process::Processes::default());
            app.manage(menu::ContextPath::default());
            menu::install(&app.handle().clone())?;

            // Shown only once the webview has something to draw, so the window
            // does not flash empty on a cold start.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_update,
            settings_reset,
            overrides_get,
            overrides_set,
            environment_resolve,
            about,
            launch_args,
            data_read,
            data_write,
            host::host_exec,
            host::host_stat,
            host::host_list,
            host::host_read_range,
            host::find_media,
            host::host_write_range,
            host::host_mkdirp,
            host::host_rename,
            host::host_remove,
            host::host_remove_empty_directory,
            host::host_exists,
            host::host_clone_file,
            host::host_volume,
            host::known_hosts_read,
            host::known_hosts_append,
            host::known_hosts_location,
            process::process_start,
            process::process_terminate,
            process::process_kill_matching,
            menu::file_context_menu,
            save_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running PlexFixer");
}
