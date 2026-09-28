import { untrustedInline } from '@dispatch/core';

import type { DocChange, DocsHost } from './host.js';
import type { DocNoticeFacts, DocsService } from './service.js';

// One line to a live execute run when a team doc it cares about gets a sealed
// head by someone else: at most one per doc per run per window, then one trailing line.

const MAX_LINE = 160;
const TAIL = ' (doc_read to see)';

// The last notice a run got about one doc, and whether a later seal is waiting.
interface NoticeWindow {
  at: number;
  rev: string;
  taskId: string;
  pending: boolean;
}

// A run's notice line: every untrusted part folded onto the line, the summary
// cut so the whole stays within 160 characters.
export function noticeLine(
  handle: string,
  n: number,
  author: string,
  summary: string
): string {
  const head = `📄 doc · ${untrustedInline(handle)} rev ${n} by ${untrustedInline(author)}: `;
  const room = MAX_LINE - Array.from(head).length - TAIL.length;
  const chars = Array.from(untrustedInline(summary));
  const cut =
    chars.length <= room
      ? chars.join('')
      : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`;
  return Array.from(`${head}${cut}${TAIL}`).slice(0, MAX_LINE).join('');
}

export class DocNotices {
  // Docs each run has read since it started, kept in process only.
  private readonly reads = new Map<string, Set<string>>();
  private readonly windows = new Map<string, Map<string, NoticeWindow>>();

  constructor(
    private readonly deps: {
      service: Pick<DocsService, 'noticeFacts' | 'runCaresAbout'>;
      host: Pick<DocsHost, 'liveExecuteRuns' | 'notifyRun' | 'now'>;
      minutes: () => number;
    }
  ) {}

  recordRead(runId: string, docId: string): void {
    const docs = this.reads.get(runId) ?? new Set<string>();
    docs.add(docId);
    this.reads.set(runId, docs);
  }

  runEnded(runId: string): void {
    this.reads.delete(runId);
    this.windows.delete(runId);
  }

  // A DaemonDocsHost.onChange listener: only a team doc's sealed head counts.
  onChange(change: DocChange): void {
    if (
      change.scope !== 'team' ||
      change.kind !== 'sealed' ||
      change.rev === null
    )
      return;
    const head = this.deps.service.noticeFacts(change.doc);
    if (head === null || head.rev !== change.rev) return;
    const now = this.deps.host.now().getTime();
    const span = this.span();
    for (const run of this.deps.host.liveExecuteRuns()) {
      if (`run:${run.runId}` === change.author) continue;
      if (!this.cares(run.runId, run.taskId, change.doc)) continue;
      const windows =
        this.windows.get(run.runId) ?? new Map<string, NoticeWindow>();
      this.windows.set(run.runId, windows);
      const open = windows.get(change.doc);
      if (open !== undefined && now - open.at < span) {
        open.pending = true;
        continue;
      }
      windows.set(change.doc, {
        at: now,
        rev: head.rev,
        taskId: run.taskId,
        pending: false,
      });
      this.send(run.runId, head);
    }
  }

  // Sends the trailing notices whose window has closed and forgets idle windows.
  flush(): void {
    const now = this.deps.host.now().getTime();
    const span = this.span();
    for (const [runId, windows] of this.windows) {
      for (const [docId, w] of windows) {
        if (now - w.at < span) continue;
        const head = w.pending ? this.trailing(runId, docId, w) : null;
        if (head === null) {
          windows.delete(docId);
          continue;
        }
        windows.set(docId, { ...w, at: now, rev: head.rev, pending: false });
        this.send(runId, head);
      }
      if (windows.size === 0) this.windows.delete(runId);
    }
  }

  // The window in ms; `minutes` reads config.yml, so once per pass.
  private span(): number {
    return this.deps.minutes() * 60_000;
  }

  // The head a trailing notice names: a sealed one past the last notified,
  // not the run's own, on a doc the run still cares about.
  private trailing(
    runId: string,
    docId: string,
    w: NoticeWindow
  ): DocNoticeFacts | null {
    const head = this.deps.service.noticeFacts(docId);
    if (
      head === null ||
      !head.sealed ||
      head.rev === w.rev ||
      head.author === `run:${runId}`
    )
      return null;
    return this.cares(runId, w.taskId, docId) ? head : null;
  }

  private cares(runId: string, taskId: string, docId: string): boolean {
    const read = this.reads.get(runId)?.has(docId) === true;
    return this.deps.service.runCaresAbout(runId, taskId, docId, read);
  }

  // Never stored, held or retried: a run that cannot take a notice drops it.
  private send(runId: string, head: DocNoticeFacts): void {
    try {
      this.deps.host.notifyRun(
        runId,
        noticeLine(head.handle, head.n, head.author, head.summary)
      );
    } catch {
      // Not live, stopping, or an executor without mid-run input.
    }
  }
}
