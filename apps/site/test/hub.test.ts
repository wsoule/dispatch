import { expect, test } from 'bun:test';

import { HUB_VERSION, hubMods, ownerUrl } from '../src/data/hub';

const KINDS = ['panel', 'theme', 'layout'];
const FIELDS = [
  'id',
  'name',
  'kind',
  'summary',
  'author',
  'repo',
  'commit',
  'path',
  'added',
];

// Every rule the app relies on when it reads /hub/index.json and installs an
// entry: an id it can use as a folder or file name, an exact commit, and a
// path that stays inside the repo and matches its kind.
test('every hub entry matches the index format', () => {
  expect(hubMods.length).toBeGreaterThan(0);
  for (const m of hubMods) {
    const problems = [
      !/^[a-z0-9-]{1,40}$/.test(m.id) && 'id',
      m.name.trim() === '' && 'name',
      !KINDS.includes(m.kind) && 'kind',
      m.summary.trim() === '' && 'summary',
      (m.author.trim() === '' || m.author.length > 40) && 'author',
      !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(m.repo) && 'repo',
      !/^[0-9a-f]{40}$/.test(m.commit) && 'commit',
      (m.path === '' ||
        m.path.startsWith('/') ||
        m.path.split('/').includes('..')) &&
        'path',
      m.kind === 'panel' && m.path.endsWith('.json') && 'panel path',
      m.kind !== 'panel' && !m.path.endsWith('.json') && 'file path',
      !/^\d{4}-\d{2}-\d{2}$/.test(m.added) && 'added',
    ].filter(Boolean);
    expect({ id: m.id, problems }).toEqual({ id: m.id, problems: [] });
  }
});

test('hub ids are unique', () => {
  const ids = hubMods.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('/hub/index.json serves exactly the index format', async () => {
  const file = Bun.file(new URL('../dist/hub/index.json', import.meta.url));
  expect(await file.exists()).toBe(true);
  const index = (await file.json()) as {
    version: number;
    mods: Record<string, unknown>[];
  };
  expect(Object.keys(index)).toEqual(['version', 'mods']);
  expect(index.version).toBe(HUB_VERSION);
  expect(index.mods.length).toBe(hubMods.length);
  for (const entry of index.mods) expect(Object.keys(entry)).toEqual(FIELDS);
});

test('/hub lists every mod with its source and install line', async () => {
  const hub = await Bun.file(
    new URL('../dist/hub/index.html', import.meta.url)
  ).text();
  for (const m of hubMods) {
    expect(hub).toContain(`dispatch-app hub install ${m.id}`);
    expect(hub).toContain(`/${m.commit}/${m.path}`);
  }
  for (const m of hubMods) {
    expect(hub).toContain(`href="${ownerUrl(m)}"`);
    // The author is a display name, so it never becomes a profile link itself.
    if (m.author !== m.repo.split('/')[0])
      expect(hub).not.toContain(`href="https://github.com/${m.author}"`);
  }
  expect(hub).toContain('href="/hub/index.json"');
  expect(hub).toContain('github.com/wsoule/dispatch/issues/new');
});
