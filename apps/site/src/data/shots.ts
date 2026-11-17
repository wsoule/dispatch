// Every app screenshot on the site, by slot. Each slot is a set of files in
// public/shots/: `<file>-light-<w>.webp` and `<file>-dark-<w>.webp` at 900 and
// 1600 pixels wide (dark only when `darkOnly`). To swap a picture, replace its
// files and update its size and alt text here.
export interface Shot {
  file: string;
  width: number;
  height: number;
  alt: string;
  darkOnly?: boolean;
}

export const WIDTHS = [900, 1600] as const;

export const shots = {
  // The home page hero: the Overseer flagging a task that needs you.
  hero: {
    file: 'overseer',
    width: 1600,
    height: 997,
    alt: 'Dispatch with its sidebar and the Overseer in the middle: you asked it to add offline mode, it planned a milestone and sent an agent, and it flags a tool approval. Coming in lists that approval with Approve, Approve session and Deny; Going out lists two agents still working.',
  },
  // A finished run: its log, the reviewer's note, the diff and Merge.
  run: {
    file: 'run',
    width: 1600,
    height: 997,
    alt: "A finished run in the middle of Dispatch: the agent's change to the forecast code and its new test as a diff, and a Ready to merge box with Merge and Dismiss.",
  },
  // The board, one of the panels people change.
  board: {
    file: 'board',
    width: 1600,
    height: 997,
    alt: 'Issues for the storefront project in Dispatch, with the sidebar on the left: tasks grouped by draft, ready, working, review and landed, each with its labels and status.',
  },
  // A teammate's window: their agents show under Sessions.
  team: {
    file: 'team',
    width: 1600,
    height: 997,
    alt: "Bob's Dispatch: under Runs, Sessions lists his teammate Ada's two agents, one blocked waiting on her and one working.",
    darkOnly: true,
  },
  week: {
    file: 'week',
    width: 1600,
    height: 997,
    alt: 'My week: one person’s open tasks this week and later, grouped by milestone with due dates and progress, against their capacity in points.',
  },
  allocation: {
    file: 'allocation',
    width: 1600,
    height: 997,
    alt: 'Allocation: a preview of which unassigned tasks would go to whom in each project’s next milestone, and each person’s load against their capacity.',
  },
  projects: {
    file: 'projects',
    width: 1600,
    height: 997,
    alt: 'Projects: each project and milestone under its initiative, with its lead, dates, standing and progress, beside warnings such as slipping milestones and people over capacity.',
  },
  timeline: {
    file: 'timeline',
    width: 1600,
    height: 997,
    alt: 'Timeline: six projects as lanes of milestone bars from November to January, with a line for today and labels for what is at risk or overdue.',
  },
  graph: {
    file: 'graph',
    width: 1600,
    height: 997,
    alt: 'Graph at the Projects level: a card for each project with its landed count and progress, beside the longest open chain and the tasks ready to start.',
  },
  // The Projects menu at the top of the sidebar.
  picker: {
    file: 'picker',
    width: 1600,
    height: 1005,
    alt: 'The Projects menu open from the top of the sidebar: api-gateway, docs-site, pocket-weather and storefront, each with its folder, storefront checked, and Add project… at the bottom.',
  },
  // Settings › Linear, before signing in.
  linear: {
    file: 'linear',
    width: 1600,
    height: 338,
    alt: 'The Linear section of Settings: a line about two-way sync and choosing the workspace in your browser, and a Sign in to Linear button.',
  },
  // The Hub panel in the app, listing mods from dispatch.foo/hub.
  hub: {
    file: 'hub',
    width: 1600,
    height: 997,
    alt: 'The Hub in Dispatch: panels, themes and layouts other people made, each with its kind, a one-line summary, its author and a Preview button.',
  },
  // A mod's preview before it installs: where it comes from and its code.
  hubPreview: {
    file: 'hub-preview',
    width: 1600,
    height: 997,
    alt: 'The Hub previewing the Today panel: where it comes from and the commit it is pinned to, a warning to read the code first, Install Today, View on GitHub, and the panel’s main.js in full.',
  },
} satisfies Record<string, Shot>;

export type ShotName = keyof typeof shots;
