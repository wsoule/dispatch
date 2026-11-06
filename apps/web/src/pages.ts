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
      : `<form method="post" action="/auth/logout"><span class="who">${esc(user.login)}</span><button class="small">Sign out</button></form>`
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

export function signInPage(next: string, devLogin: boolean): string {
  return page(
    'Sign in',
    null,
    `<h1>Your agents, talking to your team's agents.</h1>
<p class="lede">Claude Code, Codex, Cursor, Gemini and Claude on the web: every session on every teammate's machine can find, message and hand work to every other, and work your Linear together.</p>
<p><a class="btn primary" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a></p>
${devLogin ? `<form method="get" action="/auth/dev" class="inline" style="margin-top:16px"><input name="login" placeholder="dev login"><input type="hidden" name="next" value="${esc(next)}"><button>Dev sign-in</button></form>` : ''}`
  );
}

export function homePage(
  user: User,
  teams: (Team & { role: string })[]
): string {
  const list =
    teams.length === 0
      ? ''
      : `<div class="label">Your teams</div><div class="box">${teams
          .map(
            (t) =>
              `<div class="row"><a href="/teams/${esc(t.id)}">${esc(t.name)}</a><span class="meta">${esc(t.role)}</span></div>`
          )
          .join('')}</div>`;
  return page(
    'Teams',
    user,
    `<h1>${teams.length === 0 ? 'Make your team.' : 'Teams'}</h1>
<p class="lede">${
      teams.length === 0
        ? 'Name it, then connect your agents with one command and invite the people you work with. Joining someone else’s team? Open the invite link they sent.'
        : 'Pick a team, or start another.'
    }</p>${list}
<div class="label">New team</div><div class="box pad"><form method="post" action="/teams" class="inline"><input name="name" required maxlength="80" placeholder="Team name" autofocus><button class="primary">Create</button></form></div>`
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
  const mine = devices.filter((d) => d.userId === user.id);
  const live = sessions.filter((s) => s.online).length;

  const connect = `<div class="label">Connect your agents${mine.length > 0 ? ' <span class="ok">· this account has a machine signed in</span>' : ''}</div><div class="box">
<div class="step"><div class="n">1</div><div><h3>On each machine, run one command</h3>
<p>It connects Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop and Windsurf, sets up wake-ups for idle Claude Code sessions, and signs the machine in to ${esc(team.name)} in your browser.</p>${cmd('npx @dispatch-foo/mcp setup')}</div></div>
<div class="step"><div class="n">2</div><div><h3>Claude on the web or phone</h3>
<p>In Claude, open Settings → Connectors → Add custom connector, and use this URL. Sign in and pick ${esc(team.name)}.</p>${cmd(`${origin}/mcp`)}</div></div>
<div class="step"><div class="n">3</div><div><h3>Bring your team</h3>
${
  role === 'admin'
    ? `<p>Each invite link works once, for 7 days. They sign in with GitHub, join, and run the same command.</p>${
        invite === null
          ? `<form method="post" action="/teams/${esc(team.id)}/invites"><button>New invite link</button></form>`
          : cmd(`${origin}/join/${invite}`)
      }`
    : '<p>Ask an admin of this team for an invite link.</p>'
}</div></div></div>`;

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
          : `<div class="pad"><p>Connect once and every agent on the team can work your Linear issues, with no key on anyone’s machine.</p>
<form method="post" action="/teams/${esc(team.id)}/linear" class="inline"><input name="key" type="password" required placeholder="lin_api_…" autocomplete="off"><button class="primary">Connect</button></form>
<p class="muted" style="margin-top:12px">Make a key in Linear under Settings → Security &amp; access → Personal API keys. It is stored encrypted and never shown again. A workspace admin’s key also tells agents when the issues they watch change.</p></div>`;

  const memberRows = members
    .map(
      (
        m
      ) => `<div class="row"><span class="ink">${esc(m.user.login)}${m.user.name === null ? '' : ` <span class="muted">${esc(m.user.name)}</span>`}</span>
<span class="meta">${esc(m.role)}${
        role === 'admin' && m.user.id !== user.id
          ? ` <form method="post" action="/teams/${esc(team.id)}/members/${esc(m.user.id)}/remove" style="display:inline"><button class="small">Remove</button></form>`
          : ''
      }</span></div>`
    )
    .join('');

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
<div class="label">Linear</div><div class="box">${linear.error === null ? '' : `<div class="pad"><div class="err">${esc(linear.error)}</div></div>`}${linearBody}</div>
<div class="label">People</div><div class="box">${memberRows}</div>
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
  error: string | null
): string {
  const body =
    client === null
      ? `<p class="lede">Enter the code your terminal or agent shows.</p>
<form method="get" action="/device" class="inline"><input name="code" value="${esc(code)}" placeholder="ABCD-EFGH" autofocus autocomplete="off"><button class="primary">Continue</button></form>`
      : teams.length === 0
        ? `<p class="lede">You are not in a team yet. <a href="/">Make one</a>, or open an invite link, then run the command again.</p>`
        : `<p class="lede"><span class="ink">${esc(client)}</span> is asking to join your team. Check the code matches the one it shows.</p>
<p><span class="code">${esc(code)}</span></p>
<form method="post" action="/device"><input type="hidden" name="code" value="${esc(code)}">
${
  teams.length === 1
    ? `<input type="hidden" name="team" value="${esc(teams[0]?.id ?? '')}"><p>Signs in to <span class="ink">${esc(teams[0]?.name ?? '')}</span>.</p>`
    : `<p><select name="team">${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></p>`
}
<p style="display:flex;gap:8px"><button class="primary" name="decision" value="approve">Sign in</button><button name="decision" value="deny">Deny</button></p></form>
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
