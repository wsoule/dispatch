import { describe, expect, it } from 'bun:test';

import { parseActivity, parseActivityLine } from './activityFeed';

describe('parseActivityLine', () => {
  it('reads an orchestrator event as a dated, unattributed timeline line', () => {
    expect(
      parseActivityLine(
        '- 2026-09-13T10:00:00.000Z dispatched (claude, branch dispatch/t-1)'
      )
    ).toEqual({
      at: '2026-09-13T10:00:00.000Z',
      text: 'dispatched (claude, branch dispatch/t-1)',
      actor: null,
      kind: 'event',
    });
  });

  it("keeps an automatic dispatch's `— auto: …` cause as event text", () => {
    expect(
      parseActivityLine(
        '- 2026-09-13T10:00:00.000Z dispatched (claude, branch b) — auto: epic e-1 auto-fill, unblocked by t-2'
      )
    ).toEqual({
      at: '2026-09-13T10:00:00.000Z',
      text: 'dispatched (claude, branch b) — auto: epic e-1 auto-fill, unblocked by t-2',
      actor: null,
      kind: 'event',
    });
  });

  it('reads an agent task_comment as a comment', () => {
    expect(
      parseActivityLine(
        '- 2026-09-13T10:05:00Z Tests pass locally. — agent:wyat/claude'
      )
    ).toEqual({
      at: '2026-09-13T10:05:00Z',
      text: 'Tests pass locally.',
      actor: 'agent:wyat/claude',
      kind: 'comment',
    });
  });

  it('reads a composer note as a comment', () => {
    const entry = parseActivityLine(
      '- 2026-09-20T10:00:00.000Z ship it after the fix — human'
    );
    expect(entry.kind).toBe('comment');
    expect(entry.actor).toBe('human');
    expect(entry.text).toBe('ship it after the fix');
  });

  it('treats an undated, unattributed line as a legacy note', () => {
    expect(parseActivityLine('- remember to bump the version')).toEqual({
      at: null,
      text: 'remember to bump the version',
      actor: null,
      kind: 'comment',
    });
  });

  it('keeps a policy line credited to nobody on the timeline', () => {
    const entry = parseActivityLine(
      '- 2026-09-13T10:00:00.000Z auto-dispatched by policy — none'
    );
    expect(entry.kind).toBe('event');
    expect(entry.actor).toBe('none');
  });

  it('keeps a trailing em-dash word that is not an actor in the text', () => {
    const entry = parseActivityLine('- 2026-09-13T10:00:00.000Z fixed — done');
    expect(entry.actor).toBeNull();
    expect(entry.text).toBe('fixed — done');
  });

  it('does not mistake an em dash inside the text for an actor', () => {
    const entry = parseActivityLine(
      '- 2026-09-13T10:00:00.000Z worktree removed; branch kept — it has unmerged commits'
    );
    expect(entry.actor).toBeNull();
    expect(entry.text).toBe(
      'worktree removed; branch kept — it has unmerged commits'
    );
  });
});

describe('parseActivity', () => {
  it('drops blank lines and keeps order', () => {
    const entries = parseActivity(
      '- 2026-09-13T10:00:00.000Z dispatched\n\n- a note\n'
    );
    expect(entries.map((e) => e.text)).toEqual(['dispatched', 'a note']);
  });

  it('folds continuation lines into one comment', () => {
    // core's appendActivity keeps the composer's newlines and credits the whole
    // bullet after its last line.
    const entries = parseActivity(
      '- 2026-09-13T10:00:00.000Z dispatched\n' +
        '- 2026-09-20T10:00:00.000Z first\nsecond — human\n' +
        '- 2026-09-20T11:00:00.000Z merged\n'
    );
    expect(entries).toEqual([
      {
        at: '2026-09-13T10:00:00.000Z',
        text: 'dispatched',
        actor: null,
        kind: 'event',
      },
      {
        at: '2026-09-20T10:00:00.000Z',
        text: 'first\nsecond',
        actor: 'human',
        kind: 'comment',
      },
      {
        at: '2026-09-20T11:00:00.000Z',
        text: 'merged',
        actor: null,
        kind: 'event',
      },
    ]);
  });

  it('keeps a leading unmarked line as its own entry', () => {
    const entries = parseActivity('legacy note\n- 2026-09-13T10:00:00.000Z x');
    expect(entries.map((e) => e.text)).toEqual(['legacy note', 'x']);
  });
});
