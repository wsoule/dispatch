import type { TaskMeta } from '@dispatch/core/browser';
import { expect, test } from 'bun:test';

import {
  patchedBody,
  patchedMeta,
  touchesBody,
  touchesMeta,
} from './optimisticPatch';
import { parseTaskSections } from './taskDisplay';

const META = {
  id: 't-1',
  title: 'Old',
  priority: 'low',
  estimate: null,
  dueDate: '2026-09-30',
  archivedAt: '2026-09-01T00:00:00Z',
} as unknown as TaskMeta;

test('frontmatter fields apply; nulls clear; body keys are ignored', () => {
  const next = patchedMeta(META, {
    title: 'New',
    estimate: 3,
    dueDate: null,
    description: 'not meta',
    archivedAt: null,
  });
  expect(next).toMatchObject({
    id: 't-1',
    title: 'New',
    priority: 'low',
    estimate: 3,
    dueDate: null,
  });
  expect('archivedAt' in next).toBe(false);
  expect('description' in next).toBe(false);
});

test('only frontmatter patches touch the list', () => {
  expect(touchesMeta({ priority: 'high' })).toBe(true);
  expect(touchesMeta({ archivedAt: null })).toBe(true);
  expect(touchesMeta({ description: 'x', appendActivity: 'y' })).toBe(false);
});

test('body patches rewrite their section and keep the rest', () => {
  const body =
    '## Description\n\nOld words.\n\n## Acceptance Criteria\n\n- a\n\n## Activity\n\n- x\n';
  const next = patchedBody(body, {
    description: 'New words.',
    acceptanceCriteria: '- b\n- c',
  });
  const sections = parseTaskSections(next);
  expect(sections.get('Description')).toBe('New words.');
  expect(sections.get('Acceptance Criteria')).toBe('- b\n- c');
  expect(sections.get('Activity')).toBe('- x');
  expect(touchesBody({ description: '' })).toBe(true);
  expect(touchesBody({ title: 'x' })).toBe(false);
});

test('a missing section lands before Activity', () => {
  const next = patchedBody('## Activity\n\n- x\n', {
    acceptanceCriteria: '- a',
  });
  expect(next.indexOf('## Acceptance Criteria')).toBeLessThan(
    next.indexOf('## Activity')
  );
});
