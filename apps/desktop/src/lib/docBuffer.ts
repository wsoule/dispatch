import type { DocConflict, DocSaveResult } from '@dispatch/client';

import type { EditorBuffer } from './editorBuffer';
import {
  AUTOSAVE_DEBOUNCE_MS,
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
  // Saves failed in a row, which back autosave off.
  failures: number;
  // The daemon refused the last save (a 4xx); autosave waits for the next keystroke.
  refused: boolean;
}

// The marker lines a 409's text carries (Merge's labels), so autosave waits for
// them to be resolved instead of saving them into the doc.
const CONFLICT_MARKER = /^(?:<{7} head \(rev |\|{7} base \(rev |>{7} yours$)/m;

export function openDocBuffer(
  doc: string,
  text: string,
  base: DocBase
): DocBuffer {
  return {
    doc,
    buffer: openBuffer(doc, text),
    base,
    conflict: null,
    failures: 0,
    refused: false,
  };
}

// A keystroke, which also retries a refused save. Editing back to the head's
// text settles a conflict: nothing is left to save.
export function editDocBuffer(b: DocBuffer, text: string): DocBuffer {
  const buffer = editBuffer(b.buffer, text);
  return {
    ...b,
    buffer,
    conflict: buffer.status === 'clean' ? null : b.conflict,
    failures: 0,
    refused: false,
  };
}

// Whether leaving the doc should send its text: marked blocks and all, since a
// 409 stored nothing and the buffer is the only copy of the caller's side.
export function docShouldFlush(b: DocBuffer): boolean {
  return !b.refused && shouldSave(b.buffer);
}

export function docShouldSave(b: DocBuffer): boolean {
  if (b.conflict !== null && CONFLICT_MARKER.test(b.buffer.text)) return false;
  return docShouldFlush(b);
}

// The autosave wait: the debounce, doubled per failed save up to about 40 s.
export function autosaveDelay(b: DocBuffer): number {
  return AUTOSAVE_DEBOUNCE_MS * 2 ** Math.min(b.failures, 6);
}

// A 4xx other than 429 is the daemon refusing the save (archived, deleted,
// too large); sending the same text again cannot succeed.
export function isRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  );
}

export function beginDocSave(b: DocBuffer): DocBuffer {
  return { ...b, buffer: beginSave(b.buffer) };
}

// A merged save with nothing typed since reloads the merged head; with typing
// since, the next save bases on its own revision so the merge keeps both sides.
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
      failures: 0,
    };
  }
  return {
    ...b,
    buffer: saveSucceeded(b.buffer),
    base: { rev: result.rev.id, n: result.rev.n, hash: result.rev.hash },
    conflict: null,
    failures: 0,
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
    failures: 0,
    refused: false,
  };
}

export function docSaveFailed(
  b: DocBuffer,
  message: string,
  refused: boolean
): DocBuffer {
  return {
    ...b,
    buffer: saveFailed(b.buffer, message),
    failures: b.failures + 1,
    refused,
  };
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
