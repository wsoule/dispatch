import type { CommandEvidence, Finding, LedgerEntry } from '@dispatch-foo/core';

import type { DiffFile, NormalizedEntry, RunMeta } from './apiClient.js';

// The shareable run page: one self-contained HTML file carrying everything a
// reviewer or an auditor needs about a run — what it was asked to do, what it
// changed, what was found, what was decided, and what it actually did.
//
// Static and dependency-free on purpose. `dispatch share` writes a file you
// can hand to anyone, attach to a ticket, or host anywhere, with no daemon,
// no account and no network at the other end. That is also why this module is
// pure: it takes data and returns a string, so the whole page is testable
// without a browser or a running project.

/** Everything the page renders, assembled by `dispatch share` from the
 *  daemon's own endpoints. Nothing here is computed: if a field is missing the
 *  page says so rather than guessing. */
export interface RunPacket {
  generatedAt: string;
  run: RunMeta;
  /** The unified patch as git produced it, and the files it touches. */
  diff: { patch: string; files: DiffFile[] };
  /** The run's transcript, oldest first. */
  entries: NormalizedEntry[];
  /** Commands the run ran and what they returned. */
  evidence: CommandEvidence[];
  /** Findings raised against this run's task. */
  findings: Finding[];
  /** Decisions and rulings recorded while this run was alive. */
  ledger: LedgerEntry[];
  /** The preview command this run's dev server was started with, when one was
   *  ever started. A static page cannot embed a live dev server, so this
   *  records that a preview existed and how to reproduce it — not a frame. */
  previewCommand?: string;
}

/** HTML-escapes text going into the page. Every value below is repo content —
 *  commit messages, file paths, agent output — so none of it may be trusted
 *  as markup. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One `<section>` with a heading, or nothing at all when the section is
 *  empty. A page of empty headings reads as broken; a shorter page reads as a
 *  run that simply had no findings. */
function section(title: string, body: string): string {
  if (body.trim() === '') return '';
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

/** The run header: the facts someone checks first, including the ones that
 *  cost money. */
function renderSummary(packet: RunPacket): string {
  const { run } = packet;
  const rows: [string, string][] = [
    ['Task', `${run.taskTitle} (${run.taskId})`],
    ['Run', run.id],
    ['State', run.state],
    ['Branch', `${run.branch} → ${run.baseBranch}`],
    [
      'Executor',
      run.model === undefined ? run.executor : `${run.executor} · ${run.model}`,
    ],
    ['Started', run.createdAt],
    ['Updated', run.updatedAt],
  ];
  if (run.costUsd !== undefined)
    rows.push(['Cost', `$${run.costUsd.toFixed(2)}`]);
  if (run.turns !== undefined) rows.push(['Turns', String(run.turns)]);
  if (packet.previewCommand !== undefined) {
    rows.push(['Preview command', packet.previewCommand]);
  }
  const cells = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('');
  return `<table class="summary">${cells}</table>`;
}

/** The diff, as the unified patch with per-line colouring. Rendered from the
 *  patch text rather than reconstructed, so what the page shows is exactly
 *  what git produced. */
function renderDiff(packet: RunPacket): string {
  if (packet.diff.patch.trim() === '') return '';
  const files = packet.diff.files
    .map(
      (f) =>
        `<li><code>${esc(f.path)}</code> <span class="muted">${esc(f.status)}</span></li>`
    )
    .join('');
  const lines = packet.diff.patch
    .split('\n')
    .map((line) => {
      const cls =
        line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : line.startsWith('@@')
                ? 'hunk'
                : '';
      return `<span class="${cls}">${esc(line)}</span>`;
    })
    .join('\n');
  return `<ul class="files">${files}</ul><pre class="diff">${lines}</pre>`;
}

function renderFindings(packet: RunPacket): string {
  if (packet.findings.length === 0) return '';
  const rows = packet.findings
    .map((f) => {
      const where =
        f.file === null
          ? ''
          : `<div class="muted"><code>${esc(f.file)}${f.line === null ? '' : `:${f.line}`}</code></div>`;
      const ruling =
        f.ruling === null || f.ruling === ''
          ? ''
          : `<div class="ruling">Ruling: ${esc(f.ruling)}</div>`;
      return `<li class="finding"><div class="badges"><span class="badge sev-${esc(f.severity)}">${esc(f.severity)}</span><span class="badge">${esc(f.verdict)}</span></div><strong>${esc(f.title)}</strong>${where}<p>${esc(f.detail)}</p>${ruling}</li>`;
    })
    .join('');
  return `<ul class="findings">${rows}</ul>`;
}

function renderLedger(packet: RunPacket): string {
  if (packet.ledger.length === 0) return '';
  const rows = packet.ledger
    .map(
      (l) =>
        `<li><span class="badge">${esc(l.kind)}</span> <strong>${esc(l.title)}</strong><p>${esc(l.detail)}</p><div class="muted">${esc(l.createdAt)}${l.authoredBy === '' ? '' : ` · ${esc(l.authoredBy)}`}</div></li>`
    )
    .join('');
  return `<ul class="ledger">${rows}</ul>`;
}

function renderEvidence(packet: RunPacket): string {
  if (packet.evidence.length === 0) return '';
  const rows = packet.evidence
    .map(
      (e) =>
        `<tr><td><code>${esc(e.command)}</code></td><td class="${e.exitCode === 0 ? 'ok' : 'bad'}">${esc(e.exitCode)}</td><td>${esc(e.summary)}</td></tr>`
    )
    .join('');
  return `<table class="evidence"><thead><tr><th>Command</th><th>Exit</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The transcript. `thinking` and `usage` entries are dropped: the first is
 *  the model's scratch work rather than a record of what happened, and the
 *  second is accounting already summarised in the header. */
function renderTranscript(packet: RunPacket): string {
  const shown = packet.entries.filter(
    (e) => e.kind !== 'thinking' && e.kind !== 'usage'
  );
  if (shown.length === 0) return '';
  const rows = shown
    .map((e) => {
      const label =
        e.toolName === undefined ? e.kind : `${e.kind} · ${e.toolName}`;
      const body =
        e.text === undefined || e.text === '' ? '' : `<p>${esc(e.text)}</p>`;
      return `<li class="entry kind-${esc(e.kind)}"><div class="muted">${esc(e.ts)} · ${esc(label)}</div>${body}</li>`;
    })
    .join('');
  return `<ul class="transcript">${rows}</ul>`;
}

// Inlined rather than linked: the page has to render with no network at all,
// which is the whole promise of handing someone a file. Dark mode is a media
// query rather than a toggle, so there is no state to carry.
const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e2e2e2; --card:#fafafa; --add:#0a7f3f; --del:#b3261e; --hunk:#5a3fbf; }
@media (prefers-color-scheme: dark) { :root { --bg:#111417; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2a2f35; --card:#181c20; --add:#7ee2a8; --del:#ff8b80; --hunk:#c3b0ff; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
main { max-width: 1000px; margin: 0 auto; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--line); }
code, pre { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
table { border-collapse:collapse; width:100%; } th,td { text-align:left; padding:4px 8px; vertical-align:top; border-bottom:1px solid var(--line); }
table.summary th { width:150px; color:var(--muted); font-weight:500; }
ul { list-style:none; padding:0; margin:0; } ul.files li, ul.findings li, ul.ledger li, ul.transcript li { padding:8px; border-bottom:1px solid var(--line); }
pre.diff { overflow-x:auto; background:var(--card); padding:12px; border-radius:6px; }
pre.diff span { display:block; white-space:pre; }
.add { color:var(--add); } .del { color:var(--del); } .hunk { color:var(--hunk); } .meta { color:var(--muted); }
.muted { color:var(--muted); font-size:12px; }
.badge { display:inline-block; padding:1px 6px; border:1px solid var(--line); border-radius:999px; font-size:11px; margin-right:4px; }
.sev-critical, .sev-important { color:var(--del); } .ok { color:var(--add); } .bad { color:var(--del); }
.ruling { margin-top:4px; font-size:12px; }
p { margin:4px 0; white-space:pre-wrap; }
footer { margin-top:32px; color:var(--muted); font-size:12px; }
@media (max-width:600px) { body { padding:16px; } table.summary th { width:auto; } }
`;

/**
 * The whole page, as one HTML string.
 *
 * Section order follows what someone actually asks: what was this, what
 * changed, what was wrong with it, what was decided, what was checked, and
 * only then the full transcript — which is the longest and the least often
 * read.
 */
export function renderSharePage(packet: RunPacket): string {
  const title = `${packet.run.taskTitle} · ${packet.run.id}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(packet.run.taskTitle)}</h1>
<div class="muted">Run ${esc(packet.run.id)} · generated ${esc(packet.generatedAt)}</div>
${section('Summary', renderSummary(packet))}
${section('Diff', renderDiff(packet))}
${section('Findings', renderFindings(packet))}
${section('Decisions', renderLedger(packet))}
${section('Evidence', renderEvidence(packet))}
${section('Transcript', renderTranscript(packet))}
<footer>Generated by dispatch share. This page is a static record — it carries no live connection to the project it came from.</footer>
</main>
</body>
</html>
`;
}
