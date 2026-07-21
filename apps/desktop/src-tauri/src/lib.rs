mod activity;
mod commands;
mod cost;
mod db;
mod parser;
mod sidecar;
mod summarize;
mod tags;
mod terminal;
mod watcher;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Idle-session sweep: a session with no new activity for this long is considered ended.
/// Constant, not yet user-configurable (per the plan).
const IDLE_THRESHOLD_SECS: i64 = 120;
/// How often the sweep checks for idle sessions.
const SWEEP_INTERVAL_SECS: u64 = 20;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let app_data_dir = app.path().app_data_dir()?;
      let db_path = app_data_dir.join("relay.db");
      let conn = db::open(&db_path)?;
      // Backfill cost_usd once at startup for sessions ingested before cost calculation
      // existed (their cost_usd is stuck at 0 in the DB otherwise).
      backfill_session_costs(&conn);
      app.manage(db::Db(Mutex::new(conn)));

      // Resolved once at startup (env var, then app_data_dir/config.json), never re-read —
      // see `summarize::resolve_api_key`'s doc comment for the exact order and why this is
      // Tauri-managed state rather than a `OnceLock`.
      let api_key = summarize::resolve_api_key(app.handle());
      if api_key.is_none() {
        summarize::log_summarization_disabled_once(
          "no Anthropic API key found (set ANTHROPIC_API_KEY, or add \"api_key\" to app_data_dir/config.json)",
        );
      }
      app.manage(summarize::ApiKeyState(api_key));
      app.manage(summarize::InFlight(Mutex::new(std::collections::HashSet::new())));
      app.manage(summarize::HttpClient(reqwest::Client::new()));
      app.manage(activity::ActivityCache::new());
      app.manage(sidecar::DispatchdChildren::new());

      watcher::start(app.handle().clone());
      spawn_idle_sweep(app.handle().clone());

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::list_projects,
      commands::list_sessions,
      commands::get_session_detail,
      commands::open_in_editor,
      commands::project_activity,
      commands::project_git_insights,
      commands::dashboard_stats,
      commands::generate_report,
      commands::export_report,
      commands::export_transcript,
      commands::reveal_in_finder,
      commands::get_file_diff_for_session_file,
      commands::get_board,
      commands::create_card,
      commands::move_card,
      commands::update_card,
      commands::delete_card,
      commands::link_session_to_card,
      commands::create_column,
      commands::rename_column,
      commands::launch_or_attach_session,
      commands::open_url,
      commands::ensure_dispatchd,
      commands::has_dispatch,
      commands::current_project_root,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // A spawned dispatchd has no parent-death signal of its own — without this it
      // would keep running as an orphan after the app window closes. `kill_all` is
      // idempotent (it drains its list), so handling both events here is harmless.
      if matches!(
        event,
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
      ) {
        app_handle.state::<sidecar::DispatchdChildren>().kill_all();
      }
    });
}

/// Recomputes cost_usd for every session from its currently-stored token totals against the
/// bundled pricing table. Runs once at startup, synchronously, before the DB is handed off as
/// managed state — cheap enough at this scale that an equality check before writing isn't
/// worth the complexity.
fn backfill_session_costs(conn: &rusqlite::Connection) {
  let totals = match db::queries::all_session_token_totals(conn) {
    Ok(totals) => totals,
    Err(e) => {
      log::warn!("failed to load session token totals for cost backfill: {e:#}");
      return;
    }
  };

  for t in totals {
    let cost = cost::pricing::cost_usd(
      t.model.as_deref(),
      t.prompt_tokens,
      t.completion_tokens,
      t.cache_read_tokens,
      t.cache_creation_tokens,
    );
    if let Err(e) = db::queries::update_cost(conn, &t.id, cost) {
      log::warn!("failed to backfill cost for session {}: {e:#}", t.id);
    }
  }
}

/// Ticks every `SWEEP_INTERVAL_SECS`, finalizing any session that has gone idle for longer
/// than `IDLE_THRESHOLD_SECS`. Runs on Tauri's async runtime (not a raw OS thread, unlike the
/// watcher's blocking `notify` loop — this is a plain async interval loop).
///
/// Lock discipline: the DB connection is behind a single shared `Mutex` that every UI command
/// also contends on, so this tick never holds it across the file I/O that tag-classification
/// needs (a full read + parse of a session's raw log — PLAN.md notes real sessions "can exceed
/// 1000 lines"). The tick runs in three phases instead of one long locked section: gather
/// (locked, DB-only), compute (unlocked, file I/O + classification), write (locked again,
/// briefly). A backlog of many idle sessions at once — e.g. the first tick after a long time
/// away from the app — would otherwise stall every other DB access for the whole backlog's
/// combined read time.
fn spawn_idle_sweep(app_handle: tauri::AppHandle) {
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
    loop {
      interval.tick().await;

      let db = app_handle.state::<db::Db>();
      let now = chrono::Utc::now().timestamp();

      // Phase 1 (locked, DB-only): finalize idle sessions, then gather what tag
      // classification needs — just an id + raw_log_path pair per session, no file I/O yet.
      let (any_finalized, tag_targets) = {
        let conn = db.0.lock().unwrap();

        let ids = match db::queries::sessions_to_finalize(&conn, IDLE_THRESHOLD_SECS, now) {
          Ok(ids) => ids,
          Err(e) => {
            log::warn!("idle sweep: failed to query sessions_to_finalize: {e:#}");
            Vec::new()
          }
        };

        let mut any_finalized = false;
        for id in &ids {
          match db::queries::finalize_session(&conn, id) {
            Ok(()) => {
              any_finalized = true;
              // Moves this session's linked card (if any) to its board's 'review' column —
              // see `sync_card_for_session`'s doc comment for why this always wins over a
              // manual drag. A failure here is a kanban-layer concern only; it must not stop
              // the rest of this tick (tag/summary generation still need to run for `id`).
              if let Err(e) = db::queries::sync_card_for_session(&conn, id, "review") {
                log::warn!("idle sweep: failed to sync card for finalized session {id}: {e:#}");
              }
            }
            Err(e) => log::warn!("idle sweep: failed to finalize session {id}: {e:#}"),
          }
        }

        // Tag classification runs after finalize in this same tick, since `sessions_needing_tags`
        // only returns 'ended' sessions — a session finalized above becomes eligible immediately.
        // This also naturally backfills tags for any session finalized before this feature
        // existed, same pattern as `backfill_session_costs` at startup.
        let tag_targets = match db::queries::sessions_needing_tags(&conn) {
          Ok(tag_ids) => tag_ids
            .into_iter()
            .map(|id| {
              let raw_log_path = match db::queries::session_raw_log_path(&conn, &id) {
                Ok(Some(path)) => path,
                Ok(None) => {
                  log::warn!("idle sweep: session {id} has no raw_log_path row, tagging as empty");
                  String::new()
                }
                Err(e) => {
                  log::warn!("idle sweep: failed to look up raw_log_path for session {id}: {e:#}");
                  String::new()
                }
              };
              (id, raw_log_path)
            })
            .collect::<Vec<_>>(),
          Err(e) => {
            log::warn!("idle sweep: failed to query sessions_needing_tags: {e:#}");
            Vec::new()
          }
        };

        (any_finalized, tag_targets)
      }; // conn dropped here — file I/O below runs with no lock held.

      // Phase 2 (unlocked): the actual file reads + classification, one per session needing
      // tags. This is the I/O this whole three-phase split exists to keep off the DB lock.
      let tag_writes: Vec<(String, String)> = tag_targets
        .into_iter()
        .map(|(id, raw_log_path)| {
          let tags_json = compute_tags_json(&id, &raw_log_path);
          (id, tags_json)
        })
        .collect();

      // Phase 3 (locked again, briefly): write the computed tags back, then hand off to
      // summary generation — which only needs the lock for its own quick `sessions_needing_summary`
      // query here; each spawned summary task re-acquires the lock independently and briefly,
      // for the same reason this phase does (see `spawn_summary_tasks`'s doc comment).
      let any_tagged = {
        let conn = db.0.lock().unwrap();

        let mut any_tagged = false;
        for (id, tags_json) in &tag_writes {
          match db::queries::update_tags(&conn, id, tags_json) {
            Ok(()) => any_tagged = true,
            Err(e) => log::warn!("idle sweep: failed to write tags for session {id}: {e:#}"),
          }
        }

        // Summary generation runs after tag classification in this same tick, for the same
        // reason tag classification runs after finalize: `sessions_needing_summary` only
        // returns 'ended' sessions, so a session finalized earlier in this tick is eligible
        // immediately. Its tasks emit their own `data-changed` events on success (they
        // complete well after this tick's synchronous work and its emit below), so they don't
        // contribute to `any_finalized`/`any_tagged` here.
        spawn_summary_tasks(&app_handle, &conn);

        any_tagged
      }; // conn dropped here.

      if any_finalized || any_tagged {
        let _ = app_handle.emit(
          "data-changed",
          serde_json::json!({ "entity": "session", "kind": "updated" }),
        );
      }
    }
  });
}

/// Computes the tag list for one session as a JSON array string: reads its raw log (no DB
/// access — takes a path, not a connection, so it can run without any lock held), extracts the
/// first user prompt's text, and classifies it. On any failure along the way (empty
/// `raw_log_path`, unreadable/missing log file, no first_user_text at all) still returns an
/// empty tag list (`"[]"`) rather than a value the caller would have to treat as "leave `tags`
/// NULL" — otherwise a session with an unreadable log would be retried, and logged about, on
/// every single sweep tick forever.
fn compute_tags_json(session_id: &str, raw_log_path: &str) -> String {
  // An empty raw_log_path means the gather phase already logged why (missing row or DB error)
  // — nothing further to log here, just fall through to "no text captured."
  let first_user_text = if raw_log_path.is_empty() {
    None
  } else {
    match parser::extract_excerpts(raw_log_path) {
      Ok(excerpts) => excerpts.first_user_text,
      Err(e) => {
        log::warn!(
          "idle sweep: failed to extract transcript excerpts for session {session_id} at {raw_log_path}: {e:#}"
        );
        None
      }
    }
  };

  let tags = tags::classify(&first_user_text.unwrap_or_default());
  serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string())
}

/// Looks at every session with `status='ended' AND summary IS NULL`, skips any session
/// already being summarized from a prior tick (the in-flight set — `summarize::InFlight`),
/// and spawns one task per remaining session to build its prompt, call the Anthropic API, and
/// write the result back on success.
///
/// Lock discipline: this function itself only ever holds `conn` (passed in already locked by
/// the caller) for the synchronous `sessions_needing_summary` query below — it never awaits
/// anything, so holding the caller's lock through this call is fine. Each *spawned* task,
/// however, re-acquires the DB lock independently via its own `app_handle.state::<db::Db>()`
/// call, and only for its two brief DB-only steps — gathering prompt context
/// (`session_prompt_context`) and, later, writing the result — never across the file read in
/// between (`build_prompt_from_context`, a full read + parse of the session's raw log) or the
/// `.await` on `summarize::call_anthropic_api` that follows it. Holding a
/// `MutexGuard<Connection>` across either of those would be the bug this function exists to
/// avoid: a slow file read or a hanging network call would hold the single shared DB
/// connection hostage, blocking every other DB access (including this same sweep's next tick,
/// and any UI command) for as long as it takes.
fn spawn_summary_tasks(app_handle: &tauri::AppHandle, conn: &rusqlite::Connection) {
  let api_key = app_handle.state::<summarize::ApiKeyState>().0.clone();
  let Some(api_key) = api_key else {
    // Already logged once at startup (see `setup()`) — nothing further to log here, and
    // logging again per-tick is exactly what `log_summarization_disabled_once` prevents.
    return;
  };

  let Some(model) = cost::pricing::haiku_model_id() else {
    summarize::log_summarization_disabled_once(
      "bundled pricing.json has no model entry containing \"haiku\"",
    );
    return;
  };

  let ids = match db::queries::sessions_needing_summary(conn) {
    Ok(ids) => ids,
    Err(e) => {
      log::warn!("idle sweep: failed to query sessions_needing_summary: {e:#}");
      return;
    }
  };

  if ids.is_empty() {
    return;
  }

  let to_spawn: Vec<String> = {
    let in_flight = app_handle.state::<summarize::InFlight>();
    let mut set = in_flight.0.lock().unwrap();
    ids.into_iter().filter(|id| set.insert(id.clone())).collect()
  };

  if to_spawn.is_empty() {
    return; // every eligible session is already being summarized from an earlier tick
  }

  let client = app_handle.state::<summarize::HttpClient>().0.clone();

  for session_id in to_spawn {
    let app_handle = app_handle.clone();
    let api_key = api_key.clone();
    let model = model.to_string();
    let client = client.clone();

    tauri::async_runtime::spawn(async move {
      // Removes `session_id` from the in-flight set when this async block ends, on every
      // exit path — normal completion below, or any of the early `return`s on error/skip
      // branches. See `InFlightGuard`'s doc comment.
      let _guard = summarize::InFlightGuard::new(app_handle.clone(), session_id.clone());

      // DB-only: gather what's needed to build a prompt. `conn` (the MutexGuard) is dropped
      // at the end of this block — held only for these two quick queries, never across the
      // file read that follows or the `.await` after that.
      let context_result = {
        let db = app_handle.state::<db::Db>();
        let conn = db.0.lock().unwrap();
        summarize::prompts::session_prompt_context(&conn, &session_id)
      };

      let context = match context_result {
        Ok(Some(context)) => context,
        Ok(None) => {
          log::debug!(
            "idle sweep: session {session_id} has no raw_log_path row; leaving summary NULL"
          );
          return;
        }
        Err(e) => {
          log::warn!("idle sweep: failed to gather prompt context for session {session_id}: {e:#}");
          return;
        }
      };

      // Filesystem, no lock held: re-reads the session's raw log. This is the I/O the
      // DB-lock/file-read split exists to keep off the shared connection mutex — see
      // `build_prompt_from_context`'s doc comment.
      let prompt = match summarize::prompts::build_prompt_from_context(&context) {
        Ok(Some(prompt)) => prompt,
        Ok(None) => {
          log::debug!(
            "idle sweep: session {session_id} has nothing to summarize (no captured user text); leaving summary NULL"
          );
          return;
        }
        Err(e) => {
          log::warn!("idle sweep: failed to build summary prompt for session {session_id}: {e:#}");
          return;
        }
      };

      match summarize::call_anthropic_api(&client, &api_key, &model, prompt).await {
        Ok(summary) => {
          let write_result = {
            let db = app_handle.state::<db::Db>();
            let conn = db.0.lock().unwrap();
            db::queries::update_summary(&conn, &session_id, &summary)
          };
          match write_result {
            Ok(()) => {
              let _ = app_handle.emit(
                "data-changed",
                serde_json::json!({ "entity": "session", "kind": "updated" }),
              );
            }
            Err(e) => {
              log::warn!("idle sweep: failed to write summary for session {session_id}: {e:#}")
            }
          }
        }
        Err(e) => {
          log::warn!("idle sweep: summarization API call failed for session {session_id}: {e:#}");
        }
      }
      // `_guard` drops here (or at whichever `return` above fired), removing session_id from
      // the in-flight set either way.
    });
  }
}
