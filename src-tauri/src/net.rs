//! The one door to the outside, for subtitles.
//!
//! Same reasoning as `tmdb.rs`, and worth restating because this door is wider:
//! the page is allowed to talk to this app and to nothing else, so widening
//! that to reach an outside host would widen it for everything else the page
//! could ever be made to do. Every subtitle request therefore leaves from here.
//!
//! What makes it wider than the TMDB one is that two of the addresses are not
//! known at build time. A local model server is wherever the person running it
//! put it, and an "OpenAI-compatible" endpoint is the entire point of that
//! phrase. So the allowed list has two halves:
//!
//! - **Fixed prefixes**, written into the binary, for the services this app
//!   knows by name. Nothing the caller says can add to these.
//! - **Whatever Settings names**, read *here* from the settings this side
//!   saved — not taken as an argument beside the request it would be vouching
//!   for. That distinction is the whole of the check: a caller that could hand
//!   over both the address and the permission for it has not been checked at
//!   all. It is the same shape as `allowed_binary` in `host.rs`, for the same
//!   reason.
//!
//! An endpoint somebody typed into Settings can of course point anywhere on
//! their own network, and that is theirs to decide — it is no different from
//! typing the same address into curl. What it cannot do is be chosen by
//! anything other than them.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::settings::Store;

/// Addresses this app knows by name. Prefixes, so a path or query may vary.
///
/// Each ends at a slash so that no lookalike host can sit in front of the rest
/// of it: without the trailing slash, `https://api.groq.com` is a prefix of
/// `https://api.groq.com.example.net`.
const FIXED: &[&str] = &[
    "https://api.opensubtitles.com/api/v1/",
    "https://api.openai.com/v1/",
    "https://api.anthropic.com/v1/",
    "https://api.groq.com/openai/v1/",
    // The same prefix `tmdb.rs` has always allowed, and for the same one
    // command. It is here as well because the metadata providers describe
    // requests the way the subtitle providers do, and sending two of the three
    // through this door and the third through another would mean the chain
    // that asks Radarr first and themoviedb.org second could not be one chain.
    // No reach is added by this: it is a prefix this process could already
    // fetch, written down in a second place.
    "https://api.themoviedb.org/3/",
];

/// Hosts a subtitle download may come from.
///
/// OpenSubtitles answers a download request with a link to its own download
/// host, which is not its API host and is not documented as a fixed address.
/// So these are matched as hosts rather than as prefixes — the host itself, or
/// anything under it.
const DOWNLOAD_HOSTS: &[&str] = &["opensubtitles.com", "opensubtitles.org"];

/// Settings fields that may name an address.
///
/// Read from the store, never from the caller. Anything here is allowed as an
/// origin: a request has to match its scheme, host and port exactly, and begin
/// with its path.
const ENDPOINT_KEYS: &[&str] = &[
    "subtitleTranslationEndpoint",
    "subtitleTranscriptionEndpoint",
    // Radarr, Sonarr and Bazarr. Each lives wherever the person running it put
    // it, which is the whole reason they are here rather than in FIXED: there
    // is no address to write into the binary. Read from the saved settings,
    // never from the caller, so the app cannot be told to reach somewhere by
    // anything other than the person who typed it in.
    "radarrUrl",
    "sonarrUrl",
    "bazarrUrl",
];

/// Enough for any reply here. A subtitle is kilobytes and a model's answer is
/// smaller; this exists so that a wrong address cannot pull something enormous
/// into memory.
const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// A ceiling on what may be posted, well above the 25 MB the speech endpoints
/// accept and well below a film.
const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    /// Hand the reply back as bytes rather than as text.
    ///
    /// Subtitle files are routinely not UTF-8 — a Russian one is usually
    /// windows-1251 — so the request that fetches one has to come back
    /// undecoded for the page to work out what it is.
    #[serde(default)]
    binary: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    /// The form field the file travels in.
    file_field: String,
    /// The name the file is presented under; the services read its extension.
    file_name: String,
    /// Everything else in the form.
    #[serde(default)]
    fields: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
}

/// Put the cipher suites in place, if nobody has yet.
///
/// See `tmdb.rs` for why this is not left to whoever got there first: reqwest
/// panics rather than failing when no provider is installed, and a release
/// build of this app aborts on a panic, so the window simply disappears.
pub(crate) fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// The scheme, host and port of an address, as a string to compare.
fn origin(url: &url_lite::Parsed) -> String {
    match url.port {
        Some(port) => format!("{}://{}:{}", url.scheme, url.host, port),
        None => format!("{}://{}", url.scheme, url.host),
    }
}

/// Whether `host` is `suffix` or something under it.
///
/// `dl.opensubtitles.com` is under `opensubtitles.com`; so is
/// `opensubtitles.com` itself. `notopensubtitles.com` is not, which is the
/// case a plain `ends_with` gets wrong.
pub(crate) fn under_host(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

/// Every address this process will fetch, given what Settings says.
async fn allowed_endpoints(app: &AppHandle) -> Vec<String> {
    let settings = app.state::<Store>().settings().await;
    ENDPOINT_KEYS
        .iter()
        .filter_map(|key| {
            settings
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

/// Decide whether this address may be fetched.
///
/// Separate from where the answers come from so it can be tested without a
/// settings file: `configured` is what Settings named, and nothing else widens
/// the list.
fn is_allowed(url: &str, configured: &[String], downloads_allowed: bool) -> bool {
    let Some(parsed) = url_lite::parse(url) else {
        return false;
    };
    if parsed.scheme != "http" && parsed.scheme != "https" {
        return false;
    }

    if FIXED.iter().any(|prefix| url.starts_with(prefix)) {
        return true;
    }

    // A download link is only followed as the second step of a download, so
    // this half of the list is only open when that is what is happening.
    if downloads_allowed
        && parsed.scheme == "https"
        && DOWNLOAD_HOSTS.iter().any(|host| under_host(&parsed.host, host))
    {
        return true;
    }

    let here = origin(&parsed);
    configured.iter().any(|endpoint| {
        let Some(allowed) = url_lite::parse(endpoint) else {
            return false;
        };
        // The scheme, host and port have to match exactly, and the path has to
        // begin with whatever the setting named — an endpoint of
        // `https://host/v1` does not permit `https://host/admin`.
        origin(&allowed) == here && parsed.path.starts_with(allowed.path.trim_end_matches('/'))
    })
}

/// A header a caller asked for, checked before it is sent.
///
/// A header value is terminated by a line ending, so a value carrying one is
/// not a value — it is the start of a second header, which is how an allowed
/// request grows an extra one nobody wrote.
fn check_headers(headers: &HashMap<String, String>) -> Result<(), String> {
    for (name, value) in headers {
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("{name} is not a header name"));
        }
        if value.chars().any(|c| c.is_control()) {
            return Err(format!("the value for {name} has characters in it that cannot go in a header"));
        }
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    install_crypto_provider();
    reqwest::Client::builder()
        // Long enough for a model to think about forty lines of dialogue, and
        // for a speech endpoint to work through ten minutes of audio.
        .timeout(Duration::from_secs(300))
        // No redirects: following one is how a request to an allowed host ends
        // up somewhere else entirely, carrying the key with it.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

async fn finish(response: reqwest::Response, binary: bool) -> Result<Reply, String> {
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("the reply could not be read: {error}"))?;

    if bytes.len() > MAX_REPLY_BYTES {
        return Err("that address sent more than this expects".to_string());
    }

    if binary {
        Ok(Reply { status, text: None, bytes: Some(bytes.to_vec()) })
    } else {
        Ok(Reply {
            status,
            // Lossy rather than strict: an error page in some other encoding
            // should still reach the person as text they can read a message
            // out of, rather than as a failure about encoding.
            text: Some(String::from_utf8_lossy(&bytes).into_owned()),
            bytes: None,
        })
    }
}

/// Fetch one address, if it is one of the addresses this may fetch.
///
/// `following` says this is the second step of a download, which is the only
/// time a link to a service's own download host is followed.
#[tauri::command]
pub async fn net_fetch(app: AppHandle, request: Request, following: bool) -> Result<Reply, String> {
    let configured = allowed_endpoints(&app).await;
    if !is_allowed(&request.url, &configured, following) {
        return Err(format!(
            "{} is not an address PlexFixer will fetch. The services it knows are built in; anything else has to \
             be the endpoint named in Settings.",
            request.url
        ));
    }
    check_headers(&request.headers)?;

    let client = client()?;
    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        other => return Err(format!("{other} is not a method this sends")),
    };

    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| describe(&request.url, &error))?;

    finish(response, request.binary).await
}

/// Post a file from disk as a multipart form.
///
/// Built by hand rather than with reqwest's own multipart support, which is a
/// feature flag this build does not carry — and the form here is three text
/// fields and one file, which is not worth a dependency. The file is named by
/// path rather than carried through the page: ten minutes of audio is nineteen
/// megabytes, and moving that into the webview to be posted back out again
/// would double the memory for nothing.
#[tauri::command]
pub async fn net_upload(app: AppHandle, request: Upload, path: String) -> Result<Reply, String> {
    let configured = allowed_endpoints(&app).await;
    if !is_allowed(&request.url, &configured, false) {
        return Err(format!("{} is not an address PlexFixer will post to", request.url));
    }
    check_headers(&request.headers)?;

    // A field name or a file name with a quote or a line ending in it would
    // forge the part header that carries it, which is the multipart equivalent
    // of the header check above.
    let safe = |value: &str| -> bool { !value.chars().any(|c| c.is_control() || c == '"' || c == '\\') };
    if !safe(&request.file_field) || !safe(&request.file_name) {
        return Err("that field or file name cannot go in a form".to_string());
    }
    for (name, value) in &request.fields {
        if !safe(name) || !safe(value) {
            return Err(format!("the value for {name} cannot go in a form"));
        }
    }

    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("could not read {path}: {error}"))?
        .len();
    if size > MAX_UPLOAD_BYTES {
        return Err(format!(
            "{path} is {} MB, which is more than this will post",
            size / (1024 * 1024)
        ));
    }
    let file = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("could not read {path}: {error}"))?;

    // Fixed rather than random: the parts are checked above for anything that
    // could contain it, and the file is binary, where a boundary collision is
    // handled by the length-delimited read on the far side.
    let boundary = "----PlexFixerFormBoundary7MA4YWxkTrZu0gW";
    let mut body: Vec<u8> = Vec::with_capacity(file.len() + 1024);

    for (name, value) in &request.fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n",
            request.file_field, request.file_name
        )
        .as_bytes(),
    );
    body.extend_from_slice(&file);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let client = client()?;
    let mut builder = client
        .post(&request.url)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| describe(&request.url, &error))?;

    finish(response, false).await
}

/// What went wrong, named by the host rather than by the library.
fn describe(url: &str, error: &reqwest::Error) -> String {
    let host = url_lite::parse(url).map(|parsed| parsed.host).unwrap_or_else(|| url.to_string());
    if error.is_timeout() {
        return format!("{host} did not answer in time");
    }
    if error.is_connect() {
        return format!("could not reach {host}");
    }
    format!("could not reach {host}: {error}")
}

/// Just enough URL parsing to decide whether an address is allowed.
///
/// `url` is not a dependency of this build and this needs four fields of it.
/// Deliberately strict: anything it cannot parse confidently is refused rather
/// than guessed at, because the answer feeds a security decision and a parser
/// that disagrees with the one reqwest uses is how an allowed prefix comes to
/// address a different host.
pub(crate) mod url_lite {
    pub struct Parsed {
        pub scheme: String,
        pub host: String,
        pub port: Option<u16>,
        pub path: String,
    }

    pub fn parse(url: &str) -> Option<Parsed> {
        let (scheme, rest) = url.split_once("://")?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }

        // Everything up to the first `/`, `?` or `#` is the authority.
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..end];
        let path = if end < rest.len() { &rest[end..] } else { "/" };
        if authority.is_empty() {
            return None;
        }

        // Credentials in the authority are refused rather than parsed:
        // `https://api.openai.com@evil.example/` is a request to evil.example,
        // and a check that looked at the part before the @ would wave it
        // through.
        if authority.contains('@') {
            return None;
        }
        // An IPv6 literal would need bracket handling this does not have, and
        // nothing here addresses one.
        if authority.contains('[') {
            return None;
        }

        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port.parse::<u16>().ok()?)),
            None => (authority, None),
        };
        if host.is_empty() || host.contains('/') {
            return None;
        }

        // The path is compared against an allowed prefix, so a `..` in it must
        // not be able to climb back out of that prefix.
        if path.split('/').any(|part| part == "..") {
            return None;
        }

        Some(Parsed {
            scheme,
            host: host.to_ascii_lowercase(),
            port,
            path: path.split(['?', '#']).next().unwrap_or("/").to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Vec<String> {
        vec![
            "http://127.0.0.1:11434".to_string(),
            "https://models.example.com/v1".to_string(),
        ]
    }

    #[test]
    fn the_services_it_knows_are_allowed() {
        for url in [
            "https://api.opensubtitles.com/api/v1/subtitles?languages=en",
            "https://api.openai.com/v1/chat/completions",
            "https://api.anthropic.com/v1/messages",
            "https://api.groq.com/openai/v1/audio/transcriptions",
        ] {
            assert!(is_allowed(url, &[], false), "{url} was refused");
        }
    }

    #[test]
    fn a_lookalike_host_is_not() {
        for url in [
            "https://api.openai.com.example.net/v1/chat/completions",
            // The fixed prefixes are https; the plain-http twin of one of them
            // is a different address.
            "http://api.openai.com/v1/chat/completions",
            "https://api.anthropic.com/v2/messages",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url at all",
        ] {
            assert!(!is_allowed(url, &[], true), "{url} was let through");
        }
    }

    /// The API prefixes are exact, so a path outside them is refused — except
    /// while a download is being followed, when any path on the service's own
    /// hosts is fair game. That is deliberate: the host a download link points
    /// at is not documented and has changed before, so pinning it would break
    /// the feature the next time they move their CDN. The opening is one
    /// request wide and only ever on the second step of a download.
    #[test]
    fn a_path_outside_the_api_prefix_needs_a_download_to_be_under_way() {
        let other = "https://api.opensubtitles.com/api/v2/subtitles";
        assert!(!is_allowed(other, &[], false));
        assert!(is_allowed(other, &[], true));
    }

    /// The one that looks fine and is not: everything before the @ is a
    /// username, so this is a request to evil.example.
    #[test]
    fn credentials_cannot_disguise_the_host() {
        assert!(!is_allowed("https://api.openai.com@evil.example/v1/chat/completions", &[], false));
        assert!(!is_allowed("https://api.openai.com:pass@evil.example/v1/", &configured(), true));
    }

    #[test]
    fn a_download_link_is_followed_only_while_downloading() {
        let link = "https://dl.opensubtitles.com/download/abc/Solaris.ru.srt";
        assert!(is_allowed(link, &[], true));
        assert!(!is_allowed(link, &[], false));
    }

    #[test]
    fn a_host_that_merely_ends_the_same_way_is_not_under_it() {
        assert!(under_host("dl.opensubtitles.com", "opensubtitles.com"));
        assert!(under_host("opensubtitles.com", "opensubtitles.com"));
        assert!(!under_host("notopensubtitles.com", "opensubtitles.com"));
        assert!(!is_allowed("https://notopensubtitles.com/x.srt", &[], true));
    }

    #[test]
    fn settings_may_name_an_endpoint_and_only_that_endpoint() {
        let allowed = configured();
        assert!(is_allowed("http://127.0.0.1:11434/api/tags", &allowed, false));
        assert!(is_allowed("https://models.example.com/v1/chat/completions", &allowed, false));
        // Same host, outside the path the setting named.
        assert!(!is_allowed("https://models.example.com/admin", &allowed, false));
        // Right host, wrong port.
        assert!(!is_allowed("http://127.0.0.1:11435/api/tags", &allowed, false));
        // Not named at all.
        assert!(!is_allowed("https://somewhere.else/v1/chat/completions", &allowed, false));
    }

    #[test]
    fn a_path_cannot_climb_out_of_the_prefix_it_was_allowed_under() {
        let allowed = configured();
        assert!(!is_allowed("https://models.example.com/v1/../admin", &allowed, false));
    }

    #[test]
    fn a_header_that_would_forge_another_is_refused() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer good\r\nX-Evil: yes".to_string());
        assert!(check_headers(&headers).unwrap_err().contains("cannot go in a header"));

        let mut bad_name = HashMap::new();
        bad_name.insert("Not A Header".to_string(), "x".to_string());
        assert!(check_headers(&bad_name).is_err());

        let mut fine = HashMap::new();
        fine.insert("anthropic-version".to_string(), "2023-06-01".to_string());
        assert!(check_headers(&fine).is_ok());
    }

    #[test]
    fn the_parser_reads_what_it_needs_and_refuses_the_rest() {
        let parsed = url_lite::parse("https://api.groq.com:443/openai/v1/x?y=1#z").unwrap();
        assert_eq!(parsed.scheme, "https");
        assert_eq!(parsed.host, "api.groq.com");
        assert_eq!(parsed.port, Some(443));
        assert_eq!(parsed.path, "/openai/v1/x");

        assert!(url_lite::parse("https://[::1]:11434/api/tags").is_none());
        assert!(url_lite::parse("https://host:not-a-port/").is_none());
        assert!(url_lite::parse("https:///nohost").is_none());
    }

    /// The regression test for a window that vanished; see `tmdb.rs`.
    #[test]
    fn a_client_can_be_built() {
        client().expect("a client should build once the cipher suites are in place");
    }

    /* --- a library manager of one's own ------------------------------ */

    /// A Radarr on the far side of the house is reachable because Settings
    /// says where it is, and for no other reason.
    #[test]
    fn a_service_named_in_settings_is_reachable_under_its_own_path() {
        let configured = vec!["http://nas:7878".to_owned()];
        assert!(is_allowed("http://nas:7878/api/v3/movie", &configured, false));
        assert!(is_allowed("http://nas:7878/api/v3/command", &configured, false));
    }

    #[test]
    fn a_service_not_named_in_settings_is_not_reachable() {
        assert!(!is_allowed("http://nas:7878/api/v3/movie", &[], false));
    }

    /// The port is part of the origin: Sonarr next door on 8989 is not the
    /// Radarr that was allowed, even though it is the same machine.
    #[test]
    fn naming_one_service_does_not_allow_another_on_the_same_host() {
        let configured = vec!["http://nas:7878".to_owned()];
        assert!(!is_allowed("http://nas:8989/api/v3/series", &configured, false));
    }

    #[test]
    fn a_lookalike_host_is_not_the_service_that_was_named() {
        let configured = vec!["http://nas:7878".to_owned()];
        assert!(!is_allowed("http://nas.evil.example:7878/api/v3/movie", &configured, false));
        assert!(!is_allowed("http://nas:7878@evil.example/api/v3/movie", &configured, false));
    }
}
