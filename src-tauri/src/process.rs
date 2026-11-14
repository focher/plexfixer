//! Long-running processes the webview can watch and stop.
//!
//! A repair is one ffmpeg invocation that may run for hours, reporting
//! progress on stdout the whole time. `host_exec` is no use for that — it
//! waits for the end — so a process started here streams instead: every chunk
//! of output becomes an event, and the end becomes one more.
//!
//! The same allow-list applies as for `host_exec`. Nothing starts a binary
//! this app did not resolve.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::host::allowed_binary;

#[derive(Default)]
pub struct Processes {
    /// Running children by id, so they can be stopped by id or by what they
    /// are running.
    inner: Mutex<HashMap<String, Running>>,
}

struct Running {
    child: Child,
    /// The command line, for stopping a process by something it contains.
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    id: String,
    /// "stdout" or "stderr".
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    id: String,
    code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_name: Option<String>,
}

/// Start a binary, streaming its output as events until it ends.
#[tauri::command]
pub async fn process_start(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    settings_ffmpeg: Option<String>,
    settings_ffprobe: Option<String>,
    processes: State<'_, Processes>,
) -> Result<(), String> {
    if !allowed_binary(&app, &command, settings_ffmpeg.as_deref(), settings_ffprobe.as_deref()) {
        return Err(format!(
            "{command} is not one of the binaries PlexFixer runs. Only the ffmpeg and ffprobe it resolved are."
        ));
    }

    let mut builder = Command::new(&command);
    builder
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Without this the child outlives a crash of the app and keeps writing
        // to a file nobody is waiting for any more.
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        builder.creation_flags(0x0800_0000);
    }

    let mut child = builder
        .spawn()
        .map_err(|e| format!("{command} would not start: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    for (stream, pipe) in [("stdout", Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), ("stderr", Box::new(stderr))] {
        let app = app.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(pipe);
            let mut buffer = String::new();
            loop {
                buffer.clear();
                // Line at a time: ffmpeg's progress blocks are lines, and the
                // parser on the other side is written to take them in chunks
                // of any size anyway.
                match reader.read_line(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let _ = app.emit(
                            "plexfixer://process-output",
                            Chunk {
                                id: id.clone(),
                                stream,
                                text: buffer.clone(),
                            },
                        );
                    }
                }
            }
        });
    }

    let line = std::iter::once(command.clone())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");

    {
        let mut guard = processes.inner.lock().map_err(|_| "process table is poisoned")?;
        guard.insert(id.clone(), Running { child, line });
    }

    let handle = app.clone();
    let watched = id.clone();
    tokio::spawn(async move {
        let table = handle.state::<Processes>();
        // The child has to come out of the table to be awaited, or the lock
        // would be held for the whole run.
        let mut child = {
            let mut guard = match table.inner.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            match guard.remove(&watched) {
                Some(running) => running.child,
                None => return,
            }
        };

        let status = child.wait().await;
        let (code, signal_name) = match status {
            Ok(status) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (status.code(), status.signal().map(|s| format!("SIG{s}")))
                }
                #[cfg(not(unix))]
                {
                    (status.code(), None)
                }
            }
            Err(_) => (None, None),
        };

        let _ = handle.emit(
            "plexfixer://process-ended",
            Ended {
                id: watched,
                code,
                signal_name,
            },
        );
    });

    Ok(())
}

/// Ask a process to stop — SIGTERM, so ffmpeg closes its output file cleanly.
#[tauri::command]
pub async fn process_terminate(id: String, processes: State<'_, Processes>) -> Result<(), String> {
    let pid = {
        let guard = processes.inner.lock().map_err(|_| "process table is poisoned")?;
        guard.get(&id).and_then(|running| running.child.id())
    };
    let Some(pid) = pid else { return Ok(()) };
    terminate_pid(pid);
    Ok(())
}

/// Stop whatever is running something that contains `marker`.
#[tauri::command]
pub async fn process_kill_matching(marker: String, processes: State<'_, Processes>) -> Result<(), String> {
    let pids: Vec<u32> = {
        let guard = processes.inner.lock().map_err(|_| "process table is poisoned")?;
        guard
            .values()
            .filter(|running| running.line.contains(&marker))
            .filter_map(|running| running.child.id())
            .collect()
    };
    for pid in pids {
        terminate_pid(pid);
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    // SIGTERM rather than SIGKILL: ffmpeg finalises the file it is writing.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate_pid(pid: u32) {
    // Windows has no SIGTERM; taskkill without /F asks politely first.
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .status();
}
