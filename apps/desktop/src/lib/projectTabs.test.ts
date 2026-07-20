import { describe, expect, test } from 'bun:test';

import { resolveActiveTab } from './projectTabs';

describe('resolveActiveTab', () => {
  test('falls back to overview when tasks was requested but dispatch resolved false', () => {
    expect(resolveActiveTab('tasks', false)).toBe('overview');
  });

  test('keeps tasks once dispatch resolves true', () => {
    expect(resolveActiveTab('tasks', true)).toBe('tasks');
  });

  test('leaves tasks alone while dispatch is still unresolved', () => {
    expect(resolveActiveTab('tasks', undefined)).toBe('tasks');
  });

  test('never touches a non-tasks requested tab, regardless of dispatchEnabled', () => {
    expect(resolveActiveTab('overview', false)).toBe('overview');
    expect(resolveActiveTab('board', false)).toBe('board');
    expect(resolveActiveTab('sessions', undefined)).toBe('sessions');
  });
});
