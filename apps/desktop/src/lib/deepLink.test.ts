import { describe, expect, test } from 'bun:test';

import {
  DEEP_LINK_SCHEME,
  formatIssueLink,
  formatTaskLink,
  formatWebIssueLink,
  parseDeepLink,
  resolveIssueTask,
  type TaskLink,
} from './deepLink';

// The task form of `parseDeepLink`, in the shape `formatTaskLink` takes.
function parseTaskLink(url: string): TaskLink | null {
  const link = parseDeepLink(url);
  return link?.kind === 'task'
    ? { taskId: link.taskId, project: link.project }
    : null;
}

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

describe('parseDeepLink: task', () => {
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

describe('parseDeepLink: issue', () => {
  test('round-trips an identifier', () => {
    expect(formatIssueLink('DIS-66')).toBe('dispatch://issue/DIS-66');
    expect(parseDeepLink(formatIssueLink('DIS-66'))).toEqual({
      kind: 'issue',
      identifier: 'DIS-66',
    });
    expect(parseDeepLink('dispatch://issue/AB2-1')).toEqual({
      kind: 'issue',
      identifier: 'AB2-1',
    });
  });

  test('ignores a project param: an issue resolves in the open project', () => {
    expect(parseDeepLink('dispatch://issue/DIS-66?project=/repo')).toEqual({
      kind: 'issue',
      identifier: 'DIS-66',
    });
  });

  test('rejects anything not shaped like a Linear identifier', () => {
    for (const bad of [
      'dis-66',
      'DIS-0',
      'DIS-066',
      'DIS66',
      '1DIS-66',
      'DIS-66-1',
      'DIS-',
      '-66',
      'ABCDEFGHIJK-1',
      'DIS-1234567890',
      'DIS-66/extra',
      '',
    ]) {
      expect(parseDeepLink(`dispatch://issue/${bad}`)).toBeNull();
    }
    expect(parseDeepLink('dispatch://issue')).toBeNull();
    expect(parseDeepLink('https://issue/DIS-66')).toBeNull();
  });
});

describe('parseDeepLink: run', () => {
  test('parses a short and a synced run id with its project', () => {
    expect(parseDeepLink('dispatch://run/r-1a2b3c?project=/repo/')).toEqual({
      kind: 'run',
      runId: 'r-1a2b3c',
      project: '/repo',
    });
    expect(
      parseDeepLink('dispatch://run/r-e49e68c6dd78?project=/repo')
    ).toEqual({ kind: 'run', runId: 'r-e49e68c6dd78', project: '/repo' });
  });

  test('rejects a bad run id or a missing project', () => {
    expect(parseDeepLink('dispatch://run/r-12345?project=/repo')).toBeNull();
    expect(parseDeepLink('dispatch://run/t-1a2b3c?project=/repo')).toBeNull();
    expect(parseDeepLink('dispatch://run/r-1a2b3c')).toBeNull();
    expect(parseDeepLink('dispatch://run/r-1a2b3c?project=repo')).toBeNull();
  });

  test('rejects an unknown host', () => {
    expect(parseDeepLink('dispatch://doc/r-1a2b3c?project=/repo')).toBeNull();
  });
});

describe('resolveIssueTask', () => {
  const links = {
    'uuid-66': {
      identifier: 'DIS-66',
      url: 'https://linear.app/acme/issue/DIS-66/x',
    },
    'uuid-67': {
      identifier: 'DIS-67',
      url: 'https://linear.app/acme/issue/DIS-67/y',
    },
  };
  const task = (id: string, external: string | null, archivedAt?: string) => ({
    meta: { id, external, ...(archivedAt === undefined ? {} : { archivedAt }) },
  });

  test('finds the task whose external names the issue', () => {
    expect(
      resolveIssueTask('DIS-66', links, [
        task('t-000001', 'linear:uuid-67'),
        task('t-000002', 'linear:uuid-66'),
      ])
    ).toBe('t-000002');
  });

  test('null when the identifier is unknown or no task links its issue', () => {
    const tasks = [task('t-000001', 'linear:uuid-67')];
    expect(resolveIssueTask('DIS-99', links, tasks)).toBeNull();
    expect(resolveIssueTask('DIS-66', links, tasks)).toBeNull();
    expect(
      resolveIssueTask('DIS-66', {}, [task('t-1', 'linear:uuid-66')])
    ).toBeNull();
  });

  test('a Linear project with the same id is not the issue', () => {
    expect(
      resolveIssueTask('DIS-66', links, [
        task('e-000001', 'linear-project:uuid-66'),
      ])
    ).toBeNull();
  });

  test('a live task wins over an archived one on the same issue', () => {
    expect(
      resolveIssueTask('DIS-66', links, [
        task('t-000001', 'linear:uuid-66', '2026-11-01T00:00:00Z'),
        task('t-000002', 'linear:uuid-66'),
      ])
    ).toBe('t-000002');
    expect(
      resolveIssueTask('DIS-66', links, [
        task('t-000001', 'linear:uuid-66', '2026-11-01T00:00:00Z'),
      ])
    ).toBe('t-000001');
  });
});

describe('formatWebIssueLink', () => {
  test("takes the workspace from the issue's Linear URL", () => {
    expect(
      formatWebIssueLink({
        identifier: 'DIS-66',
        url: 'https://linear.app/acme-co/issue/DIS-66/fix-the-thing',
      })
    ).toBe('https://app.dispatch.foo/w/acme-co/?issue=DIS-66');
  });

  test('null when the URL does not name a workspace', () => {
    for (const url of [
      'https://example.com/acme/issue/DIS-66',
      'https://linear.app/acme/project/DIS-66',
      'https://linear.app/',
      'not a url',
    ]) {
      expect(formatWebIssueLink({ identifier: 'DIS-66', url })).toBeNull();
    }
  });

  test('null for an identifier a deep link would refuse', () => {
    expect(
      formatWebIssueLink({
        identifier: 'dis-66',
        url: 'https://linear.app/acme/issue/dis-66',
      })
    ).toBeNull();
  });
});
