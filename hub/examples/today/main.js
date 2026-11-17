// Today: the runs that landed or opened a pull request since midnight, newest
// first, with the time of day each one moved. Click a run to open it.

import { core, px, run, runs, task, theme } from 'dispatch';
import { h_flex, v_flex } from 'gpui-base';
import { div, View } from 'gpui-kit';

// States that count: merged or landed, or a pull request waiting to merge.
const DONE = ['landed', 'merged', 'pr-open'];

export default class Today extends View {
  render() {
    const t = theme();
    const tok = t.tokens;
    const size = t.text;
    const root = v_flex()
      .id('today')
      .size_full()
      .overflow_y_scroll()
      .px(px(16))
      .pt(px(12))
      .pb(px(16))
      .gap(px(2))
      .bg(tok.panel)
      .text_color(tok.text)
      .text_size(px(size.body));
    if (core().state !== 'connected')
      return root.child(note('Not connected to the core.', t));

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = runs({})
      .filter((r) => DONE.includes(r.state) && movedAt(r) >= midnight.getTime())
      .sort((a, b) => movedAt(b) - movedAt(a));

    root.child(
      h_flex()
        .flex_none()
        .h(px(30))
        .gap(px(8))
        .items_center()
        .child(div().font_weight(500).text_color(tok.textSoft).child('Today'))
        .child(div().text_color(tok.muted).child(String(today.length)))
    );
    if (today.length === 0)
      root.child(note('Nothing has landed or opened a pull request today.', t));
    for (const r of today) root.child(row(r, t));
    return root;
  }
}

// One run: its state as a dot and a word, its task's title, the pull request
// number and the time it moved.
/** @param {import('dispatch').Run} r @param {import('dispatch').Theme} t */
function row(r, t) {
  const pr = prNumber(r);
  const tok = t.tokens;
  const tone = t.tones[t.status[r.state] ?? 'idle'];
  const title = task(r.project, r.task)?.fields.title;
  return h_flex()
    .id(`today-${r.id}`)
    .min_h(px(36))
    .px(px(8))
    .gap(px(10))
    .items_center()
    .rounded(px(t.radius.control))
    .cursor_pointer()
    .hover((el) => el.bg(tok.raised))
    .on_click(() => run('run.open', { run: r.id }))
    .child(div().flex_none().size(px(8)).rounded(px(4)).bg(tone.tone))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(
          div()
            .truncate()
            .child(typeof title === 'string' ? title : r.task)
        )
        .child(
          h_flex()
            .gap(px(8))
            .text_size(px(t.text.small))
            .text_color(tok.muted)
            .child(
              div()
                .text_color(tone.ink)
                .child(r.state === 'pr-open' ? 'pull request open' : r.state)
            )
            .child(pr === null ? div() : div().child(`#${pr}`))
        )
    )
    .child(
      div()
        .flex_none()
        .text_size(px(t.text.small))
        .text_color(tok.muted)
        .font_family(t.fonts.mono)
        .child(clock(movedAt(r)))
    );
}

// When a run last moved, in ms, or 0 when the core has not said.
/** @param {import('dispatch').Run} r @returns {number} */
function movedAt(r) {
  return typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0;
}

// A run's pull request number, or null when it has none.
/** @param {import('dispatch').Run} r @returns {number | null} */
function prNumber(r) {
  const pr = r.pr;
  if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) return null;
  return typeof pr.number === 'number' ? pr.number : null;
}

// A quiet line of help text.
/** @param {string} s @param {import('dispatch').Theme} t */
function note(s, t) {
  return div()
    .py(px(4))
    .text_size(px(t.text.small))
    .text_color(t.tokens.muted)
    .line_height(1.45)
    .child(s);
}

// A time of day, `14:05`, or nothing for 0.
/** @param {number} ms @returns {string} */
function clock(ms) {
  if (ms === 0) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
