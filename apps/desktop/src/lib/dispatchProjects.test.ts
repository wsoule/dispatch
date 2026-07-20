import { describe, expect, test } from 'bun:test';

import { filterDispatchEnabledProjects } from './dispatchProjects';
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
