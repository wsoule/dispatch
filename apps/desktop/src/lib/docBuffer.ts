import type { DocConflict, DocSaveResult } from '@dispatch/client';

import type { EditorBuffer } from './editorBuffer';
import {
  beginSave,
  editBuffer,
  openBuffer,
  saveFailed,
  saveSucceeded,
  shouldSave,
} from './editorBuffer';

// A doc open in the editor: the Files view's buffer plus the revision its text
// is based on, which every save names so the server can merge a stale save.

interface DocBase {
  rev: string;
  n: number | null;
  hash: string;
}

export interface DocBuffer {
  doc: string;
  buffer: EditorBuffer;
  base: DocBase;
  conflict: { headN: number; headAuthor: string } | null;
}

// The marker lines a 409's text carries (Merge's labels), so autosave waits for
// them to be resolved instead of saving them into the doc.
const CONFLICT_MARKER = /^(?:<{7} head \(rev |\|{7} base \(rev |>{7} yours$)/m;

export function openDocBuffer(
  doc: string,
  text: string,
  base: DocBase
): DocBuffer {
  return { doc, buffer: openBuffer(doc, text), base, conflict: null };
}

// A keystroke. Editing back to the head's text settles a conflict: nothing is left to save.
export function editDocBuffer(b: DocBuffer, text: string): DocBuffer {
  const buffer = editBuffer(b.buffer, text);
  return {
    ...b,
    buffer,
    conflict: buffer.status === 'clean' ? null : b.conflict,
  };
}

export function docShouldSave(b: DocBuffer): boolean {
  if (b.conflict !== null && CONFLICT_MARKER.test(b.buffer.text)) return false;
  return shouldSave(b.buffer);
}

export function beginDocSave(b: DocBuffer): DocBuffer {
  return { ...b, buffer: beginSave(b.buffer) };
}

// A save came back. A merged save with nothing typed since reloads the merged
// head; with typing since, the next save is based on this save's own revision,
// or the merge would win wholesale and drop the other side's edit.
export function docSaveSucceeded(
  b: DocBuffer,
  result: DocSaveResult,
  headBody: string | null
): DocBuffer {
  const typedSince = b.buffer.text !== b.buffer.inFlightText;
  if (result.status === 'merged') {
    if (!typedSince && headBody !== null) {
      return openDocBuffer(b.doc, headBody, {
        rev: result.rev.id,
        n: result.rev.n,
        hash: result.rev.hash,
      });
    }
    const mine = result.mine ?? result.rev;
    return {
      ...b,
      buffer: saveSucceeded(b.buffer),
      base: { rev: mine.id, n: mine.n, hash: mine.hash },
      conflict: null,
    };
  }
  return {
    ...b,
    buffer: saveSucceeded(b.buffer),
    base: { rev: result.rev.id, n: result.rev.n, hash: result.rev.hash },
    conflict: null,
  };
}

// The head and the caller's text as one marked block, for a 409 whose marked
// text would drop typing: a base-changed answer, or keys pressed mid-save.
function markedWhole(
  head: { n: number; author: string; body: string },
  mine: string
): string {
  const closed = (t: string): string =>
    t === '' || t.endsWith('\n') ? t : `${t}\n`;
  return `<<<<<<< head (rev ${head.n}, ${head.author})\n${closed(head.body)}=======\n${closed(mine)}>>>>>>> yours\n`;
}

// A 409: the marked text replaces the buffer, based on the head it was marked
// against; text the answer does not hold goes beside the head instead.
export function docSaveConflicted(
  b: DocBuffer,
  conflict: DocConflict
): DocBuffer {
  const { head } = conflict;
  const mine = b.buffer.text;
  const typedSince = mine !== b.buffer.inFlightText;
  let text = conflict.marked;
  if (mine === head.body) text = head.body;
  else if (conflict.reason === 'base-changed' || typedSince) {
    text = markedWhole(head, mine);
  }
  return {
    doc: b.doc,
    buffer: editBuffer(openBuffer(b.doc, head.body), text),
    base: { rev: head.id, n: head.n, hash: head.hash },
    conflict:
      text === head.body ? null : { headN: head.n, headAuthor: head.author },
  };
}

export function docSaveFailed(b: DocBuffer, message: string): DocBuffer {
  return { ...b, buffer: saveFailed(b.buffer, message) };
}

// doc.changed: a clean buffer follows the new head; a dirty one keeps typing
// and its next save merges on the server.
export function reloadIfClean(
  b: DocBuffer,
  read: { rev: { id: string; n: number | null; hash: string }; text: string }
): DocBuffer {
  if (
    b.buffer.status !== 'clean' ||
    (read.rev.id === b.base.rev && read.rev.hash === b.base.hash)
  ) {
    return b;
  }
  return openDocBuffer(b.doc, read.text, {
    rev: read.rev.id,
    n: read.rev.n,
    hash: read.rev.hash,
  });
}
