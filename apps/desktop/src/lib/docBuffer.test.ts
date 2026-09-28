import type { DocConflict, DocSaveResult } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  autosaveDelay,
  beginDocSave,
  CONFLICT_HOLD_MS,
  docSaveConflicted,
  docSaveFailed,
  docSaveSucceeded,
  docSealProblem,
  docShouldSave,
  editDocBuffer,
  isRefusal,
  openDocBuffer,
  reloadIfClean,
} from './docBuffer';
import { AUTOSAVE_DEBOUNCE_MS } from './editorBuffer';

const BASE = { rev: 'rev-1', n: 1, hash: 'h1' };
const result = (
  status: DocSaveResult['status'],
  rev: { id: string; n: number; hash: string },
  mine?: { id: string; n: number; hash: string }
): DocSaveResult => ({
  status,
  rev,
  handle: 'spec',
  doc: {} as DocSaveResult['doc'],
  ...(mine === undefined ? {} : { mine }),
});
const conflictOf = (
  reason: DocConflict['reason'],
  head: { id: string; n: number; hash: string; body: string; author: string },
  marked: string
): DocConflict => ({
  code: 'conflict',
  reason,
  head,
  base: reason === 'base-changed' ? null : { id: 'rev-1', n: 1 },
  hunks: [],
  marked,
});
const sent = (text: string) =>
  beginDocSave(editDocBuffer(openDocBuffer('doc-1', 'a\n', BASE), text));

describe('docBuffer', () => {
  it('advances the base to the revision its save produced', () => {
    let b = openDocBuffer('doc-1', 'a\n', BASE);
    b = beginDocSave(editDocBuffer(b, 'a\nb\n'));
    b = docSaveSucceeded(
      b,
      result('amended', { id: 'rev-1', n: 1, hash: 'h2' }),
      null
    );
    expect(b.base).toEqual({ rev: 'rev-1', n: 1, hash: 'h2' });
    expect(b.buffer.status).toBe('clean');
  });

  it('review focus 1: keeps typing that raced a save, and saves it next', () => {
    let b = sent('a\nb\n');
    b = editDocBuffer(b, 'a\nb\nc\n');
    b = docSaveSucceeded(
      b,
      result('saved', { id: 'rev-2', n: 2, hash: 'h2' }),
      null
    );
    expect(b.buffer.text).toBe('a\nb\nc\n');
    expect(b.buffer.status).toBe('dirty');
    expect(docShouldSave(b)).toBe(true);
    expect(b.base.rev).toBe('rev-2');
  });

  it('reloads the merged head when nothing was typed, and bases on its own revision when something was', () => {
    const merged = result(
      'merged',
      { id: 'rev-4', n: 4, hash: 'h4' },
      { id: 'rev-3', n: 3, hash: 'h3' }
    );
    const idle = docSaveSucceeded(
      sent('a\nmine\n'),
      merged,
      'theirs\na\nmine\n'
    );
    expect(idle.buffer.text).toBe('theirs\na\nmine\n');
    expect(idle.base.rev).toBe('rev-4');
    const typing = editDocBuffer(sent('a\nmine\n'), 'a\nmine\nmore\n');
    const kept = docSaveSucceeded(typing, merged, 'theirs\na\nmine\n');
    expect(kept.buffer.text).toBe('a\nmine\nmore\n');
    expect(kept.base).toEqual({ rev: 'rev-3', n: 3, hash: 'h3' });
  });

  it('loads the marked text against the head on a conflict', () => {
    const conflict = conflictOf(
      'merge-conflict',
      { id: 'rev-5', n: 5, hash: 'h5', body: 'head\n', author: 'run:r-1' },
      '<<<<<<< head\n…\n'
    );
    const b = docSaveConflicted(sent('mine\n'), conflict);
    expect(b.buffer.text).toBe('<<<<<<< head\n…\n');
    expect(b.buffer.status).toBe('dirty');
    expect(b.base).toEqual({ rev: 'rev-5', n: 5, hash: 'h5' });
    expect(b.conflict).toEqual({ headN: 5, headAuthor: 'run:r-1' });
  });

  it('review focus 1: a base-changed answer keeps the typed text beside the head as one marked block', () => {
    const conflict = conflictOf(
      'base-changed',
      { id: 'rev-1', n: 1, hash: 'h9', body: 'theirs\n', author: 'human:wyat' },
      'theirs\n'
    );
    const b = docSaveConflicted(sent('mine'), conflict);
    expect(b.buffer.text).toBe(
      '<<<<<<< head (rev 1, human:wyat)\ntheirs\n=======\nmine\n>>>>>>> yours\n'
    );
    expect(b.base).toEqual({ rev: 'rev-1', n: 1, hash: 'h9' });
    expect(b.conflict).toEqual({ headN: 1, headAuthor: 'human:wyat' });
  });

  it('a base-changed answer whose head already holds the text loads it clean', () => {
    const conflict = conflictOf(
      'base-changed',
      { id: 'rev-1', n: 1, hash: 'h9', body: 'same\n', author: 'human:wyat' },
      'same\n'
    );
    const b = docSaveConflicted(sent('same\n'), conflict);
    expect(b.buffer.text).toBe('same\n');
    expect(b.buffer.status).toBe('clean');
    expect(b.conflict).toBeNull();
  });

  it('keeps typing that raced a conflicted save as one marked block', () => {
    const conflict = conflictOf(
      'merge-conflict',
      { id: 'rev-5', n: 5, hash: 'h5', body: 'head\n', author: 'run:r-1' },
      '<<<<<<< head (rev 5, run:r-1)\nhead\n=======\nmine\n>>>>>>> yours\n'
    );
    const typing = editDocBuffer(sent('mine\n'), 'mine\nmore\n');
    const b = docSaveConflicted(typing, conflict);
    expect(b.buffer.text).toBe(
      '<<<<<<< head (rev 5, run:r-1)\nhead\n=======\nmine\nmore\n>>>>>>> yours\n'
    );
  });

  it('review focus 1: holds autosave for a few idle seconds while the marked blocks remain, then saves them as they stand', () => {
    const conflict = conflictOf(
      'merge-conflict',
      { id: 'rev-5', n: 5, hash: 'h5', body: 'head\n', author: 'run:r-1' },
      '<<<<<<< head (rev 5, run:r-1)\nhead\n||||||| base (rev 1)\na\n=======\nmine\n>>>>>>> yours\n'
    );
    const b = docSaveConflicted(sent('mine\n'), conflict);
    // A 409 stored nothing, so the marked text still saves once the hold runs out.
    expect(docShouldSave(b)).toBe(true);
    expect(autosaveDelay(b)).toBe(CONFLICT_HOLD_MS);
    // A save in flight is waited out, not doubled.
    expect(docShouldSave(beginDocSave(b))).toBe(false);
    // Saves failing for longer than the hold keep their own backoff.
    let failing = b;
    for (let i = 0; i < 6; i += 1) {
      failing = docSaveFailed(beginDocSave(failing), 'daemon went away', false);
    }
    expect(autosaveDelay(failing)).toBe(AUTOSAVE_DEBOUNCE_MS * 64);
    const resolved = editDocBuffer(b, 'head\nmine\n');
    expect(autosaveDelay(resolved)).toBe(AUTOSAVE_DEBOUNCE_MS);
    const saved = docSaveSucceeded(
      beginDocSave(resolved),
      result('saved', { id: 'rev-6', n: 6, hash: 'h6' }),
      null
    );
    expect(saved.conflict).toBeNull();
    // Taking the head's text whole leaves nothing to save or resolve.
    const tookHead = editDocBuffer(b, 'head\n');
    expect(tookHead.conflict).toBeNull();
    expect(docShouldSave(tookHead)).toBe(false);
  });

  it('keeps the banner up after the marked text saves, until the marker lines are gone', () => {
    const marked =
      '<<<<<<< head (rev 5, run:r-1)\nhead\n=======\nmine\n>>>>>>> yours\n';
    const conflict = conflictOf(
      'merge-conflict',
      { id: 'rev-5', n: 5, hash: 'h5', body: 'head\n', author: 'run:r-1' },
      marked
    );
    const banner = { headN: 5, headAuthor: 'run:r-1' };
    const b = docSaveConflicted(sent('mine\n'), conflict);
    const saved = docSaveSucceeded(
      beginDocSave(b),
      result('amended', { id: 'rev-6', n: 6, hash: 'h6' }),
      null
    );
    expect(saved.buffer.status).toBe('clean');
    expect(saved.conflict).toEqual(banner);
    expect(editDocBuffer(editDocBuffer(saved, 'x\n'), marked).conflict).toEqual(
      banner
    );
    const newer = {
      rev: { id: 'rev-7', n: 7, hash: 'h7' },
      text: `${marked}agent\n`,
    };
    expect(reloadIfClean(saved, newer).conflict).toEqual(banner);
    const merged = docSaveSucceeded(
      beginDocSave(b),
      result(
        'merged',
        { id: 'rev-8', n: 8, hash: 'h8' },
        { id: 'rev-6', n: 6, hash: 'h6' }
      ),
      `${marked}agent\n`
    );
    expect(merged.buffer.text).toBe(`${marked}agent\n`);
    expect(merged.conflict).toEqual(banner);
    const resolved = docSaveSucceeded(
      beginDocSave(editDocBuffer(saved, 'head\nmine\n')),
      result('amended', { id: 'rev-6', n: 6, hash: 'h9' }),
      null
    );
    expect(resolved.conflict).toBeNull();
  });

  it('seals only once every save has landed and no marked blocks remain', () => {
    const clean = openDocBuffer('doc-1', 'a\n', BASE);
    expect(docSealProblem(clean)).toBeNull();
    expect(docSealProblem(editDocBuffer(clean, 'a\nb\n'))).toBe(
      'The latest text has not saved yet, so no version was saved.'
    );
    const conflict = conflictOf(
      'merge-conflict',
      { id: 'rev-5', n: 5, hash: 'h5', body: 'head\n', author: 'run:r-1' },
      '<<<<<<< head (rev 5, run:r-1)\nhead\n=======\nmine\n>>>>>>> yours\n'
    );
    const saved = docSaveSucceeded(
      beginDocSave(docSaveConflicted(sent('mine\n'), conflict)),
      result('amended', { id: 'rev-6', n: 6, hash: 'h6' }),
      null
    );
    expect(docSealProblem(saved)).toBe(
      'Resolve the marked blocks before saving a version.'
    );
  });

  it('a failed save keeps the text and reports why', () => {
    const b = docSaveFailed(sent('mine\n'), 'daemon went away', false);
    expect(b.buffer.text).toBe('mine\n');
    expect(b.buffer.status).toBe('error');
    expect(b.buffer.error).toBe('daemon went away');
  });

  it('backs autosave off while saves keep failing, and resets on success', () => {
    let b = docSaveFailed(sent('mine\n'), 'daemon went away', false);
    expect(docShouldSave(b)).toBe(true);
    expect(autosaveDelay(b)).toBe(AUTOSAVE_DEBOUNCE_MS * 2);
    b = docSaveFailed(beginDocSave(b), 'daemon went away', false);
    expect(autosaveDelay(b)).toBe(AUTOSAVE_DEBOUNCE_MS * 4);
    for (let i = 0; i < 20; i += 1) {
      b = docSaveFailed(beginDocSave(b), 'daemon went away', false);
    }
    expect(autosaveDelay(b)).toBeLessThanOrEqual(60_000);
    b = docSaveSucceeded(
      beginDocSave(b),
      result('saved', { id: 'rev-2', n: 2, hash: 'h2' }),
      null
    );
    expect(autosaveDelay(editDocBuffer(b, 'mine\nmore\n'))).toBe(
      AUTOSAVE_DEBOUNCE_MS
    );
  });

  it('a refused save waits for the next keystroke instead of retrying', () => {
    const b = docSaveFailed(sent('mine\n'), 'archived; restore it first', true);
    expect(docShouldSave(b)).toBe(false);
    const typed = editDocBuffer(b, 'mine\nmore\n');
    expect(docShouldSave(typed)).toBe(true);
    expect(autosaveDelay(typed)).toBe(AUTOSAVE_DEBOUNCE_MS);
  });

  it('counts a 4xx other than 429 as a refusal', () => {
    expect(isRefusal({ status: 409, message: 'archived' })).toBe(true);
    expect(isRefusal({ status: 400 })).toBe(true);
    expect(isRefusal({ status: 404 })).toBe(true);
    expect(isRefusal({ status: 429 })).toBe(false);
    expect(isRefusal({ status: 503 })).toBe(false);
    expect(isRefusal(new Error('fetch failed'))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  it('reloads a clean buffer on a newer head, and never a dirty one', () => {
    const read = { rev: { id: 'rev-2', n: 2, hash: 'h2' }, text: 'newer\n' };
    expect(
      reloadIfClean(openDocBuffer('doc-1', 'a\n', BASE), read).buffer.text
    ).toBe('newer\n');
    expect(
      reloadIfClean(
        editDocBuffer(openDocBuffer('doc-1', 'a\n', BASE), 'typing\n'),
        read
      ).buffer.text
    ).toBe('typing\n');
  });
});
