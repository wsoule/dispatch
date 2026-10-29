use super::*;
fn info() -> DaemonFileInfo {
    DaemonFileInfo {
        pid: std::process::id(),
        port: 1234,
        root_dir: "/fixture".into(),
        started_at: "2026-10-28T00:00:00Z".into(),
        agent_token: Some("request".into()),
        background: None,
    }
}
fn health(i: &DaemonFileInfo) -> HealthResponse {
    HealthResponse {
        ok: true,
        pid: Some(i.pid),
        root_dir: Some(i.root_dir.clone()),
        started_at: Some(i.started_at.clone()),
        identity: Some("ok".into()),
    }
}
#[tokio::test]
async fn dead_and_obsolete_generations_make_zero_http_requests() {
    let i = info();
    let state = inspect_with(
        || Some(i.clone()),
        |_| ProcessState::Dead,
        &[],
        |_| async { panic!("HTTP on dead generation") },
    )
    .await;
    assert!(matches!(state, DiscoveryState::Obsolete(_)));
    let state = inspect_with(
        || Some(i.clone()),
        |_| ProcessState::Alive,
        std::slice::from_ref(&i),
        |_| async { panic!("HTTP on obsolete generation") },
    )
    .await;
    assert!(matches!(state, DiscoveryState::Obsolete(_)));
}
#[tokio::test]
async fn alive_and_unknown_stalls_remain_conservative() {
    for state in [ProcessState::Alive, ProcessState::Unknown] {
        let i = info();
        assert!(matches!(
            inspect_with(
                || Some(i.clone()),
                |_| state,
                &[],
                |_| async { IdentityProbe::Stalled }
            )
            .await,
            DiscoveryState::Stalled(_)
        ));
        assert!(matches!(
            inspect_with(
                || Some(i.clone()),
                |_| state,
                &[],
                |_| async { IdentityProbe::Ready }
            )
            .await,
            DiscoveryState::Ready(_)
        ));
    }
}
#[tokio::test]
async fn replacement_during_liveness_is_reevaluated_without_probing_old_port() {
    let old = info();
    let mut new = old.clone();
    new.started_at.push('2');
    let mut reads = vec![Some(old), Some(new)].into_iter();
    assert!(matches!(
        inspect_with(
            || reads.next().unwrap(),
            |_| ProcessState::Dead,
            &[],
            |_| async { panic!("old endpoint probed") }
        )
        .await,
        DiscoveryState::Changed
    ));
}
#[tokio::test]
async fn replacement_during_http_never_returns_old_credentials() {
    let old = info();
    let mut new = old.clone();
    new.agent_token = Some("winner".into());
    let mut reads = vec![Some(old.clone()), Some(old), Some(new)].into_iter();
    assert!(matches!(
        inspect_with(
            || reads.next().unwrap(),
            |_| ProcessState::Alive,
            &[],
            |_| async { IdentityProbe::Ready }
        )
        .await,
        DiscoveryState::Changed
    ));
}
#[tokio::test]
async fn replacement_generation_is_accepted_even_with_reused_pid_and_port() {
    let old = info();
    let mut new = old.clone();
    new.started_at.push('2');
    new.agent_token = Some("winner".into());
    assert!(matches!(
        inspect_with(
            || Some(new.clone()),
            |_| ProcessState::Alive,
            &[old],
            |_| async { IdentityProbe::Ready }
        )
        .await,
        DiscoveryState::Ready(_)
    ));
}
#[test]
fn root_pid_timestamp_and_displacement_are_validated() {
    let i = info();
    assert!(health_matches("/fixture", &i, &health(&i)));
    assert!(!health_matches("/wrong", &i, &health(&i)));
    let mut h = health(&i);
    h.pid = Some(i.pid + 1);
    assert!(!health_matches("/fixture", &i, &h));
    let mut h = health(&i);
    h.started_at = Some("reused".into());
    assert!(!health_matches("/fixture", &i, &h));
    let mut h = health(&i);
    h.identity = Some("displaced".into());
    assert!(!health_matches("/fixture", &i, &h));
    let mut h = health(&i);
    h.pid = None;
    assert!(!health_matches("/fixture", &i, &h));
}
#[test]
fn app_authority_does_not_survive_pid_reuse_or_credential_rotation() {
    let i = info();
    let tokens = SpawnedAppTokens::new();
    tokens.remember("/fixture", &i, "app");
    assert_eq!(tokens.get("/fixture", &i).as_deref(), Some("app"));
    let mut next = i.clone();
    next.started_at.push('2');
    assert_eq!(tokens.get("/fixture", &next), None);
    let mut next = i.clone();
    next.agent_token = Some("winner".into());
    assert_eq!(tokens.get("/fixture", &next), None);
}
#[test]
fn transport_errors_only_prove_absence_for_connection_refused() {
    assert!(connection_refused(&std::io::Error::from(
        std::io::ErrorKind::ConnectionRefused
    )));
    for kind in [
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::TimedOut,
    ] {
        assert!(!connection_refused(&std::io::Error::from(kind)));
    }
}

#[tokio::test]
async fn closed_local_endpoint_is_never_ready() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut i = info();
    i.port = listener.local_addr().unwrap().port();
    drop(listener);
    // Windows can spend the existing budget retrying a refused connect;
    // either observed refusal or timeout is valid, never readiness.
    assert!(matches!(
        probe_identity(&reqwest::Client::new(), "/fixture", &i).await,
        IdentityProbe::Down | IdentityProbe::Stalled
    ));
}

/// Runs in its own test process with DISPATCH_HOME set to ignored scratch space.
/// No global home override is introduced into the parallel unit-test process.
#[cfg(test)]
mod integration {
    use super::*;
    use std::io::Read;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Isolate process-global discovery without requiring an opt-in test command.
    #[test]
    fn runs_with_isolated_discovery_home() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.agents/ignore/daemon-lifecycle-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&home).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sidecar::lifecycle_tests::integration::provider_free_lifecycle_scenarios",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("DISPATCH_HOME", &home)
            .output()
            .unwrap();
        if output.status.success() {
            std::fs::remove_dir_all(&home).unwrap();
        }
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    struct FixtureSpawner {
        mode: &'static str,
        spawns: AtomicUsize,
    }
    impl FixtureSpawner {
        fn new(mode: &'static str) -> Self {
            Self {
                mode,
                spawns: AtomicUsize::new(0),
            }
        }
    }
    impl DaemonSpawner for FixtureSpawner {
        fn spawn(&self, _: &DaemonLaunch, root: &str, port: Option<u16>) -> Result<Child, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "sidecar::lifecycle_tests::integration::fixture_daemon",
                    "--ignored",
                    "--nocapture",
                ])
                .env("LIFECYCLE_FIXTURE_ROOT", root)
                .env("LIFECYCLE_FIXTURE_MODE", self.mode)
                .env("LIFECYCLE_FIXTURE_PORT", port.unwrap_or(0).to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())
        }
    }
    struct RaceSpawner(Mutex<Option<Child>>);
    impl DaemonSpawner for RaceSpawner {
        fn spawn(
            &self,
            launch: &DaemonLaunch,
            root: &str,
            _: Option<u16>,
        ) -> Result<Child, String> {
            let winner = FixtureSpawner::new("healthy").spawn(launch, root, None)?;
            *self.0.lock().unwrap() = Some(winner);
            FixtureSpawner::new("unpublished").spawn(launch, root, None)
        }
    }
    impl Drop for RaceSpawner {
        fn drop(&mut self) {
            if let Some(child) = self.0.lock().unwrap().as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    struct Owned(DispatchdChildren);
    impl Drop for Owned {
        fn drop(&mut self) {
            self.0.kill_all();
        }
    }

    #[test]
    #[ignore = "subprocess fixture; launched only by lifecycle integration"]
    fn fixture_daemon() {
        let root = std::env::var("LIFECYCLE_FIXTURE_ROOT").unwrap();
        let mode = std::env::var("LIFECYCLE_FIXTURE_MODE").unwrap();
        let port: u16 = std::env::var("LIFECYCLE_FIXTURE_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        let pid = std::process::id();
        let started = format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let info = serde_json::json!({"pid": pid, "port":listener.local_addr().unwrap().port(), "rootDir": root, "startedAt": started, "agentToken":format!("request-{pid}-{started}"), "background": mode.starts_with("background")});
        let path = daemon_file_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if mode != "unpublished" {
            std::fs::write(&path, info.to_string()).unwrap();
        }
        println!("DISPATCH_APP_TOKEN=fixture-app-{pid}");
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0; 8192];
            let n = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..n]);
            let route = request.split_whitespace().nth(1).unwrap_or("");
            let mut trace = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(Path::new(&root).join("probes.jsonl"))
                .unwrap();
            writeln!(trace, "{}", serde_json::json!({"pid":pid,"route":route})).unwrap();
            let (status, body) = if route == "/api/health" {
                if mode == "stalled" {
                    let _ = stream.read(&mut buffer);
                    continue;
                }
                (200, serde_json::json!({"ok":true,"pid":pid,"rootDir":if mode == "wrong-root" {"/wrong"} else {&root},"startedAt":started,"identity":"ok"}).to_string())
            } else if route == "/api/live-work" {
                (200, serde_json::json!({"busy":if mode == "background-busy" {vec!["run"]}else{vec![]},"parked":if mode == "background-parked" {1}else{0}}).to_string())
            } else if route == "/api/daemon/shutdown" {
                let authorized = request.contains(info["agentToken"].as_str().unwrap());
                if !authorized {
                    (403, "{}".into())
                } else if mode == "shutdown-busy" {
                    (409, "{}".into())
                } else {
                    write!(stream,"HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
                    if read_daemon_file(&root).map(|i| i.pid) == Some(pid) {
                        let _ = std::fs::remove_file(&path);
                    }
                    return;
                }
            } else {
                (404, "{}".into())
            };
            write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    }

    /// Exercises real discovery files, child ownership, HTTP and credential
    /// capture together. The isolated parent invocation supplies the home.
    #[tokio::test]
    #[ignore = "run serially in a subprocess with an isolated DISPATCH_HOME"]
    async fn provider_free_lifecycle_scenarios() {
        let home = std::env::var("DISPATCH_HOME").expect("isolated test home required");
        let base = Path::new(&home).join("projects");
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("fresh");
        std::fs::create_dir_all(root.join(".dispatch/tasks")).unwrap();
        let root = normalize_root(root.to_str().unwrap()).unwrap();
        let children = Owned(DispatchdChildren::new());
        let tokens = SpawnedAppTokens::new();
        let launch = dev_launch(Path::new(env!("CARGO_MANIFEST_DIR")));
        let spawner = FixtureSpawner::new("healthy");
        let fresh = ensure_dispatchd(&spawner, &children.0, &tokens, launch.clone(), &root, false)
            .await
            .unwrap();
        assert!(fresh.app_token.is_some());
        let reused = ensure_dispatchd(&spawner, &children.0, &tokens, launch.clone(), &root, false)
            .await
            .unwrap();
        assert_eq!(fresh, reused);
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 1);
        let attached = ensure_dispatchd(
            &spawner,
            &children.0,
            &SpawnedAppTokens::new(),
            launch.clone(),
            &root,
            false,
        )
        .await
        .unwrap();
        assert!(attached.app_token.is_none());
        assert_eq!(attached.agent_token, fresh.agent_token);
        let old = read_daemon_file(&root).unwrap();
        children.0.kill_all();
        assert_eq!(process_state(old.pid), ProcessState::Dead);
        assert_eq!(
            read_daemon_file(&root).as_ref(),
            Some(&old),
            "hard child exit leaves discovery behind"
        );
        let blackhole = std::net::TcpListener::bind(("127.0.0.1", old.port)).unwrap();
        blackhole.set_nonblocking(true).unwrap();
        let replacement =
            ensure_dispatchd(&spawner, &children.0, &tokens, launch.clone(), &root, false)
                .await
                .unwrap();
        assert!(replacement.app_token.is_some());
        assert_ne!(replacement.agent_token, fresh.agent_token);
        assert!(
            blackhole.accept().is_err(),
            "known-dead endpoint must receive zero connections"
        );
        children.0.kill_all();
        drop(blackhole);
        // Real busy/parked takeover checks and graceful file release.
        for mode in [
            "background-busy",
            "background-parked",
            "background-idle",
            "shutdown-busy",
            "wrong-root",
        ] {
            let path = base.join(mode);
            std::fs::create_dir_all(path.join(".dispatch/tasks")).unwrap();
            let r = normalize_root(path.to_str().unwrap()).unwrap();
            let fixture = FixtureSpawner::new(mode);
            let mut prior = fixture.spawn(&launch, &r, None).unwrap();
            let tail = Arc::new(Mutex::new(VecDeque::new()));
            forward_child_output(
                &mut prior,
                tail,
                base.join(format!("{mode}.log")),
                Arc::new(Mutex::new(None)),
            );
            let old_pid = prior.id();
            let mut obsolete = vec![];
            // Wrong-root fixtures are deliberately never accepted as ready.
            if mode == "wrong-root" {
                let deadline = Instant::now() + Duration::from_secs(5);
                while read_daemon_file(&r).is_none() && Instant::now() < deadline {
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
                children.0.push(prior);
                assert!(ensure_dispatchd(
                    &spawner,
                    &children.0,
                    &tokens,
                    launch.clone(),
                    &r,
                    false
                )
                .await
                .unwrap_err()
                .contains("generation"));
            } else {
                assert!(matches!(
                    wait_for_generation(
                        &reqwest::Client::new(),
                        &r,
                        &mut prior,
                        &mut obsolete,
                        Duration::from_secs(5)
                    )
                    .await,
                    GenerationOutcome::Ready(_)
                ));
                children.0.push(prior);
                let result = ensure_dispatchd(
                    &spawner,
                    &children.0,
                    &tokens,
                    launch.clone(),
                    &r,
                    mode == "shutdown-busy",
                )
                .await;
                if mode == "background-idle" {
                    assert_eq!(process_state(old_pid), ProcessState::Dead);
                    assert!(result.unwrap().app_token.is_some());
                } else if mode == "shutdown-busy" {
                    assert!(result.is_err());
                    assert!(pid_alive(old_pid));
                } else {
                    assert!(result.unwrap().app_token.is_none());
                    assert!(pid_alive(old_pid));
                }
            }
            children.0.kill_all();
        }
        // A different process publishes while our child starts. Its discovery
        // wins; the losing child's stdout cannot confer app authority on it.
        let path = base.join("competing-winner");
        std::fs::create_dir_all(path.join(".dispatch/tasks")).unwrap();
        let r = normalize_root(path.to_str().unwrap()).unwrap();
        let racing = RaceSpawner(Mutex::new(None));
        let winner = ensure_dispatchd(&racing, &children.0, &tokens, launch.clone(), &r, false)
            .await
            .unwrap();
        let winner_pid = racing.0.lock().unwrap().as_ref().unwrap().id();
        assert_eq!(read_daemon_file(&r).unwrap().pid, winner_pid);
        assert!(winner.app_token.is_none());
        assert_eq!(
            winner.agent_token,
            read_daemon_file(&r).unwrap().agent_token
        );
        assert!(tokens.get(&r, &read_daemon_file(&r).unwrap()).is_none());
        children.0.kill_all();
        drop(racing);

        // A live process whose endpoint stalls retains the full grace period.
        let path = base.join("stalled");
        std::fs::create_dir_all(path.join(".dispatch/tasks")).unwrap();
        let r = normalize_root(path.to_str().unwrap()).unwrap();
        let mut child = FixtureSpawner::new("stalled")
            .spawn(&launch, &r, None)
            .unwrap();
        forward_child_output(
            &mut child,
            Arc::new(Mutex::new(VecDeque::new())),
            base.join("stalled.log"),
            Arc::new(Mutex::new(None)),
        );
        children.0.push(child);
        let deadline = Instant::now() + Duration::from_secs(5);
        while read_daemon_file(&r).is_none() && Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        let count = spawner.spawns.load(Ordering::SeqCst);
        let start = Instant::now();
        let result = ensure_dispatchd(&spawner, &children.0, &tokens, launch, &r, false).await;
        let elapsed = start.elapsed().as_secs_f64();
        assert!(result.unwrap_err().contains("overloaded"));
        assert!(elapsed >= 30.);
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), count);
    }
}
