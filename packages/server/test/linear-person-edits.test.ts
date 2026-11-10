import { newTaskDoc } from '@dispatch-foo/core';
import type { TaskDoc } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import { LinearPersonEdits } from '../src/linear/personEdits.js';

const OWNER = 'human:ada';

function task(): TaskDoc {
  const doc = newTaskDoc(
    't-1',
    'task',
    { title: 'Widget', status: 'todo' },
    '2026-11-05T00:00:00.000Z'
  );
  return { ...doc, body: '## Description\n\nOld\n' };
}

// The task with some meta fields changed, and optionally its body.
function changed(
  doc: TaskDoc,
  meta: Partial<TaskDoc['meta']>,
  body?: string
): TaskDoc {
  return { meta: { ...doc.meta, ...meta }, body: body ?? doc.body };
}

describe('LinearPersonEdits', () => {
  it('credits an owner edit for the fields it changed', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const after = changed(before, { title: 'Gadget', status: 'doing' });
    edits.edited(before, after, OWNER);
    expect(edits.owns(after, ['title'], OWNER)).toBe(true);
    expect(edits.owns(after, ['title', 'state'], OWNER)).toBe(true);
    // Not edited by anyone here: not theirs.
    expect(edits.owns(after, ['priority'], OWNER)).toBe(false);
    // Someone else's ref never owns it.
    expect(edits.owns(after, ['title'], 'human:bo')).toBe(false);
  });

  it('a later change by anyone else takes the credit away', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, { title: 'Gadget' });
    edits.edited(before, owner, OWNER);
    const agent = changed(owner, { title: 'Gadget (agent)' });
    expect(edits.owns(agent, ['title'], OWNER)).toBe(false);
  });

  it('a push mixing an owned field with an unowned one is not theirs', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, { title: 'Gadget' });
    edits.edited(before, owner, OWNER);
    // An agent changed the status earlier; it was never recorded.
    const pushed = changed(owner, { status: 'doing' });
    expect(edits.owns(pushed, ['title', 'state'], OWNER)).toBe(false);
  });

  it('owns every field of a task the owner created', () => {
    const edits = new LinearPersonEdits();
    const doc = task();
    edits.created(doc, OWNER);
    expect(
      edits.owns(
        doc,
        ['title', 'description', 'state', 'labels', 'parent', 'archived'],
        OWNER
      )
    ).toBe(true);
  });

  it('never credits a pull-only or unknown field, or an empty push', () => {
    const edits = new LinearPersonEdits();
    const doc = task();
    edits.created(doc, OWNER);
    expect(edits.owns(doc, ['creator'], OWNER)).toBe(false);
    expect(edits.owns(doc, ['nonsense'], OWNER)).toBe(false);
    expect(edits.owns(doc, [], OWNER)).toBe(false);
  });

  it('an Activity line alone is not an edit, and does not undo one', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, {}, '## Description\n\nNew\n');
    edits.edited(before, owner, OWNER);
    const logged = changed(
      owner,
      {},
      `${owner.body}\n## Activity\n\n- a run started\n`
    );
    expect(edits.owns(logged, ['description'], OWNER)).toBe(true);
    const fresh = new LinearPersonEdits();
    fresh.edited(owner, logged, OWNER);
    expect(fresh.owns(logged, ['description'], OWNER)).toBe(false);
  });

  it('settled clears the pushed fields only', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const after = changed(before, { title: 'Gadget', priority: 'high' });
    edits.edited(before, after, OWNER);
    edits.settled('t-1', ['title']);
    expect(edits.owns(after, ['title'], OWNER)).toBe(false);
    expect(edits.owns(after, ['priority'], OWNER)).toBe(true);
  });

  it('a part a still-pending field needs keeps its credit when another lands', () => {
    const edits = new LinearPersonEdits();
    const doc = task();
    edits.created(doc, OWNER);
    // `state` landed, `archived` (status and archivedAt) did not.
    edits.settled('t-1', ['state'], ['archived']);
    expect(edits.owns(doc, ['archived'], OWNER)).toBe(true);
    edits.settled('t-1', ['archived']);
    expect(edits.owns(doc, ['state'], OWNER)).toBe(false);
  });

  it('a new instance (a daemon restart) owns nothing', () => {
    const doc = task();
    new LinearPersonEdits().created(doc, OWNER);
    expect(new LinearPersonEdits().owns(doc, ['title'], OWNER)).toBe(false);
  });

  it('owned answers the subset of a push that is theirs', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, { title: 'Gadget' });
    edits.edited(before, owner, OWNER);
    const pushed = changed(owner, { priority: 'high' });
    expect(
      edits.owned(pushed, ['title', 'priority', 'creator'], OWNER)
    ).toEqual(['title']);
  });

  it('a value someone else moved away and back is no longer theirs', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, { title: 'Gadget' });
    edits.edited(before, owner, OWNER);
    // A pull (or any write the owner's routes did not record) moves it…
    const pulled = changed(owner, { title: 'Teammate title' });
    edits.observe('t-1', pulled);
    expect(edits.tracks('t-1')).toBe(false);
    // …and an agent sets the owner's old value back.
    const restored = changed(pulled, { title: 'Gadget' });
    expect(edits.owns(restored, ['title'], OWNER)).toBe(false);
  });

  it('observe keeps the parts another write left alone', () => {
    const edits = new LinearPersonEdits();
    const before = task();
    const owner = changed(before, { title: 'Gadget', priority: 'high' });
    edits.edited(before, owner, OWNER);
    edits.observe('t-1', changed(owner, { priority: 'low' }));
    expect(edits.tracked()).toEqual(['t-1']);
    expect(edits.owned(owner, ['title', 'priority'], OWNER)).toEqual(['title']);
    // A removed task loses everything.
    edits.observe('t-1', null);
    expect(edits.tracked()).toEqual([]);
  });

  it('credits a comment only for the body, or the delete, the owner sent', () => {
    const edits = new LinearPersonEdits();
    expect(edits.wroteComment('c-1', 'Hello', OWNER)).toBe(false);
    edits.commentWritten('c-1', 'Hello', OWNER);
    expect(edits.wroteComment('c-1', 'Hello', OWNER)).toBe(true);
    // A body changed anywhere else is not theirs, nor is another person's.
    expect(edits.wroteComment('c-1', 'Hello!', OWNER)).toBe(false);
    expect(edits.wroteComment('c-1', 'Hello', 'human:bo')).toBe(false);
    expect(edits.deletedComment('c-1', OWNER)).toBe(false);
    edits.commentsDeleted(['c-1', 'c-2'], OWNER);
    expect(edits.deletedComment('c-2', OWNER)).toBe(true);
    expect(edits.wroteComment('c-1', 'Hello', OWNER)).toBe(false);
    edits.commentSettled('c-2');
    expect(edits.deletedComment('c-2', OWNER)).toBe(false);
  });
});
