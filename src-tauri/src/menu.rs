//! The application menu, and the right-click menu on a file.
//!
//! Both are native on purpose. The app menu is where macOS users look for
//! About, and a right-click on a file row is expected to offer Finder, not a
//! web page's idea of one.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu ids. They travel through the event handler as strings.
const ABOUT: &str = "plexfixer.about";
const REVEAL: &str = "plexfixer.reveal";
const COPY_PATH: &str = "plexfixer.copy-path";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // PlexFixer's own About panel, not the system one: it reports the ffmpeg
    // in use and the toolchain behind it, which the system panel cannot.
    let about = MenuItemBuilder::with_id(ABOUT, "About PlexFixer").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "PlexFixer")
        .item(&about)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}

/// Wire the menu up, including the right-click menu's own items.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;

    app.on_menu_event(move |app, event| {
        let id = event.id().0.as_str();
        match id {
            ABOUT => {
                let _ = app.emit("plexfixer://show-about", ());
            }
            REVEAL | COPY_PATH => {
                // The path is kept beside the menu because a menu event
                // carries only its id.
                if let Some(path) = app.try_state::<ContextPath>().and_then(|state| state.take()) {
                    if id == REVEAL {
                        let _ = tauri_plugin_opener::reveal_item_in_dir(&path);
                    } else {
                        // The webview has a clipboard; Rust would need a
                        // plugin for one.
                        let _ = app.emit("plexfixer://copy-path", path);
                    }
                }
            }
            _ => {}
        }
    });

    Ok(())
}

/// The file a right-click menu was opened on, between the click and the choice.
#[derive(Default)]
pub struct ContextPath(std::sync::Mutex<Option<String>>);

impl ContextPath {
    fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut held| held.take())
    }
}

/// Pop up the native right-click menu for one file.
#[tauri::command]
pub async fn file_context_menu(app: AppHandle, path: String) -> Result<(), String> {
    if let Some(state) = app.try_state::<ContextPath>() {
        if let Ok(mut held) = state.0.lock() {
            *held = Some(path);
        }
    }

    let reveal = MenuItemBuilder::with_id(REVEAL, "Reveal in Finder")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let copy = MenuItemBuilder::with_id(COPY_PATH, "Copy Path")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(&app)
        .items(&[&reveal, &copy])
        .build()
        .map_err(|e| e.to_string())?;

    let window = app.get_webview_window("main").ok_or("no window")?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}
