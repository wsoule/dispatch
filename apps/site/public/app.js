/**
 * Two small things, no framework.
 *
 * The demo that used to live here was a simulation of the app. It has been
 * replaced by screenshots of the real one, so all that is left is the hero
 * file writing itself and the tab strip that swaps those screenshots.
 */

/**
 * The screens tab strip.
 *
 * Swaps the image, its alt text and the caption together — an <img> whose alt
 * still describes the previous screen is worse than no alt at all. The other
 * screenshots are prefetched on first interaction so a switch never shows an
 * empty frame.
 */
(() => {
  const img = document.getElementById('shotimg');
  const cap = document.getElementById('shotcap');
  const nav = document.querySelector('.shotnav');
  if (!img || !cap || !nav) return;

  const SHOTS = {
    tasks: {
      alt: 'The Tasks board: backlog, todo, in-progress, in-review and done columns with task and epic cards.',
      cap: 'A board, with epics as cards and one lane per epic if you want it.',
    },
    overview: {
      alt: 'The Overview screen: work grouped by what it needs — needs review, failed, ready, blocked.',
      cap: 'Everything grouped by what it needs from you. Not a feed of messages.',
    },
    runs: {
      alt: 'The Runs screen: a list of agent runs with states and costs, and one run open showing its transcript.',
      cap: 'Every run, what it cost, and what the agent did — including the ones that failed.',
    },
    review: {
      alt: 'The Review screen: a queue of work needing review, above the merge queue it feeds.',
      cap: 'What needs a look, then what is landing. Approving is what moves one to the other.',
    },
    git: {
      alt: 'The Git screen: branch and worktree counts, disk used, and stale, orphaned and stacked worktrees.',
      cap: 'A checkout per run costs real disk. This says how much, and what is safe to reclaim.',
    },
  };

  let prefetched = false;
  function prefetch() {
    if (prefetched) return;
    prefetched = true;
    for (const name of Object.keys(SHOTS))
      new Image().src = `/shots/${name}.jpg`;
  }

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shot]');
    if (!b) return;
    prefetch();
    const name = b.dataset.shot;
    const meta = SHOTS[name];
    if (!meta) return;
    for (const other of nav.querySelectorAll('[data-shot]'))
      other.setAttribute('aria-selected', String(other === b));
    img.src = `/shots/${name}.jpg`;
    img.alt = meta.alt;
    cap.textContent = meta.cap;
  });
  nav.addEventListener('pointerenter', prefetch, { once: true });
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
