import { describe, expect, it } from 'bun:test';

import {
  canonicalKind,
  fanoutCoverers,
  fanoutScope,
  isContainer,
  isContainerKind,
  parentIdsOf,
} from '../src/kinds.js';
import { parseTaskFile, serializeTaskFile } from '../src/taskfile.js';

const LEGACY_EPIC = `---
id: e-abc123
title: Old epic
status: ready
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
external: null
writes: []
---

## Description
`;

describe('kinds', () => {
  it('reads legacy epic as milestone', () => {
    expect(canonicalKind('epic')).toBe('milestone');
    expect(canonicalKind('task')).toBe('task');
    const doc = parseTaskFile(LEGACY_EPIC);
    expect(doc.meta.kind).toBe('milestone');
    expect(serializeTaskFile(doc)).toContain('kind: milestone');
  });

  it('treats container kinds as containers without children', () => {
    for (const kind of ['initiative', 'project', 'milestone', 'epic']) {
      expect(isContainerKind(kind)).toBe(true);
      expect(isContainer({ id: 'e-000001', kind })).toBe(true);
    }
    expect(isContainerKind('task')).toBe(false);
  });

  it('treats a task with children as a container', () => {
    const tasks = [
      { meta: { id: 't-000001', parent: null } },
      { meta: { id: 't-000002', parent: 't-000001' } },
    ];
    const parents = parentIdsOf(tasks);
    expect(isContainer({ id: 't-000001', kind: 'task' }, parents)).toBe(true);
    expect(isContainer({ id: 't-000002', kind: 'task' }, parents)).toBe(false);
    expect(isContainer({ id: 't-000001', kind: 'task' })).toBe(false);
  });
});

// initiative → project → { milestone → { issue, parent issue → sub-issue }, direct issue }
const TREE = [
  { meta: { id: 'i-1', kind: 'initiative', parent: null } },
  { meta: { id: 'p-1', kind: 'project', parent: 'i-1' } },
  { meta: { id: 'm-1', kind: 'milestone', parent: 'p-1' } },
  { meta: { id: 't-issue', kind: 'task', parent: 'm-1' } },
  { meta: { id: 't-parent', kind: 'task', parent: 'm-1' } },
  { meta: { id: 't-sub', kind: 'task', parent: 't-parent' } },
  { meta: { id: 't-direct', kind: 'task', parent: 'p-1' } },
];
const byId = new Map(TREE.map((t) => [t.meta.id, t]));
const childrenOf = (id: string) => TREE.filter((t) => t.meta.parent === id);
const scopeIds = (id: string) =>
  fanoutScope(id, childrenOf).map((t) => t.meta.id);

describe('fan-out scope', () => {
  it('descends through container kinds only, never into a parent issue', () => {
    expect(scopeIds('p-1').sort()).toEqual(['t-direct', 't-issue', 't-parent']);
    expect(scopeIds('i-1').sort()).toEqual(['t-direct', 't-issue', 't-parent']);
    expect(scopeIds('m-1').sort()).toEqual(['t-issue', 't-parent']);
    expect(scopeIds('t-parent')).toEqual(['t-sub']);
  });

  it('survives a parent cycle', () => {
    const loop = [
      { meta: { id: 'm-a', kind: 'milestone', parent: 'm-b' } },
      { meta: { id: 'm-b', kind: 'milestone', parent: 'm-a' } },
      { meta: { id: 't-x', kind: 'task', parent: 'm-b' } },
    ];
    const kids = (id: string) => loop.filter((t) => t.meta.parent === id);
    expect(fanoutScope('m-a', kids).map((t) => t.meta.id)).toEqual(['t-x']);
    const lookup = (id: string) => loop.find((t) => t.meta.id === id);
    expect(fanoutCoverers(loop[2], lookup)).toEqual(['m-b', 'm-a']);
  });

  it('names exactly the containers whose scope holds a task, nearest first', () => {
    const coverers = (id: string) =>
      fanoutCoverers(byId.get(id)!, (x) => byId.get(x));
    expect(coverers('t-issue')).toEqual(['m-1', 'p-1', 'i-1']);
    expect(coverers('t-direct')).toEqual(['p-1', 'i-1']);
    expect(coverers('t-sub')).toEqual(['t-parent']);
    expect(coverers('m-1')).toEqual([]);
    for (const task of TREE) {
      for (const id of coverers(task.meta.id)) {
        expect(scopeIds(id)).toContain(task.meta.id);
      }
    }
  });
});
