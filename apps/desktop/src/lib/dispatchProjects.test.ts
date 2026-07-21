import { describe, expect, test } from 'bun:test';

import {
  dedupeProjectsByPath,
  filterDispatchEnabledProjects,
} from './dispatchProjects';
import type { ProjectSummary } from './types';

function makeProject(id: string, path: string): ProjectSummary {
  return {
    id,
    name: id,
    path,
    lang: null,
    stack: null,
    created_at: 0,
    last_active: 0,
    session_count: 0,
    total_cost_usd: 0,
    agents: [],
  };
}

describe('filterDispatchEnabledProjects', () => {
  test('keeps only projects whose path maps to true', () => {
    const projects = [
      makeProject('a', '/repo/a'),
      makeProject('b', '/repo/b'),
      makeProject('c', '/repo/c'),
    ];
    const flags = new Map([
      ['/repo/a', true],
      ['/repo/b', false],
    ]);

    expect(filterDispatchEnabledProjects(projects, flags)).toEqual([
      projects[0],
    ]);
  });

  test('treats a path missing from the map as not dispatch-enabled', () => {
    const projects = [makeProject('a', '/repo/a')];
    expect(filterDispatchEnabledProjects(projects, new Map())).toEqual([]);
  });

  test('returns an empty array when nothing is enabled', () => {
    const projects = [makeProject('a', '/repo/a')];
    const flags = new Map([['/repo/a', false]]);
    expect(filterDispatchEnabledProjects(projects, flags)).toEqual([]);
  });
});

describe('dedupeProjectsByPath', () => {
  // Relay's own project list can carry more than one row for the same filesystem path —
  // e.g. a repo worked in with both Claude Code and Codex gets one project row per
  // originating agent-log source, same `path`, different `id`. A dispatchd sidecar is 1:1
  // with a *path* (ensure_dispatchd/has_dispatch both key off it, never off Relay's row
  // id), so fanning out a sidecar-per-project-row query (the sidebar's switcher, the
  // command palette's project-switch entries, `useAllAgents`' cross-project fan-out) over
  // the un-deduped list double-queries the same daemon and — since two entries can share an
  // in-flight `port: undefined` placeholder before either resolves — trips react-query's
  // "Duplicate Queries found" dev warning. Discovered live during phase-8 fix verification,
  // not from the original review list.
  test('keeps only the first project row for each distinct path', () => {
    const projects = [
      makeProject('claude-row', '/repo/a'),
      makeProject('codex-row', '/repo/a'),
      makeProject('b', '/repo/b'),
    ];
    expect(dedupeProjectsByPath(projects)).toEqual([projects[0], projects[2]]);
  });

  test('is a no-op when every path is already distinct', () => {
    const projects = [makeProject('a', '/repo/a'), makeProject('b', '/repo/b')];
    expect(dedupeProjectsByPath(projects)).toEqual(projects);
  });

  test('handles an empty list', () => {
    expect(dedupeProjectsByPath([])).toEqual([]);
  });
});
