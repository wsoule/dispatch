---
id: t-4c017f
title: "Multi-user daemon: configurable bind, per-user tokens over two-tier auth"
status: dropped
kind: task
parent: e-5f3530
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:33.644Z
updated: 2026-08-23T14:29:38.966Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
---

## Description

dispatchd gains a team-serve mode: bind address configurable beyond 127.0.0.1 (opt-in, off by default), and the existing agentToken/appToken two-tier auth extends to per-user tokens so each teammate authenticates individually and every decision/dispatch is attributable to a person. Token issuance stays simple for v1 (admin mints tokens from team.yml identities; no OAuth). The localhost single-user path is unchanged when team-serve is off.

## Acceptance Criteria

## Activity
