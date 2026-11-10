// Editor keystrokes for plain textareas: markdown list continuation, line
// indent/outdent, bold/italic wrapping and code auto-indent. The edit math is
// pure (state in, `TextEdit` out) so it is unit-tested without a DOM;
// `applyTextEdit` is the one DOM step, and it goes through `execCommand` so the
// browser's own ⌘Z still undoes every change.

import type { KeyboardEvent } from 'react';

/** `markdown` for prose fields, `code` for the Files editor. */
export type TextEditingMode = 'markdown' | 'code';

export type TextState = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

/** Replace `value[from, to)` with `insert`, then select `[selectionStart, selectionEnd)`. */
export type TextEdit = {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
};

// Indent, bullet or number, optional task box, then the spacing before the text.
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])( \[[ xX]\])?( +)/;

function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndOf(value: string, pos: number): number {
  const end = value.indexOf('\n', pos);
  return end === -1 ? value.length : end;
}

// The lines a selection touches. A selection ending at the very start of a line
// (a triple-click, a shift-down) does not include that line.
function selectedLines(s: TextState): { start: number; end: number } {
  const lastPos =
    s.selectionEnd > s.selectionStart && s.value[s.selectionEnd - 1] === '\n'
      ? s.selectionEnd - 1
      : s.selectionEnd;
  return {
    start: lineStartOf(s.value, s.selectionStart),
    end: lineEndOf(s.value, lastPos),
  };
}

/** Whether the caret's line is a markdown list item. */
export function onListItem(s: TextState): boolean {
  const start = lineStartOf(s.value, s.selectionStart);
  return LIST_ITEM.test(s.value.slice(start, lineEndOf(s.value, start)));
}

/**
 * Enter on a list item: start the next item with the same indent and bullet
 * (numbers count up, task boxes come back unchecked). Enter on an empty item
 * ends the list by clearing its marker. Null when the caret is not past a list
 * marker, so the textarea inserts a plain newline.
 */
export function continueMarkdownList(s: TextState): TextEdit | null {
  if (s.selectionStart !== s.selectionEnd) return null;
  const caret = s.selectionStart;
  const start = lineStartOf(s.value, caret);
  const line = s.value.slice(start, lineEndOf(s.value, caret));
  const match = LIST_ITEM.exec(line);
  if (match === null || caret < start + match[0].length) return null;
  const [prefix, indent, bullet, box, spacing] = match;
  if (line.trim() === prefix.trim()) {
    return {
      from: start,
      to: start + line.length,
      insert: '',
      selectionStart: start,
      selectionEnd: start,
    };
  }
  const number = /^(\d+)([.)])$/.exec(bullet);
  const nextBullet =
    number === null ? bullet : `${Number(number[1]) + 1}${number[2]}`;
  const insert = `\n${indent}${nextBullet}${box === undefined ? '' : ' [ ]'}${spacing}`;
  return {
    from: caret,
    to: caret,
    insert,
    selectionStart: caret + insert.length,
    selectionEnd: caret + insert.length,
  };
}

/** Enter in code: the new line starts at the current line's indentation. */
export function continueIndent(s: TextState): TextEdit {
  const start = lineStartOf(s.value, s.selectionStart);
  const indent = /^[ \t]*/.exec(s.value.slice(start, s.selectionStart))?.[0];
  const insert = `\n${indent ?? ''}`;
  const caret = s.selectionStart + insert.length;
  return {
    from: s.selectionStart,
    to: s.selectionEnd,
    insert,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

// How much indentation one leading `unit` (or a stray tab) accounts for.
function leadingIndentLength(line: string, unit: string): number {
  if (line.startsWith(unit)) return unit.length;
  if (line.startsWith('\t')) return 1;
  return Math.min(/^ */.exec(line)?.[0].length ?? 0, unit.length);
}

/**
 * Tab / Shift+Tab over the selected lines: add or remove one `unit` of
 * indentation at the start of each, keeping the selection over the same text.
 */
export function shiftLines(
  s: TextState,
  unit: string,
  direction: 'in' | 'out'
): TextEdit | null {
  const { start, end } = selectedLines(s);
  const lines = s.value.slice(start, end).split('\n');
  const deltas = lines.map((line) =>
    direction === 'in' ? unit.length : -leadingIndentLength(line, unit)
  );
  if (deltas.every((d) => d === 0)) return null;
  const insert = lines
    .map((line, i) =>
      direction === 'in' ? unit + line : line.slice(-deltas[i])
    )
    .join('\n');
  // A selection from column 0 keeps covering the whole line; nothing moves
  // left of the first line's start.
  const keepsLineStart =
    s.selectionStart === start && s.selectionEnd > s.selectionStart;
  const firstDelta = keepsLineStart ? 0 : deltas[0];
  const total = deltas.reduce((sum, d) => sum + d, 0);
  return {
    from: start,
    to: end,
    insert,
    selectionStart: Math.max(start, s.selectionStart + firstDelta),
    selectionEnd: Math.max(start, s.selectionEnd + total),
  };
}

/** Tab with a collapsed caret in code: type one indent unit. */
export function insertIndent(s: TextState, unit: string): TextEdit {
  const caret = s.selectionStart + unit.length;
  return {
    from: s.selectionStart,
    to: s.selectionEnd,
    insert: unit,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

/**
 * ⌘B / ⌘I: wrap the selection in `marker`, or unwrap it when it already is
 * (markers just outside or just inside the selection). A bare caret gets an
 * empty pair with the caret between.
 */
export function toggleWrap(s: TextState, marker: string): TextEdit {
  const { value, selectionStart: from, selectionEnd: to } = s;
  const n = marker.length;
  const selected = value.slice(from, to);
  if (
    value.slice(from - n, from) === marker &&
    value.slice(to, to + n) === marker
  ) {
    return {
      from: from - n,
      to: to + n,
      insert: selected,
      selectionStart: from - n,
      selectionEnd: to - n,
    };
  }
  if (
    selected.length >= 2 * n &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(n, -n);
    return {
      from,
      to,
      insert: inner,
      selectionStart: from,
      selectionEnd: from + inner.length,
    };
  }
  return {
    from,
    to,
    insert: `${marker}${selected}${marker}`,
    selectionStart: from + n,
    selectionEnd: to + n,
  };
}

/**
 * The indent a file already uses: a tab if its indented lines start with tabs,
 * else its narrowest space indent (2 or 4), else two spaces.
 */
export function detectIndentUnit(value: string): string {
  let tabs = 0;
  let narrowest = Infinity;
  for (const line of value.split('\n', 500)) {
    if (line.startsWith('\t')) tabs += 1;
    const spaces = /^ +(?=\S)/.exec(line)?.[0].length;
    if (spaces !== undefined && spaces >= 2) {
      narrowest = Math.min(narrowest, spaces);
    }
  }
  if (tabs > 0 && narrowest === Infinity) return '\t';
  return narrowest === 4 ? '    ' : '  ';
}

/**
 * Applies an edit as if typed: `execCommand('insertText')` lands it on the
 * native undo stack and fires the input event React's onChange listens for.
 * Where that command is missing, `setRangeText` plus a synthetic input event
 * does the same minus undo.
 */
export function applyTextEdit(el: HTMLTextAreaElement, edit: TextEdit): void {
  el.setSelectionRange(edit.from, edit.to);
  let applied = false;
  if (typeof document.execCommand === 'function') {
    applied =
      edit.insert === ''
        ? edit.from === edit.to || document.execCommand('delete')
        : document.execCommand('insertText', false, edit.insert);
  }
  if (!applied) {
    el.setRangeText(edit.insert, edit.from, edit.to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

/**
 * Resolves a keystroke to an edit for `mode`, or null to leave it to the
 * textarea. Markdown only claims Tab on list lines or multi-line selections,
 * so Tab still moves focus out of an ordinary prose field.
 */
export function resolveTextEditingKey(
  key: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  },
  s: TextState,
  mode: TextEditingMode,
  indentUnit = '  '
): TextEdit | null {
  const mod = key.metaKey || key.ctrlKey;
  if (key.key === 'Enter' && !mod && !key.altKey) {
    return mode === 'code' ? continueIndent(s) : continueMarkdownList(s);
  }
  if (key.key === 'Tab' && !mod && !key.altKey) {
    const multiLine = s.value
      .slice(s.selectionStart, s.selectionEnd)
      .includes('\n');
    if (mode === 'markdown' && !multiLine && !onListItem(s)) return null;
    if (key.shiftKey) return shiftLines(s, indentUnit, 'out');
    if (mode === 'code' && !multiLine) return insertIndent(s, indentUnit);
    return shiftLines(s, indentUnit, 'in');
  }
  if (mode === 'markdown' && mod && !key.altKey && !key.shiftKey) {
    const lower = key.key.toLowerCase();
    if (lower === 'b') return toggleWrap(s, '**');
    if (lower === 'i') return toggleWrap(s, '_');
  }
  return null;
}

/**
 * The textarea `onKeyDown` step: resolves and applies the edit, and reports
 * whether it handled the key. Keys mid-IME-composition are never touched.
 */
export function handleTextEditingKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  mode: TextEditingMode,
  indentUnit?: string
): boolean {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return false;
  const el = event.currentTarget;
  const edit = resolveTextEditingKey(event, el, mode, indentUnit);
  if (edit === null) return false;
  event.preventDefault();
  applyTextEdit(el, edit);
  return true;
}
