/**
 * Two small things, no framework.
 *
 * The demo that used to live here was a simulation of the app. It has been
 * replaced by the real thing in an iframe, so all that is left is the hero
 * board animation, the screenshot tab strip, and the demo bootstrap.
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
      alt: 'The Overview screen: work grouped by what it needs. Needs review, failed, ready, blocked.',
      cap: 'Everything grouped by what it needs from you. Not a feed.',
    },
    runs: {
      alt: 'The Runs screen: a list of agent runs with states and costs, and one run open showing its transcript.',
      cap: 'Every run, what it cost, what the agent did. Failures included.',
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
 * The hero board, working.
 *
 * Two beats, played once, in the order the lede makes its claims: a card an
 * agent was on finishes and moves in-progress → in-review, then the blocked
 * card's blocker clears and it lights up as the next thing to start. The
 * "move" is a collapse/expand pair (the mover and a twin in the target
 * column) so both columns re-flow instead of jumping.
 *
 * Reduced motion gets the finished board immediately.
 */
(() => {
  const board = document.getElementById('hboard');
  if (!board) return;
  const el = (id) => document.getElementById(id);
  const mover = el('hbmover');
  const dest = el('hbdest');
  const blocked = el('hbblocked');
  const live = el('hblive');
  const doingN = el('hbdoingn');
  const revN = el('hbrevn');
  if (!mover || !dest || !blocked || !live || !doingN || !revN) return;

  const move = () => {
    mover.classList.add('hb-gone');
    dest.classList.remove('hb-in');
    doingN.textContent = '1';
    revN.textContent = '2';
    live.textContent = '1 agent live';
  };
  const unblock = () => {
    blocked.classList.add('hb-next');
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    move();
    unblock();
    return;
  }
  setTimeout(move, 1600);
  setTimeout(unblock, 3000);
})();

/**
 * The live demo, started eagerly: the sandbox reaps idle sessions after two
 * minutes and throttles creation per IP, so a session per page load is cheap,
 * and the demo is already running by the time anyone scrolls to it.
 */
(function () {
  // The live-demo Railway service (apps/demo), provisioned in Task 12.
  var DEMO_URL = 'https://dispatch-demo-production-aed7.up.railway.app';
  var iframe = document.getElementById('liveiframe');
  var full = document.getElementById('livefull');
  if (!iframe || !full) return;
  full.href = DEMO_URL;
  iframe.src = DEMO_URL + '/?embed=1';
})();
