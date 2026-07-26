import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { NormalizedEntry, RunMeta, RunState } from './types.js';

export interface TranscriptHeaderLine {
  type: 'header';
  meta: RunMeta;
}

export interface TranscriptEntryLine {
  type: 'entry';
  entry: NormalizedEntry;
}

// Finish fields (costUsd/turns/sessionId/error) only become known once a run
// reaches a terminal state, so they ride along on that state transition
// rather than needing a separate transcript line type.
export interface TranscriptStateLine {
  type: 'state';
  state: RunState;
  ts: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
  // C2's review marker (see RunMeta) rides along on a state line exactly
  // like the other finish fields, even though reviewing a run never changes
  // `state` itself — the append is still the same "one more fact about this
  // run just became true" event the rest of appendState() exists for.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  // Rides along on a state line exactly like reviewedAt/reviewAction — see
  // RunMeta.prUrl's comment for what sets this and when.
  prUrl?: string;
  // Restack bookkeeping (MergeQueue.restackDependents, via
  // Orchestrator.repointRunBase/flagRunRestackFailure). A run's base moves
  // when the blocker it was stacked on merges away, and both the new base and
  // the "this one could not be restacked, a human needs to look at it" flag
  // have to survive a daemon restart: the registry is in-memory only, so a
  // restart replays a run's meta from THIS file. Without these fields a
  // restart resurrects the merged-away base branch (and the next merge is
  // refused with "merge target is X, expected Y") and silently clears the
  // flag, leaving a broken run looking healthy with nothing left to re-run
  // the restack.
  //
  // `stackParents` is here for the same reason and belongs with them: a
  // restack narrows it (the merged blocker drops out) at exactly the moment it
  // rewrites `baseBranch`. Persisting one without the other is worse than
  // persisting neither — replay would then combine the NEW base with the
  // ORIGINAL parent list, and the merge queue would re-derive an
  // already-merged blocker, decide the run sits on an unrepairable
  // multi-parent base, and flag a perfectly healthy run as unmergeable for
  // good. An empty array means "no parents left" and is distinct from an
  // absent field, which means "this line says nothing about parents".
  //
  // `stackBaseCommit` deliberately does NOT appear here: it is fixed at
  // dispatch and never changes, so the header is its only writer.
  baseBranch?: string;
  stackParents?: string[];
  baseDiscarded?: boolean;
  baseDiscardedReason?: string;
}

export type TranscriptLine =
  | TranscriptHeaderLine
  | TranscriptEntryLine
  | TranscriptStateLine;

/**
 * One run's on-disk JSONL transcript: a header line carrying the run's
 * starting metadata, followed by an append-only stream of log entries and
 * state transitions. This is the one thing that survives a dispatchd
 * restart (the registry is in-memory only) — `replayTranscript` below is how
 * a run's meta + entries get reconstructed from just this file.
 */
export class Transcript {
  constructor(readonly path: string) {}

  writeHeader(meta: RunMeta): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const line: TranscriptHeaderLine = { type: 'header', meta };
    writeFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  appendEntry(entry: NormalizedEntry): void {
    const line: TranscriptEntryLine = { type: 'entry', entry };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  appendState(
    state: RunState,
    ts: string = new Date().toISOString(),
    finish?: {
      costUsd?: number;
      turns?: number;
      sessionId?: string;
      error?: string;
      reviewedAt?: string;
      reviewAction?: 'merge' | 'discard' | 'pr';
      prUrl?: string;
      baseBranch?: string;
      stackParents?: string[];
      baseDiscarded?: boolean;
      baseDiscardedReason?: string;
    }
  ): void {
    const line: TranscriptStateLine = { type: 'state', state, ts, ...finish };
    // A crash mid-append can leave the file without a trailing newline;
    // appending straight after would fuse this state line onto the truncated
    // one, making BOTH unparsable. Start on a fresh line if needed.
    let prefix = '';
    if (existsSync(this.path)) {
      const current = readFileSync(this.path, 'utf8');
      if (current.length > 0 && !current.endsWith('\n')) prefix = '\n';
    }
    appendFileSync(this.path, `${prefix}${JSON.stringify(line)}\n`);
  }

  // Tolerant read: a transcript can be left with a truncated final line by a
  // crash mid-write (the process dies between `write()` and its trailing
  // newline), and every line before that one is still a valid, durable
  // record that boot reconciliation and GET /api/runs/:id need. Mirrors
  // index.ts's "skipping unparsable task file" tolerance — one bad line is
  // logged and skipped rather than throwing and losing the whole transcript.
  read(): TranscriptLine[] {
    if (!existsSync(this.path)) return [];
    const lines: TranscriptLine[] = [];
    for (const raw of readFileSync(this.path, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      try {
        lines.push(JSON.parse(raw) as TranscriptLine);
      } catch (err) {
        console.error(
          `dispatchd: skipping unparsable transcript line in ${this.path}: ${(err as Error).message}`
        );
      }
    }
    return lines;
  }
}

// The stack parents a state line leaves a run with. A line that carries no
// `stackParents` at all says nothing about them, so the previous value stands;
// a line that carries an EMPTY array means the last parent just merged away,
// which is recorded as an absent field on RunMeta (what repointRunBase writes
// to the registry) rather than an empty array, so a replayed run compares equal
// to the live one.
function narrowedStackParents(
  line: TranscriptStateLine,
  meta: RunMeta
): string[] | undefined {
  if (line.stackParents === undefined) return meta.stackParents;
  return line.stackParents.length > 0 ? line.stackParents : undefined;
}

// Reconstructs a run's current RunMeta + ordered entry log purely from its
// transcript file — the read path used both by boot reconciliation (which
// has no in-memory registry yet) and by GET /api/runs/:id as a fallback for
// runs the registry no longer holds. The header supplies the base meta; the
// last state line (if any) overrides state and any finish fields it carried.
export function replayTranscript(
  path: string
): { meta: RunMeta; entries: NormalizedEntry[] } | null {
  const lines = new Transcript(path).read();
  const header = lines.find(
    (line): line is TranscriptHeaderLine => line.type === 'header'
  );
  if (header === undefined) return null;

  let meta = header.meta;
  const entries: NormalizedEntry[] = [];
  for (const line of lines) {
    if (line.type === 'entry') {
      entries.push(line.entry);
    } else if (line.type === 'state') {
      meta = {
        ...meta,
        state: line.state,
        updatedAt: line.ts,
        costUsd: line.costUsd ?? meta.costUsd,
        turns: line.turns ?? meta.turns,
        sessionId: line.sessionId ?? meta.sessionId,
        error: line.error ?? meta.error,
        reviewedAt: line.reviewedAt ?? meta.reviewedAt,
        reviewAction: line.reviewAction ?? meta.reviewAction,
        prUrl: line.prUrl ?? meta.prUrl,
        baseBranch: line.baseBranch ?? meta.baseBranch,
        stackParents: narrowedStackParents(line, meta),
        baseDiscarded: line.baseDiscarded ?? meta.baseDiscarded,
        baseDiscardedReason:
          line.baseDiscardedReason ?? meta.baseDiscardedReason,
      };
    }
  }
  return { meta, entries };
}
