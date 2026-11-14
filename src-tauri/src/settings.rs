//! Persisted application settings and per-path mode overrides.
//!
//! Stored as JSON beside the rest of the app's data. The shape is deliberately
//! opaque here: `settings` is whatever map the TypeScript side keeps, and the
//! defaults, the field list and the migrations all stay in `@shared/defaults`.
//! Adding a setting must never mean editing Rust.
//!
//! Two hard-won rules from the Electron build are kept:
//!
//!   * Writes are serialised. The UI saves far more often than it looks — a
//!     text field saves on every keystroke, and the remote switch saves while
//!     the environment is still being probed. Overlapping read-modify-writes
//!     used to lose whichever change lost the race. The lock is held across the
//!     whole read-modify-write, so each update sees the one before it.
//!   * Each write uses its own temporary file and is renamed into place. A
//!     shared temporary name let one write rename another's file out from
//!     under it, and in the worst interleaving a half-written file landed on
//!     the real one and every preference in it was gone.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Stored {
    #[serde(default)]
    pub settings: Map<String, Value>,
    #[serde(default, rename = "modeOverrides")]
    pub mode_overrides: Map<String, Value>,
}

pub struct Store {
    path: PathBuf,
    /// Doubles as the cache and as the write queue: the guard is held for the
    /// whole of every read-modify-write.
    state: Mutex<Option<Stored>>,
    writes: AtomicU64,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(None),
            writes: AtomicU64::new(0),
        }
    }

    async fn read(&self, guard: &mut Option<Stored>) -> Stored {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }

        let stored = match tokio::fs::read_to_string(&self.path).await {
            // No file at all is a first run, and the defaults are exactly right.
            Err(_) => Stored::default(),
            Ok(raw) => match serde_json::from_str::<Stored>(&raw) {
                Ok(parsed) => parsed,
                Err(error) => {
                    // There was a file and it did not parse. Starting from
                    // defaults is the only way to boot, but the next save would
                    // overwrite the evidence, so it is kept: a silent reset is
                    // indistinguishable from the app forgetting on its own.
                    let millis = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let kept = self.path.with_extension(format!("json.corrupt-{millis}"));
                    match tokio::fs::rename(&self.path, &kept).await {
                        Ok(()) => eprintln!(
                            "settings.json could not be read; it has been kept at {}: {error}",
                            kept.display()
                        ),
                        Err(rename_error) => eprintln!(
                            "settings.json could not be read, and could not be set aside: {rename_error}"
                        ),
                    }
                    Stored::default()
                }
            },
        };

        *guard = Some(stored.clone());
        stored
    }

    async fn persist(&self, guard: &mut Option<Stored>, next: Stored) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }

        let body = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        // Unique per write: a shared name lets one write rename another's file.
        let count = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
        let temporary = self
            .path
            .with_extension(format!("json.{}.{count}.tmp", std::process::id()));

        tokio::fs::write(&temporary, body)
            .await
            .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
        tokio::fs::rename(&temporary, &self.path)
            .await
            .map_err(|e| format!("could not replace {}: {e}", self.path.display()))?;

        *guard = Some(next);
        Ok(())
    }

    pub async fn settings(&self) -> Map<String, Value> {
        let mut guard = self.state.lock().await;
        self.read(&mut guard).await.settings
    }

    pub async fn update(&self, patch: Map<String, Value>) -> Result<Map<String, Value>, String> {
        let mut guard = self.state.lock().await;
        let mut next = self.read(&mut guard).await;
        for (key, value) in patch {
            next.settings.insert(key, value);
        }
        let settings = next.settings.clone();
        self.persist(&mut guard, next).await?;
        Ok(settings)
    }

    pub async fn reset(&self) -> Result<Map<String, Value>, String> {
        let mut guard = self.state.lock().await;
        let current = self.read(&mut guard).await;
        // Overrides are kept: resetting the preferences is not a request to
        // forget which folders were deliberately set to something else.
        let next = Stored {
            settings: Map::new(),
            mode_overrides: current.mode_overrides,
        };
        self.persist(&mut guard, next).await?;
        Ok(Map::new())
    }

    pub async fn overrides(&self) -> Map<String, Value> {
        let mut guard = self.state.lock().await;
        self.read(&mut guard).await.mode_overrides
    }

    pub async fn set_override(
        &self,
        path: String,
        mode: Option<String>,
    ) -> Result<Map<String, Value>, String> {
        let mut guard = self.state.lock().await;
        let mut next = self.read(&mut guard).await;
        match mode {
            Some(mode) => next.mode_overrides.insert(path, Value::String(mode)),
            None => next.mode_overrides.remove(&path),
        };
        let overrides = next.mode_overrides.clone();
        self.persist(&mut guard, next).await?;
        Ok(overrides)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A directory of this test's own, so concurrent tests cannot collide.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "plexfixer-settings-{}-{name}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join("settings.json")
    }

    fn patch(key: &str, value: Value) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert(key.to_string(), value);
        map
    }

    #[tokio::test]
    async fn both_changes_survive_two_overlapping_updates() {
        // The bug this guards: the remote switch saving while a keystroke in
        // the host field was still saving, and one of them silently vanishing.
        let store = Store::new(scratch("overlap"));
        let (first, second) = tokio::join!(
            store.update(patch("remoteHost", json!("plex@nas.local"))),
            store.update(patch("remoteEnabled", json!(true)))
        );
        first.expect("first write");
        second.expect("second write");

        let settings = store.settings().await;
        assert_eq!(settings.get("remoteHost"), Some(&json!("plex@nas.local")));
        assert_eq!(settings.get("remoteEnabled"), Some(&json!(true)));
    }

    #[tokio::test]
    async fn a_burst_of_keystroke_sized_writes_leaves_a_file_that_parses() {
        let path = scratch("burst");
        let store = Store::new(path.clone());
        let mut writes = Vec::new();
        for index in 0..20 {
            writes.push(store.update(patch("remoteHost", json!(format!("host-{index}")))));
        }
        for result in futures_join(writes).await {
            result.expect("write");
        }

        let raw = tokio::fs::read_to_string(&path).await.expect("settings file");
        serde_json::from_str::<Stored>(&raw).expect("a parseable file");
    }

    #[tokio::test]
    async fn an_unreadable_file_is_kept_rather_than_overwritten() {
        let path = scratch("corrupt");
        tokio::fs::write(&path, "{ this is not json")
            .await
            .expect("write the broken file");

        let store = Store::new(path.clone());
        store
            .update(patch("remoteHost", json!("plex@nas.local")))
            .await
            .expect("write");

        let dir = path.parent().expect("parent");
        let kept: Vec<_> = std::fs::read_dir(dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "the unreadable file should have been set aside");
    }

    #[tokio::test]
    async fn clearing_one_field_keeps_the_rest() {
        let store = Store::new(scratch("clear"));
        store
            .update(patch("remoteHost", json!("plex@nas.local")))
            .await
            .expect("write");
        store
            .update(patch("remoteKeyPath", json!("~/.ssh/id_ed25519")))
            .await
            .expect("write");
        store
            .update(patch("remoteKeyPath", json!("")))
            .await
            .expect("write");

        let settings = store.settings().await;
        assert_eq!(settings.get("remoteHost"), Some(&json!("plex@nas.local")));
        assert_eq!(settings.get("remoteKeyPath"), Some(&json!("")));
    }

    #[tokio::test]
    async fn resetting_keeps_the_mode_overrides() {
        let store = Store::new(scratch("reset"));
        store
            .set_override("/Volumes/Media".into(), Some("force-transcode".into()))
            .await
            .expect("override");
        store
            .update(patch("maxHeight", json!(1080)))
            .await
            .expect("write");

        store.reset().await.expect("reset");

        assert!(store.settings().await.is_empty());
        assert_eq!(
            store.overrides().await.get("/Volumes/Media"),
            Some(&json!("force-transcode"))
        );
    }

    /// `join_all` without pulling in `futures` for one test.
    async fn futures_join<T>(tasks: Vec<impl std::future::Future<Output = T>>) -> Vec<T> {
        let mut results = Vec::with_capacity(tasks.len());
        for task in tasks {
            results.push(task.await);
        }
        results
    }
}

/* ------------------------------------------------------------------ *
 * Other data files
 * ------------------------------------------------------------------ */

/// Read a JSON file from the app's data directory, or `None` if it is absent.
///
/// The backup record uses this. It is deliberately dumb — the shape and the
/// rules about it live in TypeScript, next to their tests — but it keeps the
/// atomic write, because a half-written record of what was backed up is worse
/// than none.
pub async fn read_data_file(dir: &std::path::Path, name: &str) -> Option<String> {
    tokio::fs::read_to_string(dir.join(name)).await.ok()
}

pub async fn write_data_file(dir: &std::path::Path, name: &str, contents: &str) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let target = dir.join(name);
    let temporary = dir.join(format!("{name}.{}.tmp", std::process::id()));
    tokio::fs::write(&temporary, contents)
        .await
        .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|e| format!("could not replace {}: {e}", target.display()))
}
