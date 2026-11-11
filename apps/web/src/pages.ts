import type { Device, Member, Team, User } from './db.js';

// The team service's pages, in dispatch.foo's look: a spec sheet printed in
// negative (near-black paper, off-white ink, full-strength 1px rules, square
// corners, mono labels, one indigo accent). Server-rendered; the only script
// is /app.js, which adds copy buttons. Every value from a person or a
// database goes through esc().

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The policy every page is served with: its own script, Google Fonts. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
  "form-action 'self' https://github.com https:; frame-ancestors 'none'; base-uri 'none'";

const STYLE = `
:root{color-scheme:dark;--bg:#0b0b0c;--panel:#0e0e0f;--panel-2:#151516;--ink:#ededed;--ink-soft:#d2d2d2;--ink-2:#a3a3a3;--ink-3:#6f6f73;
--border:#ededed;--line:rgb(237 237 237/16%);--line-2:rgb(237 237 237/28%);--hatch:rgb(255 255 255/8%);--accent:#8b8ff8;--on-accent:#0b0b0c;
--live:#3fcf8e;--warn:#f2c744;--bad:#f0605d;--body:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;
--hatching:repeating-linear-gradient(45deg,var(--hatch) 0,var(--hatch) 1px,transparent 1px,transparent 9px)}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--ink-soft);font:400 15px/1.6 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-underline-offset:3px}a:hover{color:var(--accent)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:2.6rem;padding:0 16px;border-bottom:1px solid var(--border);background-image:var(--hatching);
font:600 .7rem/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink)}
.bar a{text-decoration:none}.bar form{display:flex;align-items:center;gap:12px;margin:0}.bar .who{color:var(--ink-2)}
main{max-width:46rem;margin:0 auto;padding:48px 16px 96px}
h1{margin:0 0 12px;color:var(--ink);font:600 clamp(1.8rem,1.2rem + 2.4vw,2.6rem)/1.1 var(--body);letter-spacing:-.02em}
.lede{margin:0 0 32px;font-size:1.05rem;color:var(--ink-2);max-width:36rem}
.label{margin:40px 0 0;padding:8px 12px;border:1px solid var(--border);border-bottom:0;background-image:var(--hatching);
font:600 .66rem/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink)}
.box{border:1px solid var(--border);background:var(--panel)}.box+.box{border-top:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row .meta{color:var(--ink-3);font:400 .78rem/1.4 var(--mono);text-align:right}
.pad{padding:16px}.pad p{margin:0 0 12px}.pad p:last-child{margin:0}
.muted{color:var(--ink-3)}.ink{color:var(--ink)}
.step{display:grid;grid-template-columns:2.2rem 1fr;gap:12px;padding:16px;border-top:1px solid var(--line)}.step:first-child{border-top:0}
.step .n{width:2.2rem;height:2.2rem;display:grid;place-items:center;border:1px solid var(--border);font:600 .8rem var(--mono);color:var(--ink)}
.step h3{margin:4px 0 6px;color:var(--ink);font:600 1rem var(--body)}.step p{margin:0 0 10px;color:var(--ink-2)}
.cmd{display:flex;align-items:stretch;border:1px solid var(--line-2);background:var(--bg)}
.cmd code{flex:1;padding:10px 12px;font:400 .85rem/1.5 var(--mono);color:var(--ink);overflow-x:auto;white-space:nowrap}
.cmd button{border:0;border-left:1px solid var(--line-2);min-height:auto;padding:0 14px;font-size:.66rem}
code{font-family:var(--mono);font-size:.86em;color:var(--ink)}
.dot{display:inline-block;width:7px;height:7px;margin-right:8px;background:var(--ink-3);vertical-align:middle}.dot.on{background:var(--live)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:2.6rem;padding:0 1.1rem;border:2px solid var(--border);background:transparent;color:var(--ink);
font:600 .72rem/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;text-decoration:none;cursor:pointer;transition:background 150ms,border-color 150ms,color 150ms}
button:hover,.btn:hover{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}.primary:hover{border-color:var(--ink);background:var(--ink);color:var(--bg)}
.small{min-height:2rem;padding:0 .8rem;border-width:1px;font-size:.62rem}
input,select{width:100%;min-height:2.6rem;padding:0 12px;border:1px solid var(--line-2);border-radius:0;background:var(--bg);color:var(--ink);font:400 .9rem var(--mono)}
input:focus,select:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
form.inline{display:flex;gap:8px;margin:0}form.inline input{flex:1}
.code{display:inline-block;padding:14px 18px;border:2px solid var(--accent);color:var(--ink);font:600 1.6rem/1 var(--mono);letter-spacing:.18em}
.note{padding:12px;border:1px solid var(--warn);color:var(--ink-soft)}.err{padding:12px;border:1px solid var(--bad);color:var(--ink);margin-bottom:16px}
.ok{color:var(--live)}
.foot{margin-top:64px;color:var(--ink-3);font:400 .72rem var(--mono)}
details.fold{margin-top:40px}details.fold>summary{list-style:none;cursor:pointer}details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary .label{margin:0}details.fold>summary .label::after{content:' +';color:var(--ink-3)}details.fold[open]>summary .label::after{content:' −'}
details.fold:not([open])>summary .label{border-bottom:1px solid var(--border)}
`;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">';

function page(title: string, user: User | null, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>${esc(title)} · Dispatch</title>${FONTS}<style>${STYLE}</style><script src="/app.js" defer></script></head><body>
<div class="bar"><a href="/">Dispatch / Teams</a>${
    user === null
      ? '<a href="https://dispatch.foo">dispatch.foo</a>'
      : `<form method="post" action="/auth/logout"><a class="who" href="/">${esc(user.login)}</a><button class="small">Sign out</button></form>`
  }</div>
<main>${body}<p class="foot">Dispatch · agents that work together, whatever they run on</p></main></body></html>`;
}

/** A command with a copy button. */
function cmd(text: string): string {
  return `<div class="cmd"><code>${esc(text)}</code><button type="button" class="small" data-copy="${esc(text)}">Copy</button></div>`;
}

/** The copy-button script, served at /app.js. */
export const APP_JS = `document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
  if (!b) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy') || '').then(() => {
    const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was; }, 1500);
  });
});`;

export function signInPage(
  next: string,
  devLogin: boolean,
  linear = false
): string {
  return page(
    'Sign in',
    null,
    `<h1>Your agents, talking to your team's agents.</h1>
<p class="lede">Claude Code, Codex, Cursor, Gemini and Claude on the web: every session on every teammate's machine can find, message and hand work to every other, and work your Linear together.</p>
<p><a class="btn primary" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a>${
      linear
        ? ` <a class="btn" href="/auth/linear?next=${encodeURIComponent(next)}">Sign in with Linear</a>`
        : ''
    }</p>
<p class="meta">Or <a href="/w/demo/">try the planner on a demo workspace</a>, no sign-in needed.</p>
${devLogin ? `<form method="get" action="/auth/dev" class="inline" style="margin-top:16px"><input name="login" placeholder="dev login"><input type="hidden" name="next" value="${esc(next)}"><button>Dev sign-in</button></form>` : ''}`
  );
}

/** The hosted planner's part of the home page: your Linear workspaces. */
export interface PlannerLinks {
  workspaces: { urlKey: string; name: string }[];
  /** Whether this server can hold a new Linear grant. */
  canOpen: boolean;
  /** Whether this server can host a workspace's own planner (an install). */
  canInstall?: boolean;
}

// Your Linear workspaces, then one way to add one. The demo shows only to
// someone with no workspace of their own.
function plannerBox(planner: PlannerLinks): string {
  const rows = planner.workspaces
    .map(
      (w) =>
        `<div class="row"><a href="/w/${esc(w.urlKey)}/">${esc(w.name)}</a><span class="meta">Linear workspace</span></div>`
    )
    .join('');
  const demo =
    planner.workspaces.length === 0
      ? '<div class="row"><a href="/w/demo/">Northwind (demo)</a><span class="meta">Try it</span></div>'
      : '';
  const install =
    planner.canInstall === true
      ? ' Admins can <a href="/auth/linear/install">install Dispatch</a> so edits sync back for everyone.'
      : '';
  const open = planner.canOpen
    ? `<div class="row"><span class="muted">Timeline, projects and dependency graph, from Linear.${install}</span><a class="btn small" href="/auth/linear/workspace">${planner.workspaces.length === 0 ? 'Open' : 'Add'} a workspace</a></div>`
    : '';
  return `<div class="label">Planner</div><div class="box">${rows}${demo}${open}</div>`;
}

/** One of your signed-in machines, as Home lists it. */
export interface MachineRow {
  id: string;
  client: string;
  teamName: string;
  lastSeen: string | null;
  online: boolean;
  /** The projects it lets the web reach; null when it could not say. */
  projects: { key: string; name: string }[] | null;
  /** Why it lists none, when it answered with a reason. */
  note?: string;
}

// Your own machines and the projects open on them, each one a link.
function machinesBox(machines: MachineRow[]): string {
  if (machines.length === 0)
    return '<div class="box pad"><p class="muted">No machine signed in yet. Run <code>dispatch-mcp login</code> on one, then turn on Web access in the desktop app’s Settings, under This machine.</p></div>';
  const rows = machines
    .map((m) => {
      const head = `<div class="row"><span><span class="dot${m.online ? ' on' : ''}"></span><span class="ink">${esc(m.client)}</span> <span class="muted">${esc(m.teamName)}</span></span><span class="meta">${m.online ? 'online' : m.lastSeen === null ? 'never seen' : `last seen ${esc(m.lastSeen.slice(0, 16).replace('T', ' '))}`}</span></div>`;
      if (!m.online) return head;
      if (m.projects === null || m.projects.length === 0)
        return `${head}<div class="row"><span class="meta">${esc(m.note ?? 'No project is open on this machine.')}</span></div>`;
      return (
        head +
        m.projects
          .map(
            (p) =>
              `<div class="row"><a href="/m/${esc(m.id)}/${esc(p.key)}/">${esc(p.name)}</a><span class="meta">Open</span></div>`
          )
          .join('')
      );
    })
    .join('');
  return `<div class="box">${rows}</div>`;
}

// How this account signs in, with a button for each provider it could add.
function signInLine(
  identities: { github: boolean; linear: boolean },
  available: { github: boolean; linear: boolean }
): string {
  const using = [
    identities.github ? 'GitHub' : null,
    identities.linear ? 'Linear' : null,
  ].filter((v): v is string => v !== null);
  const add = (
    [
      ['GitHub', !identities.github && available.github, '/auth/github/link'],
      ['Linear', !identities.linear && available.linear, '/auth/linear/link'],
    ] as const
  )
    .filter(([, offered]) => offered)
    .map(
      ([label, , action]) =>
        `<form method="post" action="${action}" style="display:inline;margin:0"><button class="small">Connect ${label}</button></form>`
    )
    .join(' ');
  return `<div class="row"><span class="muted">Signed in with ${using.join(' · ')}</span><span>${add}</span></div>`;
}

export function homePage(input: {
  user: User;
  teams: (Team & { role: string })[];
  planner?: PlannerLinks;
  machines?: MachineRow[];
  identities: { github: boolean; linear: boolean };
  available: { github: boolean; linear: boolean };
  /** Teams linked to a Linear workspace this person is in, not yet joined. */
  joinable?: { id: string; name: string; org: string }[];
}): string {
  const { user, teams, identities, available } = input;
  const joinable = (input.joinable ?? [])
    .map(
      (t) =>
        `<div class="row"><span><span class="ink">${esc(t.name)}</span> <span class="muted">linked to your Linear workspace ${esc(t.org)}</span></span><form method="post" action="/teams/${esc(t.id)}/join" style="margin:0"><button class="small primary">Join</button></form></div>`
    )
    .join('');
  const planner = input.planner ?? { workspaces: [], canOpen: false };
  const list =
    teams.length === 0
      ? ''
      : `<div class="box">${teams
          .map(
            (t) =>
              `<div class="row"><a href="/teams/${esc(t.id)}">${esc(t.name)}</a><span class="meta">Team · ${esc(t.role)}</span></div>`
          )
          .join('')}</div>`;
  return page(
    'Home',
    user,
    `<h1>Dispatch</h1>
<p class="lede">Plan your Linear workspaces, reach your own machines, and run your team's agents.</p>
${plannerBox(planner)}
<div class="label" id="machines">Your machines</div>${machinesBox(input.machines ?? [])}
<div class="label">Teams</div>${joinable === '' ? '' : `<div class="box">${joinable}</div>`}${list}
<div class="box pad"><form method="post" action="/teams" class="inline"><input name="name" required maxlength="80" placeholder="New team name"><button class="primary">Create</button></form></div>
<div class="label">Account</div><div class="box">${signInLine(identities, available)}</div>`
  );
}

export interface LiveSession {
  address: string;
  client: string;
  label?: string;
  repo?: string;
  online: boolean;
}

export function teamPage(input: {
  user: User;
  team: Team;
  role: 'admin' | 'member';
  members: Member[];
  devices: (Device & { login: string })[];
  sessions: LiveSession[];
  invite: string | null;
  /** Invites not yet used (admins only). */
  openInvites?: { email: string | null; expiresAt: string }[];
  mail?: { available: boolean; sent: string | null; error: string | null };
  origin: string;
  linear: {
    available: boolean;
    status: { org: string; connectedAt: string; webhook: boolean } | null;
    error: string | null;
  };
}): string {
  const {
    user,
    team,
    role,
    members,
    devices,
    sessions,
    invite,
    origin,
    linear,
  } = input;
  const mail = input.mail ?? { available: false, sent: null, error: null };
  const openInvites = input.openInvites ?? [];
  const mine = devices.filter((d) => d.userId === user.id);
  const inviteLink = invite === null ? null : `${origin}/join/${invite}`;
  const inviteForm = `<form method="post" action="/teams/${esc(team.id)}/invites" class="inline"><input name="email" type="email" maxlength="254" placeholder="${mail.available ? 'teammate@example.com (or leave empty for a link)' : 'teammate@example.com (optional)'}" autocomplete="off"><button>${mail.available ? 'Invite' : 'New invite link'}</button></form>`;
  const inviteResult =
    inviteLink === null
      ? ''
      : `${
          mail.sent === null
            ? ''
            : `<p class="ok">Sent to ${esc(mail.sent)}.</p>`
        }${mail.error === null ? '' : `<div class="note">${esc(mail.error)}</div>`}
<p>The link, to join from a browser:</p>${cmd(inviteLink)}
<p style="margin-top:12px">Or one command that joins and connects their agents:</p>${cmd(`npx -y @dispatch-foo/mcp join ${inviteLink}`)}`;
  const live = sessions.filter((s) => s.online).length;

  const steps = `<div class="box">
<div class="step"><div class="n">1</div><div><h3>On each machine, run one command</h3>
<p>It connects Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop and Windsurf, sets up wake-ups for idle Claude Code sessions, and signs the machine in to ${esc(team.name)} in your browser. Restart open agent sessions afterwards.</p>${cmd('npx -y @dispatch-foo/mcp setup')}</div></div>
<div class="step"><div class="n">2</div><div><h3>Claude on the web or phone</h3>
<p>In Claude, open Settings → Connectors → Add custom connector, and use this URL. Sign in and pick ${esc(team.name)}.</p>${cmd(`${origin}/mcp`)}</div></div>
<div class="step"><div class="n">3</div><div><h3>Bring your team</h3>
${
  role === 'admin'
    ? '<p>Invite them under People below. They run one command that joins the team and connects their agents.</p>'
    : '<p>Ask an admin of this team for an invite link.</p>'
}</div></div></div>`;
  // Once a machine of yours is signed in, the setup steps fold away.
  const connect =
    mine.length > 0
      ? `<details class="fold"><summary><div class="label">Connect your agents <span class="ok">· this account has a machine signed in</span></div></summary>${steps}</details>`
      : `<div class="label">Connect your agents</div>${steps}`;

  const sessionRows =
    sessions.length === 0
      ? '<div class="box pad"><p class="muted">No agent sessions yet. They appear here as soon as an agent on a signed-in machine uses Dispatch.</p></div>'
      : `<div class="box">${sessions
          .map(
            (s) =>
              `<div class="row"><span><span class="dot${s.online ? ' on' : ''}"></span><code>${esc(s.address)}</code></span><span class="meta">${esc(
                [s.label, s.repo, s.client]
                  .filter((v): v is string => v !== undefined && v !== '')
                  .join(' · ')
              )}</span></div>`
          )
          .join('')}</div>`;

  const linearBody =
    linear.status !== null
      ? `<div class="row"><span class="ink">Connected to ${esc(linear.status.org)}</span>${
          role === 'admin'
            ? `<form method="post" action="/teams/${esc(team.id)}/linear/disconnect"><button class="small">Disconnect</button></form>`
            : ''
        }</div><div class="pad"><p class="muted">Every agent on the team can search, read, comment on and move issues (<code>linear_search</code>, <code>linear_issue</code>, <code>linear_comment</code>, <code>linear_state</code>), and <code>linear_watch</code> one to hear when it changes.${
          linear.status.webhook
            ? ''
            : ' Issue notices need a workspace admin’s key: reconnect with one to turn them on.'
        }</p></div>`
      : role !== 'admin'
        ? '<div class="pad"><p class="muted">Not connected yet. A team admin connects Linear here, once, for everyone.</p></div>'
        : !linear.available
          ? '<div class="pad"><p class="muted">This server is not set up to hold Linear keys.</p></div>'
          : `<div class="pad"><p>A team API key: connect it once and every agent on ${esc(team.name)} can work your Linear issues, with no key on anyone’s machine. It is separate from the Linear workspaces you plan in on <a href="/">Home</a>.</p>
<form method="post" action="/teams/${esc(team.id)}/linear" class="inline"><input name="key" type="password" required placeholder="lin_api_…" autocomplete="off"><button class="primary">Connect</button></form>
<p class="muted" style="margin-top:12px">Make a key in Linear under Settings → Security &amp; access → Personal API keys. It is stored encrypted and never shown again. A workspace admin’s key also tells agents when the issues they watch change.</p></div>`;

  // Each person's way to working agents: joined, a machine signed in, an
  // agent seen. What is missing says how to fix it.
  const check = (done: boolean, text: string) =>
    `<span class="${done ? 'ok' : 'muted'}">${done ? '✓' : '○'} ${esc(text)}</span>`;
  const memberRows = members
    .map((m) => {
      const machines = devices.filter((d) => d.userId === m.user.id);
      const agents = sessions.filter((s) =>
        s.address.startsWith(`agent:${m.user.login}/`)
      );
      const next =
        machines.length === 0
          ? m.user.id === user.id
            ? 'Next: run npx -y @dispatch-foo/mcp setup on your machine.'
            : 'Next: they run npx -y @dispatch-foo/mcp setup on their machine.'
          : agents.length === 0
            ? 'Next: restart Claude Code (or another agent client) on that machine, then use it once.'
            : '';
      return `<div class="row" style="flex-wrap:wrap"><span class="ink">${esc(m.user.login)}${m.user.name === null ? '' : ` <span class="muted">${esc(m.user.name)}</span>`}
<br><span style="font:400 .78rem/1.6 var(--mono)">${check(true, 'joined')} · ${check(
        machines.length > 0,
        machines.length > 1
          ? `${machines.length} machines signed in`
          : 'machine signed in'
      )} · ${check(
        agents.length > 0,
        agents.length > 0
          ? `${agents.length} agent${agents.length === 1 ? '' : 's'} connected`
          : 'agent connected'
      )}</span>${next === '' ? '' : `<br><span class="muted" style="font-size:.8rem">${esc(next)}</span>`}</span>
<span class="meta">${esc(m.role)}${
        role === 'admin' && m.user.id !== user.id
          ? ` <form method="post" action="/teams/${esc(team.id)}/members/${esc(m.user.id)}/remove" style="display:inline"><button class="small">Remove</button></form>`
          : ''
      }</span></div>`;
    })
    .join('');
  const inviteRows = openInvites
    .map(
      (i) =>
        `<div class="row"><span><span class="muted">${i.email === null ? 'Invite link' : esc(i.email)}</span><br><span style="font:400 .78rem/1.6 var(--mono)">${check(false, 'not joined yet')}</span></span><span class="meta">expires ${esc(i.expiresAt.slice(0, 10))}</span></div>`
    )
    .join('');
  // Admins invite here, where the result stays in view (the setup steps
  // fold away once their own machine is signed in).
  const invitePanel =
    role !== 'admin'
      ? ''
      : `<div class="pad" style="border-top:1px solid var(--line)"><p class="muted">Each invite works once, for 7 days.${mail.available ? ' Enter an email and Dispatch sends it.' : ''}</p>${
          inviteLink === null && mail.error !== null
            ? `<div class="note" style="margin-bottom:12px">${esc(mail.error)}</div>`
            : ''
        }${inviteForm}${inviteResult === '' ? '' : `<div style="margin-top:12px">${inviteResult}</div>`}</div>`;

  const deviceRows = devices
    .map(
      (
        d
      ) => `<div class="row"><span><span class="ink">${esc(d.login)}</span> <span class="muted">${esc(d.client)}</span></span>
<span class="meta">${d.lastSeen === null ? 'never connected' : `seen ${esc(d.lastSeen.slice(0, 16).replace('T', ' '))} UTC`}${
        role === 'admin' || d.userId === user.id
          ? ` <form method="post" action="/teams/${esc(team.id)}/devices/${esc(d.id)}/revoke" style="display:inline"><button class="small">Sign out</button></form>`
          : ''
      }</span></div>`
    )
    .join('');

  return page(
    team.name,
    user,
    `<h1>${esc(team.name)}</h1>
<p class="lede">${members.length} ${members.length === 1 ? 'person' : 'people'} · ${live} agent ${live === 1 ? 'session' : 'sessions'} live${
      linear.status === null ? '' : ` · Linear: ${esc(linear.status.org)}`
    }</p>
${connect}
<div class="label">Agent sessions</div>${sessionRows}
<div class="label">Linear API key for agents</div><div class="box">${linear.error === null ? '' : `<div class="pad"><div class="err">${esc(linear.error)}</div></div>`}${linearBody}</div>
<div class="label">People</div><div class="box">${memberRows}${inviteRows}${invitePanel}</div>
<div class="label">Signed-in machines</div><div class="box">${deviceRows === '' ? '<div class="pad"><p class="muted">None yet: run the setup command above.</p></div>' : deviceRows}</div>`
  );
}

export function joinPage(user: User, team: Team, token: string): string {
  return page(
    `Join ${team.name}`,
    user,
    `<h1>Join ${esc(team.name)}.</h1>
<p class="lede">Your agents will be able to reach your teammates’ agents, and theirs yours.</p>
<form method="post" action="/join/${esc(token)}"><button class="primary">Join ${esc(team.name)}</button></form>`
  );
}

export function devicePage(
  user: User,
  teams: Team[],
  code: string,
  client: string | null,
  error: string | null,
  /** The team the sign-in's invite lets this person join, if any. */
  invite: Team | null = null
): string {
  // An invite's team comes first (and is picked), joined on approval.
  const joining =
    invite !== null && !teams.some((t) => t.id === invite.id) ? invite : null;
  const options =
    invite === null
      ? teams
      : [invite, ...teams.filter((t) => t.id !== invite.id)];
  const body =
    client === null
      ? `<p class="lede">Enter the code your terminal or agent shows.</p>
<form method="get" action="/device" class="inline"><input name="code" value="${esc(code)}" placeholder="ABCD-EFGH" autofocus autocomplete="off"><button class="primary">Continue</button></form>`
      : options.length === 0
        ? `<p class="lede">You are not in a team yet. <a href="/">Make one</a>, or open an invite link, then run the command again.</p>`
        : `<p class="lede"><span class="ink">${esc(client)}</span> is asking to join your team. Check the code matches the one it shows.</p>
<p><span class="code">${esc(code)}</span></p>
<form method="post" action="/device"><input type="hidden" name="code" value="${esc(code)}">
${
  options.length === 1
    ? `<input type="hidden" name="team" value="${esc(options[0]?.id ?? '')}"><p>${joining === null ? 'Signs in to' : 'Joins you to, and signs this machine in to,'} <span class="ink">${esc(options[0]?.name ?? '')}</span>.</p>`
    : `<p><select name="team">${options.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></p>`
}
<p style="display:flex;gap:8px"><button class="primary" name="decision" value="approve">${joining === null ? 'Sign in' : `Join ${esc(joining.name)} and sign in`}</button><button name="decision" value="deny">Deny</button></p></form>
<p class="muted">Only approve a code you just started yourself.</p>`;
  return page(
    'Sign in an agent',
    user,
    `<h1>Sign in your agents.</h1>${error === null ? '' : `<div class="err">${esc(error)}</div>`}${body}`
  );
}

export function messagePage(
  user: User | null,
  title: string,
  text: string
): string {
  return page(
    title,
    user,
    `<h1>${esc(title)}</h1><p class="lede">${esc(text)}</p><p><a class="btn" href="/">Back</a></p>`
  );
}

/** After a device sign-in: done, nothing else to do here. */
export function signedInPage(user: User, team: string): string {
  return page(
    'Signed in',
    user,
    `<h1>You’re in.</h1><p class="lede">This machine’s agents are on <span class="ink">${esc(team)}</span> now. You can close this tab and go back to your terminal or agent.</p>`
  );
}

// Hosts whose apps are what they claim; any other host gets a warning, since
// an app's name is whatever it registered with.
const KNOWN_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'];

export function consentPage(input: {
  user: User;
  client: string;
  redirectHost: string;
  teams: Team[];
  hidden: Record<string, string>;
}): string {
  const { user, client, redirectHost, teams, hidden } = input;
  const known = KNOWN_HOSTS.some(
    (h) =>
      redirectHost === h ||
      redirectHost.endsWith(`.${h}`) ||
      redirectHost.startsWith(`${h}:`)
  );
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return page(
    'Connect an agent',
    user,
    teams.length === 0
      ? `<h1>Connect ${esc(client)}</h1><p class="lede">You are not in a team yet. <a href="/">Make one</a> first.</p>`
      : `<h1>Connect ${esc(client)} to Dispatch?</h1>
<p class="lede">It will see your team’s agent sessions and send and read messages as you.</p>
<p>It sends you back to <span class="ink">${esc(redirectHost)}</span>.</p>
${known ? '' : '<div class="note">That is not claude.ai: the name above is only what the app calls itself. Allow it only if you started this connection from that site.</div>'}
<form method="post" action="/oauth/authorize" style="margin-top:16px">${fields}
${
  teams.length === 1
    ? `<input type="hidden" name="team" value="${esc(teams[0]?.id ?? '')}">`
    : `<p><select name="team">${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></p>`
}
<p style="display:flex;gap:8px"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></p></form>`
  );
}
