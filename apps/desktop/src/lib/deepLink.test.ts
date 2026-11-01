import { describe, expect, test } from 'bun:test';

import { DEEP_LINK_SCHEME, formatTaskLink, parseTaskLink } from './deepLink';

const LINK = { taskId: 't-1a2b3c', project: '/Users/me/Sites/repo' };
const HARNESS = `http://localhost:5173/?root=${encodeURIComponent(LINK.project)}&port=4100&token=secret&appToken=app-secret`;

describe('formatTaskLink', () => {
  test('the app form encodes the project root as a query param', () => {
    expect(formatTaskLink(LINK, 'app')).toBe(
      `${DEEP_LINK_SCHEME}://task/t-1a2b3c?project=${encodeURIComponent(LINK.project)}`
    );
  });

  test('the scheme is the one tauri.conf.json registers', () => {
    expect(DEEP_LINK_SCHEME).toBe('dispatch');
  });

  test('the browser form sets task, strips both tokens and keeps root/port', () => {
    const url = new URL(formatTaskLink(LINK, 'browser', HARNESS));
    expect(url.searchParams.get('task')).toBe('t-1a2b3c');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('appToken')).toBe(false);
    expect(url.searchParams.get('root')).toBe('/Users/me/Sites/repo');
    expect(url.searchParams.get('port')).toBe('4100');
    expect(url.origin + url.pathname).toBe('http://localhost:5173/');
  });

  test('the browser form replaces a task already on the URL', () => {
    const url = new URL(
      formatTaskLink(LINK, 'browser', `${HARNESS}&task=t-ffffff`)
    );
    expect(url.searchParams.getAll('task')).toEqual(['t-1a2b3c']);
  });
});

describe('parseTaskLink', () => {
  test('round-trips the app form', () => {
    expect(parseTaskLink(formatTaskLink(LINK, 'app'))).toEqual(LINK);
  });

  test('round-trips a milestone id and a root with spaces', () => {
    const link = { taskId: 'e-abc123', project: '/Users/me/My Repo' };
    expect(parseTaskLink(formatTaskLink(link, 'app'))).toEqual(link);
  });

  test('drops a trailing slash on the project so it matches the active root', () => {
    expect(
      parseTaskLink(
        `dispatch://task/t-1a2b3c?project=${encodeURIComponent('/Users/me/repo/')}`
      )
    ).toEqual({ taskId: 't-1a2b3c', project: '/Users/me/repo' });
    expect(parseTaskLink('dispatch://task/t-1a2b3c?project=/repo//')).toEqual({
      taskId: 't-1a2b3c',
      project: '/repo',
    });
    expect(parseTaskLink('dispatch://task/t-1a2b3c?project=/')).toEqual({
      taskId: 't-1a2b3c',
      project: '/',
    });
  });

  test('a browser-form link is not an app link', () => {
    expect(parseTaskLink(formatTaskLink(LINK, 'browser', HARNESS))).toBeNull();
  });

  test('rejects other schemes and hosts', () => {
    expect(parseTaskLink('https://task/t-1a2b3c?project=/repo')).toBeNull();
    expect(parseTaskLink('dispatch://run/t-1a2b3c?project=/repo')).toBeNull();
  });

  test('rejects an id the store would refuse', () => {
    expect(parseTaskLink('dispatch://task/t-12345?project=/repo')).toBeNull();
    expect(parseTaskLink('dispatch://task/x-1a2b3c?project=/repo')).toBeNull();
    expect(parseTaskLink('dispatch://task/?project=/repo')).toBeNull();
    expect(parseTaskLink('dispatch://task?project=/repo')).toBeNull();
  });

  test('rejects a relative or missing project', () => {
    expect(parseTaskLink('dispatch://task/t-1a2b3c?project=repo')).toBeNull();
    expect(parseTaskLink('dispatch://task/t-1a2b3c?project=')).toBeNull();
    expect(parseTaskLink('dispatch://task/t-1a2b3c')).toBeNull();
  });

  test('rejects garbage', () => {
    expect(parseTaskLink('not a url')).toBeNull();
    expect(parseTaskLink('')).toBeNull();
  });
});
