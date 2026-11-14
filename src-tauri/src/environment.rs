//! Resolving the ffmpeg toolchain and this machine's encoder capabilities.
//!
//! Every answer here is proved by running something rather than by reading a
//! list. A build advertises `h264_nvenc` on a machine with no NVIDIA driver,
//! and advertises `libplacebo` on one with no Vulkan device; both fail at open
//! time, which without this would surface as a mystifying failure partway
//! through someone's first real repair.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tokio::process::Command;

use crate::locate::{locate, node_platform};

/// Hardware encoders worth asking about, in the order they are reported.
const HARDWARE_ENCODERS: &[&str] = &[
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "h264_amf",
    "hevc_amf",
    "h264_videotoolbox",
    "hevc_videotoolbox",
    "h264_vaapi",
    "hevc_vaapi",
];

/// Long enough for a cold GPU driver to wake up, short enough that a hung
/// probe does not hold the window on a spinner.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub available: Vec<String>,
    pub nvenc: bool,
    pub videotoolbox: bool,
    pub qsv: bool,
    pub amf: bool,
    pub libplacebo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_version: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffprobe_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffprobe_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_version: Option<String>,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
}

/// Run a command, returning its combined output, or `None` if it failed, could
/// not start, or took too long.
async fn run(binary: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a probe must not flash a console window.
        command.creation_flags(0x0800_0000);
    }

    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text)
}

/// The first line of the version banner, which also proves the binary runs.
async fn version_of(binary: &str) -> Option<String> {
    let output = run(binary, &["-version"]).await?;
    output.lines().next().map(|line| line.trim().to_string())
}

/// Encode a few frames to confirm an encoder actually opens on this machine.
async fn encoder_works(ffmpeg: &str, encoder: &str) -> bool {
    run(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:duration=0.2",
            "-c:v",
            encoder,
            "-frames:v",
            "3",
            "-f",
            "null",
            "-",
        ],
    )
    .await
    .is_some()
}

/// Run a frame through the real Dolby Vision filter chain.
///
/// The chain is passed in rather than written here: it lives in
/// `@shared/plex/rules`, next to the code that builds the repair command, so
/// that the thing being proved and the thing being run cannot drift apart. A
/// build can have libplacebo and still refuse an option this chain needs, and
/// finding that out during a repair costs an hour of encoding and a file whose
/// colours are wrong.
async fn libplacebo_works(ffmpeg: &str, filter: &str) -> bool {
    run(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-init_hw_device",
            "vulkan=plexfixer",
            "-filter_hw_device",
            "plexfixer",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:duration=0.2",
            "-vf",
            filter,
            "-frames:v",
            "2",
            "-f",
            "null",
            "-",
        ],
    )
    .await
    .is_some()
}

async fn detect(ffmpeg: &str, dolby_vision_filter: &str) -> Capabilities {
    let listed = run(ffmpeg, &["-hide_banner", "-encoders"])
        .await
        .unwrap_or_default();
    let available: Vec<String> = HARDWARE_ENCODERS
        .iter()
        .filter(|name| listed.contains(**name))
        .map(|name| (*name).to_string())
        .collect();

    let has = |suffix: &str| available.iter().any(|name| name.ends_with(suffix));

    let nvenc = has("_nvenc") && encoder_works(ffmpeg, "h264_nvenc").await;
    let videotoolbox = has("_videotoolbox") && encoder_works(ffmpeg, "h264_videotoolbox").await;
    let qsv = has("_qsv") && encoder_works(ffmpeg, "h264_qsv").await;
    let amf = has("_amf") && encoder_works(ffmpeg, "h264_amf").await;
    let libplacebo = libplacebo_works(ffmpeg, dolby_vision_filter).await;

    Capabilities {
        platform: node_platform().to_string(),
        available,
        nvenc,
        videotoolbox,
        qsv,
        amf,
        libplacebo,
        ffmpeg_version: version_of(ffmpeg).await,
    }
}

pub async fn resolve(
    app: &AppHandle,
    ffmpeg_override: Option<&str>,
    ffprobe_override: Option<&str>,
    dolby_vision_filter: &str,
) -> Environment {
    let ffmpeg = locate(app, "ffmpeg", ffmpeg_override);
    let ffprobe = locate(app, "ffprobe", ffprobe_override);

    let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) else {
        let missing = match (
            locate(app, "ffmpeg", ffmpeg_override).is_none(),
            locate(app, "ffprobe", ffprobe_override).is_none(),
        ) {
            (true, true) => "ffmpeg and ffprobe",
            (true, false) => "ffmpeg",
            _ => "ffprobe",
        };
        return Environment {
            ready: false,
            problem: Some(format!(
                "Could not find {missing}. Install FFmpeg and point Settings → FFmpeg at it, or run \
                 \"npm run fetch:ffmpeg\" in the project to download the bundled binaries."
            )),
            ..Environment::default()
        };
    };

    let ffmpeg_path = ffmpeg.path.to_string_lossy().into_owned();
    let ffprobe_path = ffprobe.path.to_string_lossy().into_owned();

    let Some(version) = version_of(&ffmpeg_path).await else {
        return Environment {
            ready: false,
            problem: Some(format!(
                "Found ffmpeg at {ffmpeg_path} but it would not run. Check that the file is executable."
            )),
            ffmpeg_path: Some(ffmpeg_path),
            ffprobe_path: Some(ffprobe_path),
            ..Environment::default()
        };
    };

    let capabilities = detect(&ffmpeg_path, dolby_vision_filter).await;

    // One line per probe — it is cached, so this is not chatty — naming what
    // was found and where. "It says ffmpeg is missing" is a very different
    // question from "it found the wrong ffmpeg", and without this there is
    // nothing in a log to tell them apart.
    eprintln!(
        "plexfixer: ffmpeg {} ({}), encoders [{}]{}",
        ffmpeg_path,
        ffmpeg.source,
        capabilities.available.join(", "),
        if capabilities.libplacebo {
            ", libplacebo"
        } else {
            ""
        }
    );

    Environment {
        ffmpeg_path: Some(ffmpeg_path),
        ffprobe_path: Some(ffprobe_path),
        ffmpeg_source: Some(ffmpeg.source.to_string()),
        ffprobe_source: Some(ffprobe.source.to_string()),
        ffmpeg_version: Some(version),
        ready: true,
        problem: None,
        hint: None,
        capabilities: Some(capabilities),
    }
}
