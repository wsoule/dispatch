import type { DocHit } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { PaletteEntriesContext, PaletteSection } from './paletteEntries';
import {
  addressEntries,
  buildPaletteEntries,
  docHitEntries,
} from './paletteEntries';
import { parseHref } from './routes';

function context(over: Partial<PaletteEntriesContext> = {}) {
  const calls: string[] = [];
  const ctx: PaletteEntriesContext = {
    hasProject: true,
    tasks: [
      { meta: { id: 't-1', title: 'Wire the thing' } },
      { meta: { id: 't-2', title: 'Blocked one' } },
    ],
    readyIds: new Set(['t-1']),
    actions: {
      openCreateTask: () => calls.push('create'),
      openQuickAddTask: () => calls.push('quick-add'),
      setProjectView: (view) => calls.push(`project:${view}`),
      setGlobalView: (view) => calls.push(`global:${view}`),
      peekTask: (id) => calls.push(`peek:${id}`),
      dispatchTask: (id) => calls.push(`dispatch:${id}`),
      openQuickCapture: () => calls.push('capture'),
      openShortcuts: () => calls.push('shortcuts'),
    },
    ...over,
  };
  return { ctx, calls };
}

describe('buildPaletteEntries', () => {
  test('groups rows into actions, navigation and tasks in that order', () => {
    const { ctx } = context();
    const sections = buildPaletteEntries(ctx).map((e) => e.section);
    const firstOf = (s: PaletteSection) => sections.indexOf(s);
    expect(firstOf('actions')).toBeLessThan(firstOf('navigation'));
    expect(firstOf('navigation')).toBeLessThan(firstOf('tasks'));
    // No row sits outside its group.
    expect(sections.lastIndexOf('actions')).toBeLessThan(firstOf('navigation'));
    expect(sections.lastIndexOf('navigation')).toBeLessThan(firstOf('tasks'));
  });

  test('every navigation row carries the real route of the place it opens', () => {
    const { ctx } = context();
    const navigation = buildPaletteEntries(ctx).filter(
      (e) => e.section === 'navigation'
    );
    expect(navigation.length).toBeGreaterThan(0);
    const routes = Object.fromEntries(
      navigation.map((e) => [
        e.id,
        e.href === undefined ? null : parseHref(e.href),
      ])
    );
    expect(routes).toEqual({
      'go-overseer': [{ type: 'showOverseer' }],
      'go-board': [{ type: 'showTasks' }],
      'go-settings': [{ type: 'openSettings' }],
      'go-timeline': [{ type: 'openTimeline', project: null }],
      'go-graph': [
        { type: 'openGraph', scope: { level: 'milestone' }, nodeId: null },
      ],
      'go-files': [{ type: 'setProjectView', view: 'files' }],
      'go-terminals': [{ type: 'setProjectView', view: 'terminals' }],
      'go-projects': [{ type: 'setProjectView', view: 'projects' }],
      'go-live': [{ type: 'setProjectView', view: 'live' }],
    });
  });

  test('new task is C and the shortcuts sheet is ?', () => {
    const { ctx } = context();
    const byId = new Map(buildPaletteEntries(ctx).map((e) => [e.id, e]));
    expect(byId.get('action-new-task')?.shortcut).toBe('C');
    expect(byId.get('action-shortcuts')?.shortcut).toBe('?');
  });

  test('every task gets a row, and only ready tasks get a Dispatch row', () => {
    const { ctx, calls } = context();
    const byId = new Map(buildPaletteEntries(ctx).map((e) => [e.id, e]));
    expect(byId.get('task-t-1')?.sublabel).toBe('t-1');
    expect(byId.get('task-t-2')?.kind).toBe('task');
    expect(byId.has('dispatch-t-1')).toBe(true);
    expect(byId.has('dispatch-t-2')).toBe(false);
    byId.get('task-t-2')?.run();
    byId.get('dispatch-t-1')?.run();
    expect(calls).toEqual(['peek:t-2', 'dispatch:t-1']);
  });

  test('without a project only the global rows remain', () => {
    const { ctx } = context({ hasProject: false });
    const ids = buildPaletteEntries(ctx).map((e) => e.id);
    expect(ids).toEqual([
      'action-shortcuts',
      'go-overseer',
      'go-board',
      'go-settings',
    ]);
  });

  test('saved views become Open view rows under Views that run openSavedView', () => {
    const { ctx, calls } = context({
      savedViews: [{ id: 'v-1', name: 'Blocked urgent' }],
    });
    ctx.actions.openSavedView = (id) => calls.push(`view:${id}`);
    const rows = buildPaletteEntries(ctx).filter((e) => e.section === 'views');
    expect(rows.map((e) => [e.id, e.label, e.kind])).toEqual([
      ['view-v-1', 'Open view Blocked urgent', 'view'],
    ]);
    rows[0]?.run();
    expect(calls).toEqual(['view:v-1']);
    // Without the action (or without a project) there is nothing to open.
    const { ctx: noAction } = context({
      savedViews: [{ id: 'v-1', name: 'Blocked urgent' }],
    });
    expect(
      buildPaletteEntries(noAction).some((e) => e.section === 'views')
    ).toBe(false);
  });

  test('Copy link appears only with a current task and the copy action', () => {
    const has = (ctx: PaletteEntriesContext) =>
      buildPaletteEntries(ctx).some((e) => e.id === 'action-copy-link');
    const { ctx, calls } = context({ currentTaskId: 't-1' });
    ctx.actions.copyTaskLink = (id) => calls.push(`link:${id}`);
    expect(has(ctx)).toBe(true);
    const row = buildPaletteEntries(ctx).find(
      (e) => e.id === 'action-copy-link'
    );
    expect(row?.section).toBe('actions');
    expect(row?.label).toBe('Copy link');
    row?.run();
    expect(calls).toEqual(['link:t-1']);
    expect(has({ ...ctx, currentTaskId: null })).toBe(false);
    expect(has(context({ currentTaskId: 't-1' }).ctx)).toBe(false);
  });

  test('Restart the first-task guide appears when the app offers it', () => {
    const { ctx, calls } = context();
    expect(
      buildPaletteEntries(ctx).some((e) => e.id === 'action-restart-guide')
    ).toBe(false);
    const withGuide = {
      ...ctx,
      actions: {
        ...ctx.actions,
        restartGuide: () => calls.push('restart-guide'),
      },
    };
    const entry = buildPaletteEntries(withGuide).find(
      (e) => e.id === 'action-restart-guide'
    );
    expect(entry?.label).toBe('Restart the first-task guide');
    entry?.run();
    expect(calls).toContain('restart-guide');
  });
});

describe('docHitEntries', () => {
  const hit = (anchor: string, heading: string): DocHit => ({
    doc: 'doc-01K',
    handle: 'auth',
    title: 'Auth spec',
    scope: 'team',
    anchor,
    heading,
    snippet: '',
    score: 1,
  });

  test('turns each search hit into a Docs row that opens its section', () => {
    const opened: [string, string | null][] = [];
    const rows = docHitEntries(
      [hit('api', 'API'), hit('', '')],
      (docId, anchor) => opened.push([docId, anchor])
    );
    expect(
      rows.map(({ id, label, sublabel, kind, section }) => ({
        id,
        label,
        sublabel,
        kind,
        section,
      }))
    ).toEqual([
      {
        id: 'doc:doc-01K#api',
        label: 'Auth spec › API',
        sublabel: 'auth',
        kind: 'doc',
        section: 'docs',
      },
      {
        id: 'doc:doc-01K#',
        label: 'Auth spec',
        sublabel: 'auth',
        kind: 'doc',
        section: 'docs',
      },
    ]);
    for (const row of rows) row.run();
    expect(opened).toEqual([
      ['doc-01K', 'api'],
      ['doc-01K', null],
    ]);
  });
});

describe('navigation rows', () => {
  test('navigates to Overseer, Tasks, Settings and the pages under Tasks', () => {
    const { ctx, calls } = context();
    const entries = buildPaletteEntries(ctx);
    const nav = entries.filter((e) => e.section === 'navigation');
    expect(nav.map((e) => [e.label, e.shortcut])).toEqual([
      ['Go to Overseer', '⌘1'],
      ['Go to Tasks', '⌘2'],
      ['Go to Settings', '⌘,'],
      ['Go to Timeline', 'G L'],
      ['Go to Graph', 'G G'],
      ['Open Files', undefined],
      ['Open Terminals', undefined],
      ['Open Projects', undefined],
      ['Open Live', undefined],
    ]);
    expect(entries.some((e) => e.id === 'action-toggle-sidebar')).toBe(false);
    for (const row of nav) row.run();
    expect(calls).toEqual([
      'global:overseer',
      'project:board',
      'global:settings',
      'project:timeline',
      'project:graph',
      'project:files',
      'project:terminals',
      'project:projects',
      'project:live',
    ]);
  });
});

describe('plan work', () => {
  test('opens the Overseer, where plans are made', () => {
    const { ctx, calls } = context();
    const row = buildPaletteEntries(ctx).find(
      (e) => e.id === 'action-plan-work'
    );
    row?.run();
    expect(calls).toEqual(['global:overseer']);
  });
});

describe('host views below the operator tier', () => {
  test('leaves out Terminals', () => {
    const { ctx } = context({ hideHostViews: true });
    const ids = buildPaletteEntries(ctx).map((e) => e.id);
    expect(ids).toContain('go-files');
    expect(ids).not.toContain('go-terminals');
  });

  test('the operator sees Terminals', () => {
    const { ctx } = context();
    const ids = buildPaletteEntries(ctx).map((e) => e.id);
    expect(ids).toContain('go-terminals');
  });
});

describe('addressEntries', () => {
  test('people but me, active outside peers, and named rooms but milestones', () => {
    const opened: string[] = [];
    const entries = addressEntries({
      people: [
        { ref: 'human:wyat', name: 'Wyat' },
        { ref: 'human:sam', name: 'Sam' },
      ],
      rooms: ['release', 'epic/t-1'],
      peers: [
        { alias: 'acme', status: 'active' },
        { alias: 'gone', status: 'disabled' },
      ],
      me: 'human:wyat',
      open: (address) => opened.push(address),
    });
    expect(entries.map((e) => e.label)).toEqual([
      'Message Sam',
      'Message acme (outside)',
      'Open #release',
    ]);
    for (const entry of entries) entry.run();
    expect(opened).toEqual(['human:sam', 'a2a:acme', 'channel:release']);
  });
});
