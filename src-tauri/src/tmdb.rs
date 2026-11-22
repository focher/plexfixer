//! Asking The Movie Database for what a film is called.
//!
//! The request is made from here rather than from the page for one reason: the
//! page is allowed to talk to this app and to nothing else, and widening that
//! to reach an outside host would widen it for everything else the page could
//! ever be made to do. A command with the host written into it cannot be
//! pointed anywhere else.
//!
//! This is a transport and nothing more. It builds no URLs, reads no JSON and
//! knows nothing about films — all of that is in TypeScript, where it is
//! tested. What it does know is the one host it will talk to.

/// The only address this will fetch. A prefix, so a query string is free to
/// vary, and ending in a slash so no lookalike host can sit in front of it.
const ALLOWED: &str = "https://api.themoviedb.org/3/";

/// Big enough for any search page; small enough that a wrong address cannot
/// pull something enormous into memory.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// TMDB hands out two credentials: an API key, which travels in the query
/// string, and a read access token, which travels in a header. The caller has
/// already worked out which it has; this only has to carry the header when
/// there is one.
#[tauri::command]
pub async fn tmdb_get(url: String, bearer: Option<String>) -> Result<String, String> {
    if !url.starts_with(ALLOWED) {
        return Err(format!("Only {ALLOWED} can be fetched, and that was not it"));
    }

    // A header value is terminated by a line ending. A token carrying one
    // would not be a token, it would be the start of a second header.
    if let Some(token) = bearer.as_deref() {
        if token.chars().any(|c| c.is_control()) {
            return Err("That read access token has characters in it that cannot go in a header".to_string());
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        // No redirects: following one is how a request to an allowed host ends
        // up somewhere else entirely, carrying the key with it.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = client.get(&url).header("Accept", "application/json");
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach themoviedb.org: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("themoviedb.org sent something unreadable: {error}"))?;

    if body.len() > MAX_BYTES {
        return Err("themoviedb.org sent more than this expects".to_string());
    }

    if !status.is_success() {
        // The body carries TMDB's own explanation — a bad key, most often —
        // which is worth more to the person reading it than the number is.
        return Err(format!("themoviedb.org returned {status}: {body}"));
    }

    Ok(body)
}
