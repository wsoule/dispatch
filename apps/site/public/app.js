/**
 * A running copy of Dispatch, in one file, in memory.
 *
 * The capture split, the kind inference and the clustering are ported verbatim
 * from the product (packages/server/src/inbox.ts and
 * apps/desktop/src/lib/inboxCluster.ts). Retyping the rules would have been
 * quicker and would have made this a puppet show: a demo is only worth having
 * while poking it tells you something true, and that holds only while it runs
 * the same rules the app runs.
 *
 * Every view reads one state object, so the screens agree with each other —
 * dispatching on the board changes Overview, approving in Review moves the
 * task into Landing.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  if (!view) return;

  // ── the app's rules, ported ─────────────────────────────────────────────
  const STOPWORDS = new Set(
    (
      'the a an and or but to of in on at for with is are was be been it its ' +
      'this that when should would could need needs want make add fix from ' +
      'into per not no if then than so do does task tasks agent agents run ' +
      'runs dispatch'
    ).split(' ')
  );

  const splitCapture = (raw) =>
    raw
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
      .filter((l) => l.length > 0);

  // Order matters: bug-ish words win over task-ish ones, because "fix the
  // broken thing" is a bug report that happens to contain an imperative.
  function inferKind(text) {
    if (
      /\b(bug|broken|blank|crash|fail|regress|wrong|leak|eating|stuck|hang)/i.test(
        text
      )
    )
      return 'bug';
    if (
      /\b(need|should|add|wire|build|make|implement|support|move|rename)/i.test(
        text
      )
    )
      return 'task';
    if (/\b(idea|maybe|what if|consider|could|might|explore)/i.test(text))
      return 'idea';
    return 'note';
  }

  // Crude singularisation matters more than it looks: "worktrees are eating
  // disk" and "prune the worktree" must land in the same bucket.
  const terms = (text) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
        .map((w) => (w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    );

  const MIN_CLUSTER = 3;

  function findCluster(list) {
    const open = list.filter((i) => !i.done);
    if (open.length < MIN_CLUSTER) return null;
    const byTerm = new Map();
    for (const item of open)
      for (const t of terms(item.text))
        byTerm.has(t) ? byTerm.get(t).push(item.id) : byTerm.set(t, [item.id]);
    let best = null;
    for (const [term, ids] of byTerm) {
      if (ids.length < MIN_CLUSTER) continue;
      if (best === null || ids.length > best.ids.length) best = { term, ids };
    }
    if (best === null) return null;
    const members = new Set(best.ids);
    const theme = [...byTerm.entries()]
      .filter(
        ([, ids]) =>
          ids.length >= members.size && ids.every((id) => members.has(id))
      )
      .map(([t]) => t)
      .sort();
    return { ids: best.ids, theme: theme.length > 0 ? theme : [best.term] };
  }

  const describeCluster = (c) =>
    `${c.ids.length} items here are all about ${c.theme.slice(0, 3).join(', ')}. ` +
    `They would make a better epic than ${c.ids.length} loose tasks.`;

  // ── state ───────────────────────────────────────────────────────────────
  const STATUSES = ['todo', 'in-progress', 'in-review', 'done'];
  const VERIFY = ['typecheck', 'test', 'lint'];
  // orchestrator.epicConcurrency in .dispatch/config.yml. Working an epic
  // starts this many at once and holds the rest; without the cap a twelve-task
  // epic opens twelve worktrees.
  const CONCURRENCY = 3;

  const hex = (n) =>
    Array.from(
      { length: n },
      () => '0123456789abcdef'[(Math.random() * 16) | 0]
    ).join('');

  let state;
  let timers = [];
  const after = (ms, fn) => timers.push(setTimeout(fn, ms));

  function seed() {
    timers.forEach(clearTimeout);
    timers = [];
    state = {
      tab: 'overview',
      selected: new Set(),
      pumping: false,
      composeLine: null,
      reviewOn: 't-77b3e1',
      runOn: 't-9f2a41',
      inbox: [
        {
          id: 'in-1',
          kind: 'bug',
          text: 'worktree cleanup leaves the branch behind on cancel',
          by: 'r-b1d725',
          done: false,
        },
        {
          id: 'in-2',
          kind: 'idea',
          text: 'reuse a worktree across runs on the same task',
          done: false,
        },
        {
          id: 'in-3',
          kind: 'bug',
          text: 'merge queue retries forever if verify times out',
          done: false,
        },
        {
          id: 'in-4',
          kind: 'note',
          text: 'worktree disk usage is not reported anywhere',
          done: false,
        },
        {
          id: 'in-5',
          kind: 'task',
          text: 'write the release notes for 0.9.1',
          done: false,
        },
      ],
      epics: [
        { id: 'e-9021cd', title: 'Streaming output' },
        { id: 'e-3f77b0', title: 'Merge queue observability' },
      ],
      tasks: [
        {
          id: 't-4d10ae',
          title: 'Bound the buffer when the client is slow',
          epic: 'e-9021cd',
          status: 'todo',
          blockedBy: ['t-9f2a41'],
        },
        {
          id: 't-9f2a41',
          title: 'Stream agent stdout over the websocket',
          epic: 'e-9021cd',
          status: 'in-progress',
          run: 'r-b1d725',
          live: true,
        },
        {
          id: 't-77b3e1',
          title: 'Reconnect without replaying the log',
          epic: 'e-9021cd',
          status: 'in-review',
          run: 'r-a4c882',
          note: '2 comments',
        },
        {
          id: 't-c8954b',
          title: 'Add a websocket route to the daemon',
          epic: 'e-9021cd',
          status: 'done',
          run: 'r-71ff03',
          note: 'merged',
        },
        {
          id: 't-2b91cc',
          title: 'Name each verify step in the queue log',
          epic: 'e-3f77b0',
          status: 'todo',
        },
        {
          id: 't-6a1e42',
          title: 'Surface queue depth in the overview',
          epic: 'e-3f77b0',
          status: 'todo',
        },
        {
          id: 't-88c07d',
          title: 'Show elapsed time per entry',
          epic: 'e-3f77b0',
          status: 'todo',
        },
        {
          id: 't-3c50b9',
          title: 'Log the rebase target',
          epic: 'e-3f77b0',
          status: 'todo',
        },
        {
          id: 't-518dd4',
          title: 'Record per-step duration',
          epic: 'e-3f77b0',
          status: 'in-review',
          run: 'r-4e01af',
        },
      ],
      queue: [],
      comments: [
        {
          id: 'rc-1',
          line: 41,
          author: 'You',
          body: 'This drops frames if the socket is slow. Bound it.',
        },
      ],
    };
  }

  const esc = (t) =>
    String(t).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  const task = (id) => state.tasks.find((t) => t.id === id);
  // A task is ready when nothing it declares as a blocker is still open.
  const blockers = (t) =>
    (t.blockedBy || []).filter((id) => {
      const b = task(id);
      return b && b.status !== 'done';
    });
  const running = () => state.tasks.filter((t) => t.live).length;
  const inQueue = (id) => state.queue.some((q) => q.taskId === id);

  /** What the Overview groups by. Mirrors the app's FeedState. */
  function feedState(t) {
    if (t.live) return 'working';
    if (inQueue(t.id)) return 'landing';
    if (t.status === 'in-review') return 'review';
    if (t.status === 'done') return 'done';
    if (blockers(t).length) return 'blocked';
    return 'ready';
  }
  const FEED_LABEL = {
    review: 'Needs review',
    working: 'Working',
    landing: 'Landing',
    blocked: 'Blocked',
    ready: 'Ready',
    done: 'Done',
  };
  // Fixed order: what needs a human comes first, and it must not reshuffle as
  // counts change or rows would move under the cursor mid-click.
  const FEED_ORDER = [
    'review',
    'working',
    'landing',
    'blocked',
    'ready',
    'done',
  ];

  // ── navigation ──────────────────────────────────────────────────────────
  const TABS = [
    { id: 'overview', label: 'Overview', say: 'Everything that needs you.' },
    { id: 'brain', label: 'Brain dump', say: 'Capture without committing.' },
    { id: 'tasks', label: 'Tasks', say: 'One lane per epic.' },
    { id: 'plans', label: 'Plans', say: 'Say it; it writes the tasks.' },
    { id: 'runs', label: 'Runs', say: 'What the agent actually did.' },
    { id: 'review', label: 'Review', say: 'Comment, then decide.' },
    { id: 'landing', label: 'Landing', say: 'The merge queue.' },
  ];

  function counts(id) {
    if (id === 'brain')
      return [state.inbox.filter((i) => !i.done).length, false];
    if (id === 'tasks') return [state.tasks.length, false];
    if (id === 'runs') return [running(), running() > 0];
    if (id === 'review')
      return [
        state.tasks.filter((t) => t.status === 'in-review' && !inQueue(t.id))
          .length,
        state.tasks.some((t) => t.status === 'in-review' && !inQueue(t.id)),
      ];
    if (id === 'landing') return [state.queue.length, state.queue.length > 0];
    return [null, false];
  }

  function renderNav() {
    $('nav').innerHTML = TABS.map((t) => {
      const [n, hot] = counts(t.id);
      return `<button type="button" data-tab="${t.id}" aria-current="${state.tab === t.id}">
        ${t.label}${n === null || n === 0 ? '' : `<span class="n${hot ? ' hot' : ''}">${n}</span>`}
      </button>`;
    }).join('');
    const tab = TABS.find((t) => t.id === state.tab);
    $('vtitle').textContent = tab.label;
    $('vsay').textContent = tab.say;
  }

  function go(tab) {
    state.tab = tab;
    render();
  }

  function render() {
    renderNav();
    const fn = {
      overview: viewOverview,
      brain: viewBrain,
      tasks: viewTasks,
      plans: viewPlans,
      runs: viewRuns,
      review: viewReview,
      landing: viewLanding,
    }[state.tab];
    view.innerHTML = fn();
    if (state.tab === 'brain') bindBrain();
    if (state.tab === 'plans') bindPlans();
  }

  // ── overview ────────────────────────────────────────────────────────────
  function viewOverview() {
    const groups = new Map();
    for (const t of state.tasks) {
      const s = feedState(t);
      groups.has(s) ? groups.get(s).push(t) : groups.set(s, [t]);
    }
    const out = [];
    for (const s of FEED_ORDER) {
      const list = groups.get(s);
      if (!list) continue;
      out.push(
        `<div class="lbl">${FEED_LABEL[s]} <span class="ct">${list.length}</span><i class="tail"></i></div>` +
          list
            .map(
              (t) => `<button class="feed" type="button" data-open="${t.id}">
          <span class="st ${s}"><span class="dot ${s === 'working' ? 'live' : s === 'review' || s === 'done' ? 'ok' : s === 'blocked' ? 'warn' : 'idle'}"></span>${FEED_LABEL[s]}</span>
          <span>${esc(t.title)}</span>
          <span class="rid">${t.run ? esc(t.run) : t.id}</span>
        </button>`
            )
            .join('')
      );
    }
    return out.join('');
  }

  // ── brain dump ──────────────────────────────────────────────────────────
  function viewBrain() {
    const open = state.inbox.filter((i) => !i.done);
    const gone = state.inbox.filter((i) => i.done);
    const c = findCluster(state.inbox);
    const n = state.selected.size;
    return `<div class="dump"><div>
      <div class="capture">
        <label class="sr" for="draft">Capture</label>
        <textarea id="draft" placeholder="Dump it here — bugs, half-ideas, things you noticed, one per line…"></textarea>
        <div class="capture-bar">
          <span class="hint" id="hint">One thought per line.</span>
          <button class="btn solid" id="drop" type="button" disabled>Drop into the inbox</button>
        </div>
      </div>
      ${
        n
          ? `<div class="selbar"><span class="n">${n} selected</span>
        <button class="btn quiet" type="button" data-act="tasks">Make tasks</button>
        <button class="btn quiet" type="button" data-act="epic">Group into an epic</button>
        <button class="btn quiet" type="button" data-act="dismiss">Dismiss</button>
        <button class="btn quiet" type="button" data-act="clear">Clear</button></div>`
          : ''
      }
      <div class="lbl">Inbox <span class="ct">${open.length}</span><i class="tail"></i></div>
      ${
        open.length === 0
          ? '<p class="empty">Nothing captured. Type above — it costs nothing.</p>'
          : open
              .map(
                (
                  i
                ) => `<label class="item${state.selected.has(i.id) ? ' sel' : ''}">
          <input type="checkbox" data-pick="${i.id}"${state.selected.has(i.id) ? ' checked' : ''} aria-label="Select ${esc(i.text)}">
          <span class="kind is-${i.kind}">${i.kind}</span>
          <span>${esc(i.text)}</span>
          <span class="by">${i.by ? esc(i.by) : ''}</span></label>`
              )
              .join('')
      }
      ${
        gone.length
          ? `<div class="lbl">Sorted <span class="ct">${gone.length}</span><i class="tail"></i></div>` +
            gone
              .map(
                (
                  i
                ) => `<div class="item gone"><span></span><span class="kind is-${i.kind}">${i.kind}</span>
            <span>${esc(i.text)}</span><span class="link">${i.taskId ? '→ ' + i.taskId : 'dismissed'}</span></div>`
              )
              .join('')
          : ''
      }
    </div><aside>${
      c
        ? `<div class="card"><div class="t">These look like one thing</div>
        <p>${esc(describeCluster(c))}</p>
        <button class="btn solid" type="button" data-act="pickall" style="margin-top:9px">Select them</button></div>`
        : ''
    }</aside></div>`;
  }

  function bindBrain() {
    const draft = $('draft');
    const hint = () => {
      const n = splitCapture(draft.value).length;
      $('hint').textContent = n
        ? `${n} ${n === 1 ? 'line' : 'lines'} — each becomes one item`
        : 'One thought per line.';
      $('drop').disabled = n === 0;
    };
    draft.addEventListener('input', hint);
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        capture(draft.value);
      }
    });
    $('drop').onclick = () => capture(draft.value);
  }

  function capture(text) {
    const lines = splitCapture(text);
    if (!lines.length) return;
    for (const t of lines.reverse())
      state.inbox.unshift({
        id: 'in-' + hex(4),
        kind: inferKind(t),
        text: t,
        done: false,
      });
    render();
  }

  /** Captures become tasks; with an epic, the lane is named from the theme. */
  function convert(asEpic) {
    const picked = state.inbox.filter(
      (i) => state.selected.has(i.id) && !i.done
    );
    if (!picked.length) return;
    let epicId = null;
    if (asEpic) {
      const c = findCluster(picked.map((i) => ({ ...i, done: false })));
      const word = c ? c.theme[0] : picked[0].text.split(' ')[0];
      epicId = 'e-' + hex(6);
      state.epics.push({
        id: epicId,
        title: word[0].toUpperCase() + word.slice(1),
      });
    }
    for (const i of picked) {
      const id = 't-' + hex(6);
      i.done = true;
      i.taskId = id;
      state.tasks.push({ id, title: i.text, epic: epicId, status: 'todo' });
    }
    state.selected.clear();
    go('tasks');
  }

  // ── tasks ───────────────────────────────────────────────────────────────
  const LAYERS =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--indigo)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/></svg>';

  function lanes() {
    const out = [];
    for (const e of state.epics) {
      const ts = state.tasks.filter((t) => t.epic === e.id);
      if (ts.length) out.push({ title: e.title, tasks: ts });
    }
    const none = state.tasks.filter((t) => !t.epic);
    if (none.length) out.push({ title: 'No epic', tasks: none });
    return out;
  }

  function tile(t) {
    const bl = blockers(t);
    const foot = t.live
      ? `<span class="dot live"></span>${esc(t.run)}`
      : t.waiting
        ? '<span class="dot idle"></span><span class="warnt">waiting for a slot</span>'
        : bl.length
          ? `<span class="dot idle"></span><span class="warnt">blocked · ${esc(bl[0])}</span>`
          : t.status === 'todo'
            ? '<span class="dot idle"></span>ready'
            : `<span class="dot ok"></span>${esc(t.note || t.run || '')}`;
    const act =
      t.status === 'todo' && !bl.length && !t.waiting
        ? `<button class="act" type="button" data-go="${t.id}">Dispatch</button>`
        : t.status === 'in-review' && !inQueue(t.id)
          ? `<button class="act go" type="button" data-review="${t.id}">Review</button>`
          : '';
    return `<div class="tile" draggable="true" tabindex="0" data-id="${t.id}"
      aria-label="${esc(t.title)}, ${t.status}. Arrow keys move it between columns.">
      <div class="tid">${t.id}</div><div class="tt">${esc(t.title)}</div>
      <div class="tf">${foot}</div>${act}</div>`;
  }

  function viewTasks() {
    return lanes()
      .map(
        (
          lane
        ) => `<div class="lane"><div class="lane-head">${LAYERS}${esc(lane.title)}
        <span class="ct">${lane.tasks.length}</span><i class="tail"></i>
        ${
          lane.tasks.some(
            (t) => t.status === 'todo' && !blockers(t).length && !t.waiting
          )
            ? `<button class="lanego" type="button" data-epic="${esc(lane.title)}">Work this epic</button>`
            : ''
        }</div>
      <div class="cols">${STATUSES.map((st) => {
        const ts = lane.tasks.filter((t) => t.status === st);
        const skin =
          st === 'in-progress' ? ' doing' : st === 'in-review' ? ' review' : '';
        return `<div class="col"><div class="col-head${skin}"><i class="sq"></i>${st}
            <span class="ct">${ts.length}</span></div>
            <div class="drop" data-col="${st}">${ts.map(tile).join('')}</div></div>`;
      }).join('')}</div></div>`
      )
      .join('');
  }

  // ── plans ───────────────────────────────────────────────────────────────
  function viewPlans() {
    return `<div class="capture">
      <label class="sr" for="planq">What do you want</label>
      <textarea id="planq" placeholder="Describe what you want. One line per piece, or a paragraph…"></textarea>
      <div class="capture-bar">
        <span class="hint">Creates an epic and dispatches what is ready.</span>
        <button class="btn solid" id="planit" type="button" disabled>Plan it</button>
      </div>
    </div>
    <p class="empty" style="margin-top:14px;max-width:60ch">
      In the app this is a model call that turns a paragraph into specified
      tasks with acceptance criteria. Here it splits what you type — the
      interesting part is what happens next, which is the same either way.
    </p>`;
  }

  function bindPlans() {
    const q = $('planq');
    q.addEventListener('input', () => {
      $('planit').disabled = splitCapture(q.value).length === 0;
    });
    $('planit').onclick = () => {
      const lines = splitCapture(q.value);
      if (!lines.length) return;
      const c = findCluster(lines.map((t, i) => ({ id: 'x' + i, text: t })));
      const word = c ? c.theme[0] : lines[0].split(' ')[0];
      const epicId = 'e-' + hex(6);
      state.epics.push({
        id: epicId,
        title: word[0].toUpperCase() + word.slice(1),
      });
      for (const title of lines)
        state.tasks.push({
          id: 't-' + hex(6),
          title,
          epic: epicId,
          status: 'todo',
        });
      go('tasks');
    };
  }

  // ── runs ────────────────────────────────────────────────────────────────
  /** A deterministic transcript per task, so a run reads the same every time. */
  function transcript(t) {
    const file =
      'packages/server/src/' +
      (t.id === 't-9f2a41' ? 'api.ts' : 'orchestrator/mergeQueue.ts');
    return [
      { p: `Reading how this works today before changing it.` },
      { tool: 'Read', arg: file },
      { tool: 'Grep', arg: t.title.split(' ').slice(-2).join(' ') },
      { p: `Making the change, then running the tests for that area.` },
      { tool: 'Edit', arg: file, add: 24, del: 3 },
      { tool: 'Bash', arg: 'bun test packages/server' },
      {
        p: t.live
          ? null
          : `Done. ${t.title[0].toLowerCase()}${t.title.slice(1)} — tests pass.`,
      },
    ];
  }

  function viewRuns() {
    const runs = state.tasks.filter((t) => t.run);
    if (!runs.length)
      return '<p class="empty">No runs yet. Dispatch something.</p>';
    const t =
      task(state.runOn) && task(state.runOn).run ? task(state.runOn) : runs[0];
    return (
      `<div class="lbl">Runs <span class="ct">${runs.length}</span><i class="tail"></i></div>` +
      runs
        .map(
          (r) => `<button class="feed" type="button" data-run="${r.id}">
        <span class="st ${r.live ? 'working' : 'done'}"><span class="dot ${r.live ? 'live' : 'ok'}"></span>${r.live ? 'Working' : 'Finished'}</span>
        <span>${esc(r.title)}</span><span class="rid">${esc(r.run)}</span></button>`
        )
        .join('') +
      `<div class="lbl">Transcript <span class="ct">${esc(t.run)}</span><i class="tail"></i></div>
      <div class="meta"><span>claude</span><span>6 turns</span><span>$0.21</span>
        <span>.dispatch/worktrees/${t.id}</span></div>` +
      transcript(t)
        .map((s) => {
          if (s.p === null)
            return '<div class="turn"><p><span class="caret"></span></p></div>';
          if (s.p) return `<div class="turn"><p>${esc(s.p)}</p></div>`;
          const d =
            s.add !== undefined
              ? ` <span class="plus">+${s.add}</span> <span class="minus">−${s.del}</span>`
              : '';
          return `<div class="turn"><span class="tool"><b>${s.tool}</b> ${esc(s.arg)}${d}</span></div>`;
        })
        .join('')
    );
  }

  // ── review ──────────────────────────────────────────────────────────────
  const HUNK = [
    { n: 38, s: ' ', t: '  const sockets = new Set<ServerWebSocket>();' },
    { n: 39, s: ' ', t: '' },
    { n: 40, s: '-', t: '  setInterval(() => push(read()), 500);' },
    { n: 41, s: '+', t: '  proc.stdout.on("data", (chunk) => {' },
    { n: 42, s: '+', t: '    for (const ws of sockets) ws.send(chunk);' },
    { n: 43, s: '+', t: '  });' },
    { n: 44, s: ' ', t: '' },
    { n: 45, s: ' ', t: '  return { close: () => proc.kill() };' },
  ];

  function viewReview() {
    const open = state.tasks.filter(
      (t) => t.status === 'in-review' && !inQueue(t.id)
    );
    if (!open.length)
      return '<p class="empty">Nothing waiting on review. Dispatch a task and let it finish.</p>';
    const t = open.find((x) => x.id === state.reviewOn) || open[0];
    const rows = HUNK.map((l) => {
      const cls = l.s === '+' ? ' add' : l.s === '-' ? ' del' : '';
      const thread = state.comments
        .filter((c) => c.line === l.n)
        .map(
          (
            c
          ) => `<div class="thread"><span class="who">${esc(c.author)} · line ${c.line}</span>
            <div>${esc(c.body)}</div></div>`
        )
        .join('');
      return `<div class="cl${cls}"><span class="ln">${l.n}</span>
        <span class="sg">${l.s === ' ' ? '' : l.s}</span>
        <span class="cm"><button type="button" data-line="${l.n}" aria-label="Comment on line ${l.n}">✎</button></span>
        <span class="src">${esc(l.t)}</span></div>${thread}`;
    }).join('');

    return `<div class="lbl">${esc(t.title)} <span class="ct">${esc(t.run || t.id)}</span><i class="tail"></i></div>
      <div class="meta"><span>packages/server/src/api.ts</span><span class="plus">+3</span><span class="minus">−1</span></div>
      <div class="code">${rows}</div>
      ${state.composeLine ? composer(state.composeLine) : ''}
      <div class="verdict">
        <label class="sr" for="summary">Summary</label>
        <textarea id="summary" placeholder="Anything the agent should know overall…" style="min-height:34px"></textarea>
        <div class="vrow">
          <span class="ct" style="flex:1">${state.comments.length} comment${state.comments.length === 1 ? '' : 's'}</span>
          <button class="btn quiet" type="button" data-verdict="comment" data-t="${t.id}">Comment</button>
          <button class="btn quiet" type="button" data-verdict="changes" data-t="${t.id}">Request changes</button>
          <button class="btn go" type="button" data-verdict="approve" data-t="${t.id}">Approve</button>
        </div>
      </div>`;
  }

  const composer = (line) => `<div class="thread">
    <span class="who">You · line ${line}</span>
    <label class="sr" for="cbody">Comment</label>
    <textarea id="cbody" placeholder="What should change? This goes back with the work."></textarea>
    <div class="vrow"><button class="btn solid" type="button" data-add="${line}">Add comment</button>
    <button class="btn quiet" type="button" data-add="cancel">Cancel</button></div></div>`;

  // ── landing ─────────────────────────────────────────────────────────────
  function viewLanding() {
    if (!state.queue.length)
      return '<p class="empty">Queue is empty. Approve a review and it lands here.</p>';
    return (
      `<div class="lbl">Merge queue <span class="ct">${state.queue.length}</span><i class="tail"></i></div>` +
      state.queue
        .map((q) => {
          const steps = ['verifying', 'merging', 'merged'].includes(q.state)
            ? q.steps
                .map(
                  (s) =>
                    `<span class="qstep ${s.status}">${s.status === 'passed' ? '✓' : s.status === 'running' ? '·' : '○'} ${s.name}${s.ms ? ' ' + s.ms + 'ms' : ''}</span>`
                )
                .join('')
            : '';
          return `<div class="qrow"><span class="qid">${q.taskId}</span>
          <span class="qs${q.state === 'merged' ? ' done' : ''}">${q.state}</span>${steps}</div>`;
        })
        .join('')
    );
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function dispatch(id, queueIfFull) {
    const t = task(id);
    if (!t || blockers(t).length || t.live) return false;
    if (running() >= CONCURRENCY) {
      if (queueIfFull) {
        t.waiting = true;
        render();
      }
      return false;
    }
    t.waiting = false;
    t.status = 'in-progress';
    t.run = 'r-' + hex(6);
    t.live = true;
    render();
    // Staggered so several at once read as separate pieces of work.
    after(2400 + Math.floor(Math.random() * 1800), () => {
      t.status = 'in-review';
      t.live = false;
      t.note = '3 comments';
      render();
      fill();
    });
    return true;
  }

  /** Starts held tasks as slots free up. */
  function fill() {
    for (const t of state.tasks)
      if (t.waiting && running() < CONCURRENCY) dispatch(t.id, true);
  }

  function workEpic(title) {
    const lane = lanes().find((l) => l.title === title);
    if (!lane) return;
    for (const t of lane.tasks)
      if (t.status === 'todo' && !blockers(t).length) dispatch(t.id, true);
  }

  function approve(id) {
    if (inQueue(id)) return;
    state.queue.push({
      taskId: id,
      state: 'queued',
      steps: VERIFY.map((name) => ({ name, status: 'pending' })),
    });
    go('landing');
    pump();
  }

  /** One entry at a time, in order — otherwise merges race for the branch. */
  function pump() {
    if (state.pumping) return;
    const entry = state.queue.find((q) => q.state === 'queued');
    if (!entry) return;
    state.pumping = true;
    entry.state = 'rebasing';
    render();
    after(650, () => {
      entry.state = 'verifying';
      render();
      let i = 0;
      const step = () => {
        if (i >= entry.steps.length) {
          entry.state = 'merging';
          render();
          after(600, () => {
            entry.state = 'merged';
            const t = task(entry.taskId);
            if (t) {
              t.status = 'done';
              t.note = 'merged';
              t.live = false;
            }
            render();
            fill();
            after(1500, () => {
              state.queue = state.queue.filter((q) => q !== entry);
              state.pumping = false;
              render();
              pump();
            });
          });
          return;
        }
        const s = entry.steps[i];
        s.status = 'running';
        render();
        after(520, () => {
          s.status = 'passed';
          s.ms = 300 + i * 210;
          i += 1;
          render();
          step();
        });
      };
      step();
    });
  }

  function move(id, status) {
    const t = task(id);
    if (!t || t.status === status) return;
    t.status = status;
    t.live = false;
    if (status === 'done') t.note = 'merged';
    render();
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest(
      '[data-tab],[data-act],[data-go],[data-epic],[data-review],[data-open],[data-run],[data-line],[data-add],[data-verdict]'
    );
    if (!el) return;
    const d = el.dataset;
    if (d.tab) return go(d.tab);
    if (d.epic) return workEpic(d.epic);
    if (d.go) return void dispatch(d.go);
    if (d.review) {
      state.reviewOn = d.review;
      return go('review');
    }
    if (d.run) {
      state.runOn = d.run;
      return go('runs');
    }
    if (d.open) {
      const t = task(d.open);
      const s = feedState(t);
      state.reviewOn = t.id;
      state.runOn = t.id;
      return go(
        s === 'review'
          ? 'review'
          : s === 'landing'
            ? 'landing'
            : s === 'working'
              ? 'runs'
              : 'tasks'
      );
    }
    if (d.line) {
      state.composeLine = Number(d.line);
      return render();
    }
    if (d.add) {
      if (d.add === 'cancel') {
        state.composeLine = null;
        return render();
      }
      const body = $('cbody').value.trim();
      if (body)
        state.comments.push({
          id: 'rc-' + hex(3),
          line: Number(d.add),
          author: 'You',
          body,
        });
      state.composeLine = null;
      return render();
    }
    if (d.verdict) {
      const t = task(d.t);
      if (d.verdict === 'approve') return approve(t.id);
      if (d.verdict === 'changes') {
        // Resuming the same agent on the same branch, with the review attached.
        t.status = 'in-progress';
        t.live = true;
        state.comments = [];
        render();
        after(2600, () => {
          t.status = 'in-review';
          t.live = false;
          t.note = 'changes applied';
          render();
        });
        return;
      }
      return render();
    }
    if (d.act === 'tasks') return convert(false);
    if (d.act === 'epic') return convert(true);
    if (d.act === 'pickall') {
      const c = findCluster(state.inbox);
      if (c) state.selected = new Set(c.ids);
      return render();
    }
    if (d.act === 'dismiss') {
      state.inbox.forEach((i) => {
        if (state.selected.has(i.id)) i.done = true;
      });
      state.selected.clear();
      return render();
    }
    if (d.act === 'clear') {
      state.selected.clear();
      return render();
    }
  });

  // Selection updates one class and the bar, not the list: re-rendering would
  // destroy the checkbox that was just clicked and take focus with it.
  document.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.pick;
    if (!id) return;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    e.target.closest('.item').classList.toggle('sel', state.selected.has(id));
    const bar = view.querySelector('.selbar');
    const n = state.selected.size;
    if (!bar || n === 0) render();
    else bar.querySelector('.n').textContent = `${n} selected`;
  });

  // Drag for a mouse, arrow keys for a keyboard: a board only draggable is a
  // board some people cannot use at all.
  let dragId = null;
  view.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    dragId = t.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  view.addEventListener('dragover', (e) => {
    const col = e.target.closest('.drop');
    if (!col) return;
    e.preventDefault();
    col.classList.add('over');
  });
  view.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.drop');
    if (col) col.classList.remove('over');
  });
  view.addEventListener('drop', (e) => {
    const col = e.target.closest('.drop');
    if (!col || !dragId) return;
    e.preventDefault();
    move(dragId, col.dataset.col);
  });
  view.addEventListener('keydown', (e) => {
    const el = e.target.closest('.tile');
    if (!el) return;
    const cur = task(el.dataset.id);
    if (!cur) return;
    const i = STATUSES.indexOf(cur.status);
    if (e.key === 'ArrowRight' && i < STATUSES.length - 1) {
      e.preventDefault();
      move(cur.id, STATUSES[i + 1]);
    }
    if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      move(cur.id, STATUSES[i - 1]);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cur.status === 'todo') dispatch(cur.id);
      else if (cur.status === 'in-review') {
        state.reviewOn = cur.id;
        go('review');
      }
    }
  });

  $('reset').onclick = () => {
    seed();
    render();
  };

  seed();
  render();

  // The seeded run finishes the first time the app is actually on screen —
  // work that happens where nobody is looking is just a surprise later. A rect
  // check rather than IntersectionObserver: same behaviour, and testable.
  let started = false;
  function maybeStart() {
    if (started) return;
    const r = view.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) return;
    started = true;
    window.removeEventListener('scroll', maybeStart);
    after(2400, () => {
      const t = task('t-9f2a41');
      if (t && t.live) {
        t.status = 'in-review';
        t.live = false;
        t.note = '2 comments';
        render();
      }
    });
  }
  window.addEventListener('scroll', maybeStart, { passive: true });
  maybeStart();
})();

/**
 * The hero file, writing itself.
 *
 * The page's claim is that a task is a file rather than a conversation, so the
 * hero shows the file being written: the blocker clears, the status walks
 * todo → in-progress → in-review → done, and the Activity log grows a line at
 * each step. It is the same lifecycle the demo below lets you drive by hand —
 * here it just plays once, so the argument lands before anyone clicks.
 *
 * Reduced motion gets the finished file immediately. The point is the shape of
 * the record, and that survives without the animation.
 */
(() => {
  const status = document.getElementById('hstatus');
  const block = document.getElementById('hblock');
  const act = document.getElementById('hact');
  if (!status || !block || !act) return;

  const line = (t) => `<span class="tick">-</span> ${t}\n`;
  const BEATS = [
    { st: 'todo', cls: '', blocked: true, log: '' },
    {
      st: 'in-progress',
      cls: 'doing',
      blocked: false,
      log: line('dispatched (claude, r-b1d725)'),
    },
    {
      st: 'in-review',
      cls: 'doing',
      blocked: false,
      log: line('review requested (3 comments)'),
    },
    {
      st: 'done',
      cls: 'done',
      blocked: false,
      log: line('merged (typecheck, test, lint)'),
    },
  ];

  let log = '';
  function paint(i, caret) {
    const b = BEATS[i];
    status.textContent = b.st;
    status.className = 'v ' + b.cls;
    block.innerHTML = b.blocked ? '[<span class="id">t-c8954b</span>]' : '[]';
    log += b.log;
    act.innerHTML = log + (caret ? '<span class="hcaret"></span>' : '');
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // paint() accumulates into `log` itself, so replay every beat rather than
    // pre-building the text and painting once — otherwise the log lands twice.
    for (let b = 0; b < BEATS.length; b++) paint(b, false);
    return;
  }

  let i = 0;
  paint(0, true);
  const step = () => {
    i += 1;
    if (i >= BEATS.length) {
      act.innerHTML = log;
      return;
    }
    paint(i, i < BEATS.length - 1);
    setTimeout(step, 1500);
  };
  setTimeout(step, 1200);
})();
