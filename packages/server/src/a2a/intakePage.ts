// The pages an outside person sees through an intake link: the request form,
// the status page its receipt URL opens, and the one "not available" page
// every bad token gets. Pure: each takes plain data and returns HTML, so the
// pages are testable without a listener. Every value is the requester's or
// the team's text, so all of it is escaped; the pages load nothing, run no
// script and post only to themselves.

import type { IntakeStep } from './intake.js';

/** Everything the status page renders; intake.ts derives it from the A2A
 *  decision, so the page never reads a Dispatch task itself. */
export interface StatusView {
  title: string;
  step: IntakeStep;
  headline: string;
  // The team's latest message in the request's thread, as plain text.
  message: string | null;
  // Set while the team has asked a question the requester can answer here.
  question: { choices: string[] } | null;
  prUrl: string | null;
  updatedAt: string;
  // Open requests refresh themselves; a finished one stays put.
  terminal: boolean;
  error?: string;
}

export interface FormView {
  label: string;
  values?: {
    title?: string;
    details?: string;
    name?: string;
    contact?: string;
  };
  error?: string;
}

// The five steps the tracker shows, and which of them each step lights up.
const TRACK = ['Received', 'Accepted', 'In progress', 'In review', 'Done'];
const POSITION: Partial<Record<IntakeStep, number>> = {
  received: 0,
  accepted: 1,
  working: 2,
  question: 2,
  review: 3,
  landing: 3,
  done: 4,
};

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1a}
main{max-width:640px;margin:48px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}
.muted{color:#6b6b66;font-size:13px}
.card{background:#fff;border:1px solid #e4e4df;border-radius:10px;padding:20px;margin-top:20px}
label{display:block;font-weight:600;margin:14px 0 4px}
input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid #d4d4cf;border-radius:6px;background:#fff}
textarea{min-height:140px;resize:vertical}
button{font:inherit;font-weight:600;margin-top:16px;padding:8px 16px;border-radius:6px;border:1px solid #1c1c1a;background:#1c1c1a;color:#fff;cursor:pointer}
button.alt{background:#fff;color:#1c1c1a;margin-right:8px}
.error{background:#fdecea;border:1px solid #f3c1bb;color:#8a1c12;border-radius:6px;padding:10px 12px;margin-top:16px}
ol.track{list-style:none;display:flex;gap:6px;padding:0;margin:20px 0 0}
ol.track li{flex:1;font-size:12px;text-align:center;padding-top:8px;border-top:4px solid #e4e4df;color:#9a9a94}
ol.track li.done{border-color:#1c1c1a;color:#1c1c1a}
ol.track li.now{border-color:#2f6fde;color:#2f6fde;font-weight:600}
.headline{font-size:18px;font-weight:600;margin:0}
blockquote{margin:12px 0 0;padding:10px 14px;border-left:3px solid #d4d4cf;background:#fafaf8;white-space:pre-wrap}
`;

function page(title: string, body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${refresh ? '<meta http-equiv="refresh" content="30">\n' : ''}<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

function errorBlock(error: string | undefined): string {
  return error === undefined
    ? ''
    : `<div class="error" role="alert">${esc(error)}</div>`;
}

/** The request form an intake link opens; it posts back to its own URL. */
export function renderForm(view: FormView): string {
  const v = view.values ?? {};
  return page(
    view.label,
    `<h1>${esc(view.label)}</h1>
<p class="muted">Send a request to the team. You will get a private link to follow it.</p>
${errorBlock(view.error)}
<form class="card" method="post" action="">
<label for="title">What do you need?</label>
<input id="title" name="title" required maxlength="200" value="${esc(v.title ?? '')}">
<label for="details">Details</label>
<textarea id="details" name="details" maxlength="8000">${esc(v.details ?? '')}</textarea>
<label for="name">Your name</label>
<input id="name" name="name" required maxlength="100" value="${esc(v.name ?? '')}">
<label for="contact">How to reach you (optional)</label>
<input id="contact" name="contact" maxlength="200" value="${esc(v.contact ?? '')}">
<button type="submit">Send request</button>
</form>`
  );
}

function track(step: IntakeStep): string {
  const at = POSITION[step];
  if (at === undefined) return '';
  const items = TRACK.map((name, i) => {
    const cls = i < at ? 'done' : i === at ? (at === 4 ? 'done' : 'now') : '';
    return `<li${cls === '' ? '' : ` class="${cls}"`}>${esc(name)}</li>`;
  });
  return `<ol class="track">${items.join('')}</ol>`;
}

function replyForm(question: { choices: string[] }): string {
  const choices = question.choices
    .map(
      (c) =>
        `<button class="alt" type="submit" name="choice" value="${esc(c)}">${esc(c)}</button>`
    )
    .join('');
  return `<form class="card" method="post" action="">
<label for="body">Your answer</label>
<textarea id="body" name="body" maxlength="8000"></textarea>
${choices === '' ? '<button type="submit">Send answer</button>' : `<div>${choices}</div>`}
</form>`;
}

/** The status page a request's receipt URL opens. */
export function renderStatus(view: StatusView): string {
  const pr =
    view.prUrl === null
      ? ''
      : `<p>Change: <a href="${esc(view.prUrl)}" rel="noreferrer noopener">${esc(view.prUrl)}</a></p>`;
  const message =
    view.message === null
      ? ''
      : `<blockquote>${esc(view.message)}</blockquote>`;
  return page(
    view.title,
    `<h1>${esc(view.title)}</h1>
<p class="muted">Keep this page's link: it is the only way back to your request.</p>
${errorBlock(view.error)}
<section class="card">
<p class="headline">${esc(view.headline)}</p>
${track(view.step)}
${message}
${pr}
<p class="muted">Last update ${esc(view.updatedAt)}</p>
</section>
${view.question === null ? '' : replyForm(view.question)}`,
    !view.terminal
  );
}

/** The one page an unknown, revoked or closed token gets, so none of them
 *  can be told apart. */
export function renderUnavailable(
  text = 'This link is not available.'
): string {
  return page('Not available', `<h1>Not available</h1><p>${esc(text)}</p>`);
}
