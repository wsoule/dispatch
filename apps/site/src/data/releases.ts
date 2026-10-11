// Releases for the home page strip and /changelog, newest first. Each summary
// restates its v* tag's release commit for someone who has not used the app.
export interface Release {
  v: string;
  date: string;
  title: string;
  text: string;
}

export const releases: Release[] = [
  {
    v: 'v0.42.0',
    date: 'Oct 9, 2026',
    title: 'Two views is the whole app',
    text: 'Overseer and Tasks replace the old sidebar layout, and every finished task says plainly how it ended.',
  },
  {
    v: 'v0.41.0',
    date: 'Oct 7, 2026',
    title: 'Origin-first merges',
    text: 'Landing merges through your remote first, and queued Overseer messages can be edited.',
  },
  {
    v: 'v0.40.2',
    date: 'Oct 6, 2026',
    title: 'Sharper topic routing',
    text: 'The Overseer is better at telling a new subject from a follow-up.',
  },
  {
    v: 'v0.40.1',
    date: 'Oct 6, 2026',
    title: 'Two views, rebuilt',
    text: 'Flows, opening work in the middle, and docs and threads in the top bar.',
  },
  {
    v: 'v0.40.0',
    date: 'Oct 6, 2026',
    title: 'Two views everywhere',
    text: 'Task pages, the graph, docs and peeks all move to Overseer and Tasks.',
  },
  {
    v: 'v0.39.0',
    date: 'Oct 6, 2026',
    title: 'Set conversations aside',
    text: 'Topic routing, asks beside the conversation, model and effort controls, and slash commands.',
  },
  {
    v: 'v0.38.0',
    date: 'Oct 6, 2026',
    title: 'The Overseer',
    text: 'One conversation that plans milestones and drives tasks, with every change waiting for your approval.',
  },
  {
    v: 'v0.37.1',
    date: 'Oct 6, 2026',
    title: 'Team setup in three steps',
    text: 'Start a team, invite, join from one link. License keys and security patches.',
  },
  {
    v: 'v0.37.0',
    date: 'Oct 5, 2026',
    title: 'Agents that talk',
    text: 'Agent-to-agent messaging, memory, team docs, A2A peer to peer, team sync and the relay.',
  },
  {
    v: 'v0.36.0',
    date: 'Sep 26, 2026',
    title: 'Linear sync and Live',
    text: 'Two-way Linear sync, the Cockpit, flight plans, the Live graph, and speed at 2,000+ tasks.',
  },
  {
    v: 'v0.35.0',
    date: 'Sep 23, 2026',
    title: 'Team mode',
    text: 'A shared daemon, previews, HTTPS and board sync, plus terminals, files, Design mode and ssh remotes.',
  },
  {
    v: 'v0.34.0',
    date: 'Sep 20, 2026',
    title: 'Views and labels',
    text: 'Deep links, an AI filter, labels, saved views, attachments, swim lanes and the Branches view.',
  },
  {
    v: 'v0.33.0',
    date: 'Sep 20, 2026',
    title: 'Milestone fan-out',
    text: 'Hand a plan to a milestone and send its agents, with spend ceilings, pause and resume.',
  },
  {
    v: 'v0.32.0',
    date: 'Sep 20, 2026',
    title: 'SQLite by default',
    text: 'A new look, tasks in a database with a git receipt log, and TypeSafe judgments.',
  },
  {
    v: 'v0.31.0',
    date: 'Sep 15, 2026',
    title: 'Model choice',
    text: 'The first overseer, and a choice of model per kind of work.',
  },
  {
    v: 'v0.28.0',
    date: 'Sep 11, 2026',
    title: 'Policy with receipts',
    text: 'Policy decisions recorded as receipts, runs that survive restarts, and a notification center.',
  },
];
