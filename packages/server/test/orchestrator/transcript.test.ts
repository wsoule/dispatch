import { describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  replayTranscript,
  Transcript,
} from '../../src/orchestrator/transcript.js';
import type { RunMeta } from '../../src/orchestrator/types.js';

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-000001',
    taskId: 't-abc123',
    taskTitle: 'Fix login',
    executor: 'fake',
    state: 'provisioning',
    branch: 'dispatch/t-abc123-fix-login',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('Transcript', () => {
  it('writes a header line, then appends entries and state transitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const path = join(dir, 'sub', 'r-000001.jsonl');
    const transcript = new Transcript(path);
    const meta = makeMeta();

    transcript.writeHeader(meta);
    transcript.appendEntry({
      ts: '2026-07-20T00:00:01.000Z',
      kind: 'assistant',
      text: 'Starting work',
    });
    transcript.appendState('running', '2026-07-20T00:00:02.000Z');
    transcript.appendState('finished', '2026-07-20T00:00:03.000Z', {
      costUsd: 0.42,
      turns: 3,
    });

    const lines = transcript.read();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ type: 'header', meta });
    expect(lines[1]).toEqual({
      type: 'entry',
      entry: {
        ts: '2026-07-20T00:00:01.000Z',
        kind: 'assistant',
        text: 'Starting work',
      },
    });
    expect(lines[2]).toEqual({
      type: 'state',
      state: 'running',
      ts: '2026-07-20T00:00:02.000Z',
    });
    expect(lines[3]).toEqual({
      type: 'state',
      state: 'finished',
      ts: '2026-07-20T00:00:03.000Z',
      costUsd: 0.42,
      turns: 3,
    });
  });

  it('returns an empty array when the file does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const transcript = new Transcript(join(dir, 'missing.jsonl'));
    expect(transcript.read()).toEqual([]);
  });

  // C3: a transcript can be left with a truncated final line by a crash
  // mid-write (the process dies between `write()` and the trailing
  // newline). `read()` must skip exactly that line rather than throwing —
  // mirrors index.ts's "skipping unparsable task file" tolerance for core's
  // TaskStore, applied to transcripts.
  it('skips an unparsable line instead of throwing, keeping every valid line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const path = join(dir, 'r-000004.jsonl');
    const transcript = new Transcript(path);
    const meta = makeMeta({ id: 'r-000004' });
    transcript.writeHeader(meta);
    transcript.appendEntry({ ts: 't1', kind: 'assistant', text: 'hi' });
    // Simulate a crash mid-write: a truncated, unparsable JSON fragment.
    appendFileSync(path, '{"type":"entry","entry":{"ts":"t2","kind":\n');

    const lines = transcript.read();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ type: 'header', meta });
    expect(lines[1]).toEqual({
      type: 'entry',
      entry: { ts: 't1', kind: 'assistant', text: 'hi' },
    });
  });

  // New-3: a truncated final line has no trailing newline; appendState must
  // start on a fresh line so the state marker itself stays parsable instead
  // of fusing onto the fragment (which made boot re-mark the run every time).
  it('appends a state line cleanly after a truncated line with no trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const path = join(dir, 'r-000005.jsonl');
    const transcript = new Transcript(path);
    transcript.writeHeader(makeMeta({ id: 'r-000005' }));
    // Crash artifact: truncated fragment WITHOUT a trailing newline.
    appendFileSync(path, '{"type":"entry","entry":{"ts":"t2","kind":');

    transcript.appendState('failed', 't3', { error: 'interrupted' });

    const lines = transcript.read();
    const last = lines[lines.length - 1];
    expect(last).toEqual({
      type: 'state',
      state: 'failed',
      ts: 't3',
      error: 'interrupted',
    });
  });
});

describe('replayTranscript', () => {
  it('folds header + entries + latest state into a replayable RunMeta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const path = join(dir, 'r-000002.jsonl');
    const transcript = new Transcript(path);
    const meta = makeMeta({ id: 'r-000002', state: 'provisioning' });
    transcript.writeHeader(meta);
    transcript.appendEntry({ ts: 't1', kind: 'assistant', text: 'hi' });
    transcript.appendState('running', 't2');
    transcript.appendState('finished', 't3', { costUsd: 1.5, turns: 2 });

    const replay = replayTranscript(path);
    expect(replay).not.toBeNull();
    expect(replay?.meta.state).toBe('finished');
    expect(replay?.meta.costUsd).toBe(1.5);
    expect(replay?.meta.turns).toBe(2);
    expect(replay?.entries).toEqual([
      { ts: 't1', kind: 'assistant', text: 'hi' },
    ]);
  });

  it('returns null when the transcript file does not exist', () => {
    expect(replayTranscript('/nonexistent/path/r-000003.jsonl')).toBeNull();
  });

  // C3: a header followed by a truncated/corrupt line must still replay to
  // a valid RunMeta (from the header alone) rather than throwing — this is
  // exactly the shape boot reconciliation hits after a crash mid-write, and
  // it must be able to mark the run failed, not abort startup.
  it('replays from just the header when a later line is unparsable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-transcript-'));
    const path = join(dir, 'r-000005.jsonl');
    const meta = makeMeta({ id: 'r-000005', state: 'running' });
    writeFileSync(path, `${JSON.stringify({ type: 'header', meta })}\n`);
    appendFileSync(path, '{"type":"state","state":"fini\n');

    const replay = replayTranscript(path);
    expect(replay).not.toBeNull();
    expect(replay?.meta.state).toBe('running');
  });
});
