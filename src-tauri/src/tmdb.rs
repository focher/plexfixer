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

/// Put the cipher suites in place, if nobody has yet.
///
/// Rustls does not pick its own cryptography: something has to name a
/// provider once per process, and reqwest is built here with the feature that
/// says "I will supply one myself". If it reaches a client builder with none
/// installed it does not fail, it panics — and a release build of this app
/// aborts on a panic, so the window simply disappears.
///
/// The updater installs the same provider before its own first request, which
/// is the only reason this ever worked: a lookup after an update check found
/// one already there, and a lookup before it did not. That is a race, not a
/// dependency, so this does not rely on it.
///
/// Installing twice is not an error worth reporting — the second caller loses
/// and both get the same cipher suites, which is the point.
fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// TMDB hands out two credentials: an API key, which travels in the query
/// string, and a read access token, which travels in a header. The caller has
/// already worked out which it has; this only has to carry the header when
/// there is one.
#[tauri::command]
pub async fn tmdb_get(url: String, bearer: Option<String>) -> Result<String, String> {
    install_crypto_provider();

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression test for a window that vanished.
    ///
    /// Without the provider this does not return an error, it panics inside
    /// reqwest — so this bites by crashing the test, which is exactly how it
    /// bit in the app.
    #[test]
    fn a_client_can_be_built() {
        install_crypto_provider();
        reqwest::Client::builder()
            .build()
            .expect("a client should build once the cipher suites are in place");
    }

    #[test]
    fn installing_twice_is_fine() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[tokio::test]
    async fn refuses_any_other_host() {
        for address in [
            "https://api.themoviedb.org.example.com/3/movie/1",
            "http://api.themoviedb.org/3/movie/1",
            "https://api.themoviedb.org/4/movie/1",
            "file:///etc/passwd",
        ] {
            let refusal = tmdb_get(address.to_string(), None).await.unwrap_err();
            assert!(refusal.contains("that was not it"), "{address} was let through: {refusal}");
        }
    }

    #[tokio::test]
    async fn refuses_a_token_that_would_forge_a_header() {
        let refusal = tmdb_get(
            format!("{ALLOWED}movie/1"),
            Some("good\r\nX-Evil: yes".to_string()),
        )
        .await
        .unwrap_err();
        assert!(refusal.contains("cannot go in a header"), "{refusal}");
    }
}
