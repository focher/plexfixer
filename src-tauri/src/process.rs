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
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::host::allowed_binary;

/// The longest piece of output handed on in one event.
///
/// Output is read a line at a time, and a line is whatever ends in a newline —
/// which a program writing carriage returns, or nothing at all, never
/// produces. Without a ceiling one such line grows for as long as the process
/// runs.
const LONGEST_CHUNK: u64 = 64 * 1024;

/// How long the end of a process waits for the last of its output.
///
/// The pipes close when the process does, so this is normally no wait at all.
/// It exists for a grandchild that inherited them and is still running: the
/// process has ended, and saying so must not depend on something else.
const DRAIN: Duration = Duration::from_secs(2);

/// What is running, by id.
///
/// The table holds what is needed to *stop* a process — its pid, and its
/// command line to find it by — and not the process itself. The task waiting
/// for it to end owns that. This used to hold the child, and the waiting task
/// took it back out again the moment it started, so by the time anything asked
/// for a process to be stopped the table was empty and the request quietly did
/// nothing: Cancel left ffmpeg running to the end of the file.
#[derive(Default)]
pub struct Processes {
    inner: Mutex<HashMap<String, Running>>,
}

struct Running {
    /// `None` only for a process that had already ended when it was recorded.
    pid: Option<u32>,
    /// The command line, for stopping a process by something it contains.
    line: String,
}

impl Processes {
    /// A poisoned lock still guards a perfectly good map: the only thing a
    /// panic can have interrupted is a single insert or remove.
    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, Running>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn insert(&self, id: &str, pid: Option<u32>, line: String) {
        self.table().insert(id.to_string(), Running { pid, line });
    }

    fn remove(&self, id: &str) {
        self.table().remove(id);
    }

    fn pid_of(&self, id: &str) -> Option<u32> {
        self.table().get(id).and_then(|running| running.pid)
    }

    fn pids_matching(&self, marker: &str) -> Vec<u32> {
        self.table()
            .values()
            .filter(|running| running.line.contains(marker))
            .filter_map(|running| running.pid)
            .collect()
    }
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

/// Read a pipe to its end, handing each piece on as text.
///
/// Bytes, not strings: ffmpeg echoes file names and metadata into its errors,
/// and those are whatever bytes the file had — Latin-1 titles and legacy
/// filenames are ordinary in a media library. Reading as UTF-8 failed on the
/// first such byte and the loop stopped, after which nothing emptied the pipe;
/// once it filled, ffmpeg blocked on its next write and the repair hung with
/// no error anywhere. A byte that is not text is now a replacement character
/// and the reading goes on.
async fn pump<R, F>(pipe: R, mut emit: F)
where
    R: AsyncRead + Unpin,
    F: FnMut(String),
{
    let mut reader = BufReader::new(pipe);
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        buffer.clear();
        // Line at a time, because ffmpeg's progress blocks are lines — but
        // never more than LONGEST_CHUNK of one, and the parser on the other
        // side takes pieces of any size.
        match (&mut reader)
            .take(LONGEST_CHUNK)
            .read_until(b'\n', &mut buffer)
            .await
        {
            Ok(0) | Err(_) => break,
            Ok(_) => emit(String::from_utf8_lossy(&buffer).into_owned()),
        }
    }
}

/// Start a binary, streaming its output as events until it ends.
#[tauri::command]
pub async fn process_start(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    processes: State<'_, Processes>,
) -> Result<(), String> {
    if !allowed_binary(&app, &command).await {
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
        // CREATE_NO_WINDOW: ffmpeg must not flash a console window. No import
        // here — tokio's Command has `creation_flags` inherently, where std's
        // takes it from a trait.
        builder.creation_flags(0x0800_0000);
    }

    let mut child = builder
        .spawn()
        .map_err(|e| format!("{command} would not start: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let forward = |stream: &'static str| {
        let app = app.clone();
        let id = id.clone();
        move |text: String| {
            let _ = app.emit(
                "plexfixer://process-output",
                Chunk {
                    id: id.clone(),
                    stream,
                    text,
                },
            );
        }
    };
    let reading_stdout = tokio::spawn(pump(stdout, forward("stdout")));
    let reading_stderr = tokio::spawn(pump(stderr, forward("stderr")));

    let line = std::iter::once(command.clone())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");

    // Recorded before anything waits on it, and left there until it has
    // ended: this entry is the only way a later request can find the process.
    processes.insert(&id, child.id(), line);

    let handle = app.clone();
    let watched = id.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        handle.state::<Processes>().remove(&watched);

        // The last of the output before the end is announced. The listener on
        // the other side stops listening when it hears the end, and what
        // arrives last on stderr is the reason a failed run failed.
        let _ = tokio::time::timeout(DRAIN, async {
            let _ = reading_stdout.await;
            let _ = reading_stderr.await;
        })
        .await;

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

/// Ask a process to stop.
#[tauri::command]
pub async fn process_terminate(id: String, processes: State<'_, Processes>) -> Result<(), String> {
    if let Some(pid) = processes.pid_of(&id) {
        terminate_pid(pid);
    }
    Ok(())
}

/// Stop whatever is running something that contains `marker`.
#[tauri::command]
pub async fn process_kill_matching(marker: String, processes: State<'_, Processes>) -> Result<(), String> {
    for pid in processes.pids_matching(&marker) {
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

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    // Windows has no SIGTERM. `taskkill` without /F posts a close message to
    // the process's window, and these are started with no window to post it
    // to — so the polite form reports that the process "can only be terminated
    // forcefully" and leaves it running. /F is the only form that stops it,
    // and /T takes anything it started along with it. What is lost is ffmpeg
    // closing its output cleanly, which does not matter: a cancelled repair's
    // output is a temporary file that is discarded either way.
    //
    // `creation_flags` comes from a trait on std's Command — unlike tokio's,
    // which has it inherently — so the import has to be here for CREATE_NO_WINDOW
    // to apply and taskkill not to flash a console over whatever is on screen.
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_process_can_be_found_by_its_id() {
        // The bug this guards: the table was emptied as soon as the process
        // started, so stopping one by id found nothing and did nothing.
        let table = Processes::default();
        table.insert("job-1", Some(4242), "ffmpeg -i in.mkv out.mp4".into());
        assert_eq!(table.pid_of("job-1"), Some(4242));
    }

    #[test]
    fn a_running_process_can_be_found_by_its_command_line() {
        let table = Processes::default();
        table.insert("job-1", Some(1), "ffmpeg -i a.mkv /m/.plexfixer-abc-a.mp4".into());
        table.insert("job-2", Some(2), "ffmpeg -i b.mkv /m/.plexfixer-abc-b.mp4".into());
        assert_eq!(table.pids_matching("/m/.plexfixer-abc-b.mp4"), vec![2]);
    }

    #[test]
    fn a_process_that_has_ended_is_forgotten() {
        // A pid is reused by the system once its process is gone, so one that
        // stayed here could later stop something that is not ours.
        let table = Processes::default();
        table.insert("job-1", Some(4242), "ffmpeg".into());
        table.remove("job-1");
        assert_eq!(table.pid_of("job-1"), None);
        assert!(table.pids_matching("ffmpeg").is_empty());
    }

    #[test]
    fn an_unknown_id_finds_nothing() {
        assert_eq!(Processes::default().pid_of("nobody"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_process_by_its_id_stops_it() {
        // The whole path a Cancel takes, short of the command wrapper: a real
        // process, recorded the way `process_start` records it, found by id
        // while it runs, and stopped.
        use std::os::unix::process::ExitStatusExt;

        let mut child = Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("sleep starts");
        let table = Processes::default();
        table.insert("job-1", child.id(), "sleep 30".into());

        terminate_pid(table.pid_of("job-1").expect("in the table while it runs"));

        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("it stopped rather than running on")
            .expect("it can be waited for");
        assert_eq!(status.signal(), Some(libc::SIGTERM));
    }

    async fn pumped(input: &[u8]) -> Vec<String> {
        let mut chunks = Vec::new();
        pump(input, |text| chunks.push(text)).await;
        chunks
    }

    #[tokio::test]
    async fn output_arrives_a_line_at_a_time() {
        assert_eq!(pumped(b"frame=1\nframe=2\n").await, vec!["frame=1\n", "frame=2\n"]);
    }

    #[tokio::test]
    async fn bytes_that_are_not_text_do_not_stop_the_reading() {
        // A Latin-1 title in an error message. Everything after it used to be
        // lost, and with it the pipe's only reader.
        let chunks = pumped(b"title: Am\xe9lie\nstill here\n").await;
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].starts_with("title: Am"));
        assert_eq!(chunks[1], "still here\n");
    }

    #[tokio::test]
    async fn a_last_line_without_a_newline_is_still_delivered() {
        assert_eq!(pumped(b"done\nno newline").await, vec!["done\n", "no newline"]);
    }

    #[tokio::test]
    async fn a_line_that_never_ends_is_delivered_in_pieces() {
        let endless = vec![b'x'; (LONGEST_CHUNK as usize) * 2 + 10];
        let chunks = pumped(&endless).await;
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk.len() <= LONGEST_CHUNK as usize));
        assert_eq!(chunks.iter().map(String::len).sum::<usize>(), endless.len());
    }
}
