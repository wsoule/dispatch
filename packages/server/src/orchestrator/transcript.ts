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
  reviewAction?: 'merge' | 'discard';
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
      reviewAction?: 'merge' | 'discard';
    }
  ): void {
    const line: TranscriptStateLine = { type: 'state', state, ts, ...finish };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
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
      };
    }
  }
  return { meta, entries };
}
