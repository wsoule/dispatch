---
id: t-5bce76
title: Verify Codex/Gemini/Cursor session ingestion against real installations
status: todo
kind: task
parent: e-98857a
milestone: null
blocked-by: []
labels:
  - desktop
priority: medium
assignee: none
created: 2026-08-10T22:47:41.528Z
updated: 2026-08-10T22:47:41.528Z
external: null
writes: []
---

## Description

The desktop watcher (apps/desktop/src-tauri/src/watcher/mod.rs, AGENT_SOURCES) tails ~/.codex/sessions, ~/.gemini/tmp, and ~/.cursor/logs, with parsers in src-tauri/src/parser/{codex_jsonl,gemini_log,cursor_jsonl}.rs — and the code's own comments say the roots and formats are "Best-effort guess… Unverified against a real installation." Only the Claude source is verified.

For each of the three: install the current tool, run a real session, confirm the root path and log format, fix the parser against actual output, and capture a small anonymized fixture so the parser has a regression test. Token/cost extraction should flow into the existing SQLite cost engine (pricing.json fallback covers unknown models). If a tool's format turns out unparseable or the tool has moved formats, document that in the parser rather than leaving the guess.

This is the observability half of vendor neutrality — table stakes for claiming multi-harness support like Xirp's.

## Acceptance Criteria

## Activity
