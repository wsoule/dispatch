// The mod hub's listing. /hub renders it and /hub/index.json serves it to the
// app, which installs each entry from its repo at exactly `commit`.
export type ModKind = 'panel' | 'theme' | 'layout';

export interface HubMod {
  // [a-z0-9-]{1,40}, unique; the installed folder or file name.
  id: string;
  name: string;
  kind: ModKind;
  // One sentence on what it does.
  summary: string;
  // The author's GitHub login.
  author: string;
  // A public GitHub repo, owner/name.
  repo: string;
  // The full 40-hex commit the install is pinned to.
  commit: string;
  // In the repo: a panel's folder (holding main.js), or a theme's or layout's .json file.
  path: string;
  // The day it was listed, YYYY-MM-DD.
  added: string;
}

export const HUB_VERSION = 1;

export const KINDS: { kind: ModKind; title: string }[] = [
  { kind: 'panel', title: 'Panels' },
  { kind: 'theme', title: 'Themes' },
  { kind: 'layout', title: 'Layouts' },
];

const EXAMPLES = '7a1bbe43befd4a7914aa745a68e8a783033342a1';

export const hubMods: HubMod[] = [
  {
    id: 'today',
    name: 'Today',
    kind: 'panel',
    summary:
      'Lists the runs that landed or opened a pull request since midnight, newest first.',
    author: 'wsoule',
    repo: 'wsoule/dispatch',
    commit: EXAMPLES,
    path: 'hub/examples/today',
    added: '2026-11-17',
  },
  {
    id: 'warm-dark',
    name: 'Warm dark',
    kind: 'theme',
    summary:
      'The dark theme moved toward brown, with a copper accent and the same contrast.',
    author: 'wsoule',
    repo: 'wsoule/dispatch',
    commit: EXAMPLES,
    path: 'hub/examples/warm-dark.json',
    added: '2026-11-17',
  },
  {
    id: 'goingout-left',
    name: 'Going out on the left',
    kind: 'layout',
    summary:
      'The default layout with Going out left of the Overseer and Coming in on the right.',
    author: 'wsoule',
    repo: 'wsoule/dispatch',
    commit: EXAMPLES,
    path: 'hub/examples/goingout-left.json',
    added: '2026-11-17',
  },
];

// Where an entry's code is on GitHub at its pinned commit: a tree for a
// panel's folder, a blob for a theme's or layout's file.
export function sourceUrl(m: HubMod): string {
  const view = m.kind === 'panel' ? 'tree' : 'blob';
  return `https://github.com/${m.repo}/${view}/${m.commit}/${m.path}`;
}

// The terminal line that installs an entry.
export const installLine = (m: HubMod): string =>
  `dispatch-app hub install ${m.id}`;
