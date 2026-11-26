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
    /// Every process under this id, youngest first.
    ///
    /// A plain run has one. A pipeline has one per stage, and all of them have
    /// to be stopped: killing only the producer leaves the consumer waiting on
    /// a pipe that will never close, and killing only the consumer leaves the
    /// producer writing into one nothing reads.
    ///
    /// Empty only for a process that had already ended when it was recorded.
    pids: Vec<u32>,
    /// The command line, for stopping a process by something it contains.
    line: String,
}

impl Processes {
    /// A poisoned lock still guards a perfectly good map: the only thing a
    /// panic can have interrupted is a single insert or remove.
    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, Running>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn insert(&self, id: &str, pids: Vec<u32>, line: String) {
        self.table().insert(id.to_string(), Running { pids, line });
    }

    fn remove(&self, id: &str) {
        self.table().remove(id);
    }

    fn pids_of(&self, id: &str) -> Vec<u32> {
        self.table()
            .get(id)
            .map(|running| running.pids.clone())
            .unwrap_or_default()
    }

    fn pids_matching(&self, marker: &str) -> Vec<u32> {
        self.table()
            .values()
            .filter(|running| running.line.contains(marker))
            .flat_map(|running| running.pids.clone())
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
    processes.insert(&id, child.id().into_iter().collect(), line);

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

/// One stage of a pipeline: a binary and its arguments.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub command: String,
    pub args: Vec<String>,
}

/// Start several binaries with their output wired into each other's input.
///
/// This exists for one job: converting Dolby Vision profile 7 to 8.1. Only
/// `dovi_tool` can rewrite the RPU, and it reads an HEVC elementary stream —
/// which has to come out of the film first. Run as two steps with a file
/// between them, a 60 GB remux needs 55 GB of scratch for the extracted
/// stream before the conversion has written a byte. Piped, that file never
/// exists.
///
/// Every stage is checked against the same allow-list as `process_start`:
/// nothing starts a binary this app did not resolve for itself.
///
/// Failure is judged from the last stage, then from the rest. The order
/// matters because of SIGPIPE: when the consumer finishes first the producer
/// is killed by the kernel mid-write, and that is the normal end of a healthy
/// pipeline rather than a fault. A producer that failed for its own reasons
/// exits with a code instead, and that is reported.
#[tauri::command]
pub async fn process_start_pipeline(
    app: AppHandle,
    id: String,
    stages: Vec<Stage>,
    processes: State<'_, Processes>,
) -> Result<(), String> {
    if stages.is_empty() {
        return Err("a pipeline needs at least one stage".into());
    }
    for stage in &stages {
        if !allowed_binary(&app, &stage.command).await {
            return Err(format!(
                "{} is not one of the binaries PlexFixer runs. Only the ffmpeg and ffprobe it resolved are.",
                stage.command
            ));
        }
    }

    let last = stages.len() - 1;
    let mut children = Vec::with_capacity(stages.len());
    let mut carried: Option<Stdio> = None;
    let mut readers = Vec::new();

    let forward = |stream: &'static str, id: String| {
        let app = app.clone();
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

    for (index, stage) in stages.iter().enumerate() {
        let mut builder = Command::new(&stage.command);
        builder
            .args(&stage.args)
            .stdin(carried.take().unwrap_or_else(Stdio::null))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            builder.creation_flags(0x0800_0000);
        }

        let mut child = builder.spawn().map_err(|e| {
            // Whatever started already is killed on drop, so a stage that will
            // not start does not leave the one before it writing into nothing.
            format!("{} would not start: {e}", stage.command)
        })?;

        let stderr = child.stderr.take().ok_or("no stderr")?;
        readers.push(tokio::spawn(pump(stderr, forward("stderr", id.clone()))));

        let stdout = child.stdout.take().ok_or("no stdout")?;
        if index == last {
            readers.push(tokio::spawn(pump(stdout, forward("stdout", id.clone()))));
        } else {
            // Into the next stage rather than to the app: this is the film,
            // not progress output, and it is measured in gigabytes.
            // `try_into`, not `Stdio::try_from`: tokio implements the
            // conversion as `TryInto<Stdio> for ChildStdout` rather than the
            // `TryFrom` the standard library provides for its own handles.
            let piped: Stdio = stdout
                .try_into()
                .map_err(|e| format!("could not pipe stdout: {e}"))?;
            carried = Some(piped);
        }

        children.push(child);
    }

    let line = stages
        .iter()
        .map(|stage| {
            std::iter::once(stage.command.clone())
                .chain(stage.args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" | ");

    processes.insert(&id, children.iter().filter_map(|c| c.id()).collect(), line);

    let handle = app.clone();
    let watched = id.clone();
    tokio::spawn(async move {
        let mut statuses = Vec::with_capacity(children.len());
        for child in &mut children {
            statuses.push(child.wait().await);
        }
        handle.state::<Processes>().remove(&watched);

        let _ = tokio::time::timeout(DRAIN, async {
            for reader in readers {
                let _ = reader.await;
            }
        })
        .await;

        let (code, signal_name) = pipeline_outcome(&statuses);

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

/// What a pipeline's several exits add up to.
///
/// The last stage decides it: it is the one that wrote the output, so its
/// verdict is the pipeline's. Only when it succeeded is the rest consulted,
/// and then a stage killed by SIGPIPE is passed over — that is what happens to
/// a producer when the consumer finishes first, and it means nothing went
/// wrong. Anything else failing means the last stage was fed a truncated
/// stream and wrote a truncated file while believing it had read to the end.
fn pipeline_outcome(statuses: &[std::io::Result<std::process::ExitStatus>]) -> (Option<i32>, Option<String>) {
    fn parts(status: &std::io::Result<std::process::ExitStatus>) -> (Option<i32>, Option<String>) {
        match status {
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
        }
    }

    let Some(final_status) = statuses.last() else {
        return (None, None);
    };
    let last = parts(final_status);
    if last.0 != Some(0) {
        return last;
    }

    for status in &statuses[..statuses.len() - 1] {
        let (code, signal) = parts(status);
        if signal.as_deref() == Some("SIG13") {
            continue;
        }
        if code != Some(0) {
            return (code, signal);
        }
    }
    last
}

/// Ask a process to stop.
#[tauri::command]
pub async fn process_terminate(id: String, processes: State<'_, Processes>) -> Result<(), String> {
    for pid in processes.pids_of(&id) {
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
        table.insert("job-1", vec![4242], "ffmpeg -i in.mkv out.mp4".into());
        assert_eq!(table.pids_of("job-1"), vec![4242]);
    }

    #[test]
    fn a_running_process_can_be_found_by_its_command_line() {
        let table = Processes::default();
        table.insert("job-1", vec![1], "ffmpeg -i a.mkv /m/.plexfixer-abc-a.mp4".into());
        table.insert("job-2", vec![2], "ffmpeg -i b.mkv /m/.plexfixer-abc-b.mp4".into());
        assert_eq!(table.pids_matching("/m/.plexfixer-abc-b.mp4"), vec![2]);
    }

    #[test]
    fn a_process_that_has_ended_is_forgotten() {
        // A pid is reused by the system once its process is gone, so one that
        // stayed here could later stop something that is not ours.
        let table = Processes::default();
        table.insert("job-1", vec![4242], "ffmpeg".into());
        table.remove("job-1");
        assert!(table.pids_of("job-1").is_empty());
        assert!(table.pids_matching("ffmpeg").is_empty());
    }

    #[test]
    fn an_unknown_id_finds_nothing() {
        assert!(Processes::default().pids_of("nobody").is_empty());
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
        table.insert("job-1", child.id().into_iter().collect(), "sleep 30".into());

        for pid in table.pids_of("job-1") {
            terminate_pid(pid);
        }

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

    /* --- what a pipeline's several exits add up to -------------------- */

    /// An `ExitStatus` cannot be built by hand, so one is taken from a process
    /// run for the purpose. `true` and `false` are in every POSIX environment,
    /// and the signalled case uses a process this test kills itself.
    #[cfg(unix)]
    mod pipeline {
        use super::super::pipeline_outcome;
        use std::process::{Command, ExitStatus};

        fn exited(code: i32) -> std::io::Result<ExitStatus> {
            Ok(Command::new("sh")
                .args(["-c", &format!("exit {code}")])
                .status()
                .expect("sh"))
        }

        fn sigpiped() -> std::io::Result<ExitStatus> {
            // SIGPIPE is 13; `kill -13 $$` makes a process die of it exactly
            // as a producer does when its consumer closes the pipe early.
            Ok(Command::new("sh")
                .args(["-c", "kill -13 $$"])
                .status()
                .expect("sh"))
        }

        #[test]
        fn every_stage_succeeding_is_a_success() {
            assert_eq!(pipeline_outcome(&[exited(0), exited(0)]).0, Some(0));
        }

        #[test]
        fn the_last_stage_failing_is_the_pipelines_verdict() {
            assert_eq!(pipeline_outcome(&[exited(0), exited(3)]).0, Some(3));
        }

        /// The case this function exists for. When `dovi_tool` finishes first,
        /// the kernel kills the `ffmpeg` feeding it. Treating that as a
        /// failure would fail every healthy conversion.
        #[test]
        fn a_producer_killed_by_sigpipe_is_not_a_failure() {
            let outcome = pipeline_outcome(&[sigpiped(), exited(0)]);
            assert_eq!(outcome.0, Some(0));
        }

        /// The case that makes the one above dangerous to get wrong the other
        /// way: ffmpeg failing for its own reasons closes the pipe too, and
        /// the consumer reads a truncated stream, finds a clean end and exits
        /// 0 having written a truncated file.
        #[test]
        fn a_producer_failing_on_its_own_is_a_failure_even_when_the_rest_succeeded() {
            assert_eq!(pipeline_outcome(&[exited(1), exited(0)]).0, Some(1));
        }

        #[test]
        fn nothing_at_all_is_not_a_crash() {
            assert_eq!(pipeline_outcome(&[]).0, None);
        }
    }
}
