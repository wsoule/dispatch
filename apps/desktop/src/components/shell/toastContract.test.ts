import { describe, expect, test } from 'bun:test';

import {
  taskToastDescription,
  toastActionFor,
  toastDurationFor,
  viewTaskLink,
} from './toastContract';

describe('toastDurationFor', () => {
  test('errors never auto-dismiss', () => {
    expect(toastDurationFor('error')).toBe(Infinity);
  });
  test('success and info keep their timings', () => {
    expect(toastDurationFor('success')).toBe(3500);
    expect(toastDurationFor('info')).toBe(4500);
  });
});

describe('toastActionFor', () => {
  const noop = () => {};

  test('a link fills the one slot', () => {
    const link = { label: 'View task', onClick: noop };
    expect(toastActionFor({ link })).toBe(link);
  });

  test('a plain action fills the same slot; the link wins when both are given', () => {
    const action = { label: 'Restart', onClick: noop };
    const link = { label: 'View task', onClick: noop };
    expect(toastActionFor({ action })).toBe(action);
    expect(toastActionFor({ action, link })).toBe(link);
  });

  test('nothing given means no action', () => {
    expect(toastActionFor({})).toBeUndefined();
  });
});

describe('task toasts', () => {
  test('the View task link opens that task', () => {
    const opened: string[] = [];
    const link = viewTaskLink('t-8f2a', (id) => opened.push(id));
    expect(link.label).toBe('View task');
    link.onClick();
    expect(opened).toEqual(['t-8f2a']);
  });

  test('the description is the id, an em dash, then the title', () => {
    expect(taskToastDescription('t-8f2a', 'Cache the search index')).toBe(
      't-8f2a — Cache the search index'
    );
  });
});
