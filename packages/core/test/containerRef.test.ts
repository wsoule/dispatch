import { describe, expect, it } from 'bun:test';

import {
  type ContainerCandidate,
  resolveMilestoneRef,
} from '../src/containerRef.js';

function c(
  id: string,
  title: string,
  kind: string,
  archivedAt?: string
): ContainerCandidate {
  return {
    meta: {
      id,
      title,
      kind,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    },
  };
}

const tasks = [
  c('p-1', 'Payments', 'project'),
  c('m-1', 'Beta', 'milestone'),
  c('e-1', 'Legacy', 'epic'),
  c('i-1', 'Growth', 'initiative'),
  c('t-1', 'Parent issue', 'task'),
  c('m-9', 'Old', 'milestone', '2026-01-01T00:00:00.000Z'),
];

describe('resolveMilestoneRef', () => {
  it('finds a milestone or project by title, trimmed then case-insensitive', () => {
    expect(resolveMilestoneRef(tasks, 'Beta')).toEqual({ ok: true, id: 'm-1' });
    expect(resolveMilestoneRef(tasks, '  payments ')).toEqual({
      ok: true,
      id: 'p-1',
    });
    // A legacy epic reads as a milestone.
    expect(resolveMilestoneRef(tasks, 'Legacy')).toEqual({
      ok: true,
      id: 'e-1',
    });
  });

  it('accepts a container id, archived ones included', () => {
    expect(resolveMilestoneRef(tasks, 'p-1')).toEqual({ ok: true, id: 'p-1' });
    expect(resolveMilestoneRef(tasks, 'm-9')).toEqual({ ok: true, id: 'm-9' });
    expect(resolveMilestoneRef(tasks, 'Old').ok).toBe(false);
  });

  it('never resolves to an initiative or a parent issue', () => {
    const growth = resolveMilestoneRef(tasks, 'Growth');
    expect(growth.ok).toBe(false);
    expect(resolveMilestoneRef(tasks, 't-1').ok).toBe(false);
  });

  it('says which name matched nothing', () => {
    expect(resolveMilestoneRef(tasks, 'Gamma')).toEqual({
      ok: false,
      error:
        'invalid milestone: no project or milestone is titled "Gamma" — create it first, or send parent',
    });
    expect(resolveMilestoneRef(tasks, '   ').ok).toBe(false);
  });

  it('refuses to guess between two containers with one title', () => {
    const twice = [...tasks, c('p-2', 'Beta', 'project')];
    expect(resolveMilestoneRef(twice, 'Beta')).toEqual({
      ok: false,
      error:
        'invalid milestone: "Beta" matches m-1 (milestone), p-2 (project) — send parent instead',
    });
  });

  it('prefers an exact title over a case-insensitive one', () => {
    const cased = [...tasks, c('m-2', 'beta', 'milestone')];
    expect(resolveMilestoneRef(cased, 'beta')).toEqual({
      ok: true,
      id: 'm-2',
    });
  });

  it('checks the container can hold the kind being filed', () => {
    expect(
      resolveMilestoneRef(tasks, 'Beta', { childKind: 'project' })
    ).toEqual({
      ok: false,
      error: 'invalid milestone: a project cannot sit under milestone m-1',
    });
    expect(
      resolveMilestoneRef(tasks, 'Payments', { childKind: 'milestone' })
    ).toEqual({ ok: true, id: 'p-1' });
  });

  it('must agree with a parent sent beside it', () => {
    expect(resolveMilestoneRef(tasks, 'Beta', { parent: 'm-1' })).toEqual({
      ok: true,
      id: 'm-1',
    });
    expect(resolveMilestoneRef(tasks, 'Beta', { parent: 'p-1' })).toEqual({
      ok: false,
      error:
        'invalid milestone: "Beta" is m-1, but parent is p-1 — send parent only',
    });
  });
});
