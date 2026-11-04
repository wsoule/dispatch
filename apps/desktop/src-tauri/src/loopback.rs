//! HTTP clients for the Dispatch daemon on this computer (`http://127.0.0.1:<port>`).
//!
//! Every native call to dispatchd carries one of its bearer tokens (`sidecar.rs`'s health,
//! live-work and shutdown calls, `downloads.rs`'s file download). A plain `reqwest::Client`
//! reads `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` from the environment when it is built and,
//! with no loopback exemption, would send those requests, token included, to whatever proxy
//! the user's shell or a tool set. It would also follow a redirect, taking the token with it.
//! So every loopback client in this crate starts from `builder()`: no proxy from any source,
//! and no redirects (the daemon never sends one; a 3xx comes back as a failed status).
//!
//! The Anthropic API client in `summarize` is not a loopback client and keeps the system
//! proxy, which a corporate network may need.

use reqwest::redirect::Policy;

/// A client builder for requests to the daemon on 127.0.0.1: no system or environment proxy
/// and no redirects. Callers add their own timeouts before `build()`.
pub(crate) fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
}

/// A ready loopback client with `builder()`'s rules and no timeouts of its own (the daemon
/// calls set one per request). Fails only if the TLS backend cannot start, which
/// `reqwest::Client::new()` would have turned into a panic.
pub(crate) fn client() -> Result<reqwest::Client, String> {
    builder()
        .build()
        .map_err(|e| format!("Could not set up the connection to the Dispatch daemon: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Set only in the child process `loopback_client_ignores_the_proxy_environment` starts.
    const CHILD_MARKER: &str = "DISPATCH_LOOPBACK_PROXY_CHILD";

    /// A one-route HTTP server on 127.0.0.1 that answers every request with `status`, the
    /// extra `headers` and the body `body`, and counts the connections it accepts. Returns
    /// its port and the counter.
    async fn serve(
        status: &'static str,
        headers: String,
        body: &'static str,
    ) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let response = format!(
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                tokio::spawn(async move {
                    // Read the request head before answering so the client sees a reply,
                    // not a reset.
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    /// GETs `url` with `client` and a five-second limit, returning the status and body.
    async fn fetch(client: &reqwest::Client, url: &str) -> (u16, String) {
        let response = client
            .get(url)
            .bearer_auth("loopback-test-token")
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.text().await.unwrap())
    }

    #[tokio::test]
    async fn loopback_client_does_not_follow_a_redirect() {
        let (elsewhere, elsewhere_hits) = serve("200 OK", String::new(), "elsewhere").await;
        let (daemon, _) = serve(
            "302 Found",
            format!("Location: http://127.0.0.1:{elsewhere}/\r\n"),
            "",
        )
        .await;
        let (status, _) = fetch(&client().unwrap(), &format!("http://127.0.0.1:{daemon}/")).await;
        assert_eq!(status, 302);
        assert_eq!(elsewhere_hits.load(Ordering::SeqCst), 0);
    }

    /// The child half of `loopback_client_ignores_the_proxy_environment`, run with every
    /// proxy variable pointing at the parent's fake proxy. It first proves the environment is live (a
    /// plain `reqwest::Client` goes through the fake proxy), then that the loopback client
    /// reaches the daemon straight and never connects to the proxy.
    async fn check_proxy_environment_is_ignored() {
        let (daemon, daemon_hits) = serve("200 OK", String::new(), "direct").await;
        let url = format!("http://127.0.0.1:{daemon}/api/health");

        let (_, body) = fetch(&reqwest::Client::new(), &url).await;
        assert_eq!(
            body, "proxy",
            "the child's proxy environment is not in effect"
        );
        assert_eq!(daemon_hits.load(Ordering::SeqCst), 0);

        let (status, body) = fetch(&client().unwrap(), &url).await;
        assert_eq!((status, body.as_str()), (200, "direct"));
        assert_eq!(daemon_hits.load(Ordering::SeqCst), 1);
    }

    /// reqwest reads the proxy variables when a client is built, so setting them in this
    /// (parallel) test process would leak into every other test. Instead this test re-runs
    /// itself in a child process with `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` set to a
    /// fake proxy (and `NO_PROXY` cleared, which could otherwise exempt 127.0.0.1), and the
    /// child makes the checks; the fake proxy here must see exactly the one control request.
    #[test]
    fn loopback_client_ignores_the_proxy_environment() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        if std::env::var_os(CHILD_MARKER).is_some() {
            runtime.block_on(check_proxy_environment_is_ignored());
            return;
        }
        let (proxy_port, proxy_hits) = runtime.block_on(serve("200 OK", String::new(), "proxy"));
        let proxy = format!("http://127.0.0.1:{proxy_port}");
        let test_name = format!(
            "{}::loopback_client_ignores_the_proxy_environment",
            module_path!().split_once("::").unwrap().1
        );
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", &test_name, "--nocapture", "--test-threads=1"])
            .env(CHILD_MARKER, "1");
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            child.env(name, &proxy).env(name.to_lowercase(), &proxy);
        }
        for name in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
            child.env_remove(name);
        }
        // The fake proxy keeps serving on the runtime's worker threads while this one waits.
        let output = child.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The filter matched the test (the test runner exits 0 when nothing matches, too).
        assert!(stdout.contains("1 passed"), "{stdout}");
        assert_eq!(proxy_hits.load(Ordering::SeqCst), 1);
    }
}
