import { expect, test } from 'bun:test';

import {
  continueMarkdownList,
  detectIndentUnit,
  resolveTextEditingKey,
  shiftLines,
  type TextEdit,
  type TextEditingMode,
  type TextState,
  toggleWrap,
} from './textEditing';

// `[` and `]` mark the selection (a lone `|` is a caret), so each case reads
// as before → after.
function state(marked: string): TextState {
  if (marked.includes('|')) {
    const at = marked.indexOf('|');
    return {
      value: marked.replace('|', ''),
      selectionStart: at,
      selectionEnd: at,
    };
  }
  const from = marked.indexOf('[');
  const to = marked.indexOf(']') - 1;
  return {
    value: marked.replace('[', '').replace(']', ''),
    selectionStart: from,
    selectionEnd: to,
  };
}

function render(s: TextState, edit: TextEdit | null): string | null {
  if (edit === null) return null;
  const value =
    s.value.slice(0, edit.from) + edit.insert + s.value.slice(edit.to);
  if (edit.selectionStart === edit.selectionEnd) {
    return `${value.slice(0, edit.selectionStart)}|${value.slice(edit.selectionStart)}`;
  }
  return `${value.slice(0, edit.selectionStart)}[${value.slice(edit.selectionStart, edit.selectionEnd)}]${value.slice(edit.selectionEnd)}`;
}

function press(
  marked: string,
  key: string,
  mode: TextEditingMode,
  mods: { shift?: boolean; meta?: boolean } = {}
): string | null {
  const s = state(marked);
  return render(
    s,
    resolveTextEditingKey(
      {
        key,
        shiftKey: mods.shift === true,
        metaKey: mods.meta === true,
        ctrlKey: false,
        altKey: false,
      },
      s,
      mode
    )
  );
}

test('Enter continues bullets, numbers and task boxes', () => {
  const list = (marked: string) =>
    render(state(marked), continueMarkdownList(state(marked)));
  expect(list('- one|')).toBe('- one\n- |');
  expect(list('  * nested|')).toBe('  * nested\n  * |');
  expect(list('9. nine|')).toBe('9. nine\n10. |');
  expect(list('1) a|')).toBe('1) a\n2) |');
  expect(list('- [x] done|')).toBe('- [x] done\n- [ ] |');
});

test('Enter splits an item mid-line, and leaves non-list lines alone', () => {
  const list = (marked: string) =>
    render(state(marked), continueMarkdownList(state(marked)));
  expect(list('- ab|cd')).toBe('- ab\n- |cd');
  expect(list('plain|')).toBeNull();
  expect(list('-|')).toBeNull();
  // A caret inside the marker is not "in the item".
  expect(list('-| one')).toBeNull();
  expect(list('- [one]')).toBeNull();
});

test('Enter on an empty item ends the list', () => {
  const list = (marked: string) =>
    render(state(marked), continueMarkdownList(state(marked)));
  expect(list('- one\n- |')).toBe('- one\n|');
  expect(list('- one\n- [ ] |')).toBe('- one\n|');
  expect(list('1. a\n2. |\nafter')).toBe('1. a\n|\nafter');
});

test('Tab nests a list item and Shift+Tab lifts it, caret kept on the text', () => {
  expect(press('- one\n- tw|o', 'Tab', 'markdown')).toBe('- one\n  - tw|o');
  expect(press('- one\n  - tw|o', 'Tab', 'markdown', { shift: true })).toBe(
    '- one\n- tw|o'
  );
});

test('markdown leaves Tab to focus navigation on an ordinary line', () => {
  expect(press('plain|', 'Tab', 'markdown')).toBeNull();
  expect(press('plain|', 'Tab', 'markdown', { shift: true })).toBeNull();
});

test('Tab over several lines indents each, excluding a line the selection only touches', () => {
  expect(press('[a\nb\n]c', 'Tab', 'markdown')).toBe('[  a\n  b\n]c');
  expect(shiftLines(state('[  a\n b\nc]'), '  ', 'out')).toEqual({
    from: 0,
    to: 8,
    insert: 'a\nb\nc',
    selectionStart: 0,
    selectionEnd: 5,
  });
  expect(shiftLines(state('[a\nb]'), '  ', 'out')).toBeNull();
});

test('code: Tab types an indent, Enter keeps the line indentation', () => {
  expect(press('if (x) {|', 'Tab', 'code')).toBe('if (x) {  |');
  expect(press('  if (x) {|', 'Enter', 'code')).toBe('  if (x) {\n  |');
  expect(press('\tfoo[bar]', 'Enter', 'code')).toBe('\tfoo\n\t|');
  expect(press('    x|', 'Tab', 'code', { shift: true })).toBe('  x|');
});

test('code mode has no bold or italic', () => {
  expect(press('[x]', 'b', 'code', { meta: true })).toBeNull();
});

test('⌘B and ⌘I wrap, and unwrap what is already wrapped', () => {
  expect(press('a [word] b', 'b', 'markdown', { meta: true })).toBe(
    'a **[word]** b'
  );
  expect(press('a **[word]** b', 'b', 'markdown', { meta: true })).toBe(
    'a [word] b'
  );
  expect(
    render(state('[**word**]'), toggleWrap(state('[**word**]'), '**'))
  ).toBe('[word]');
  expect(press('x|', 'i', 'markdown', { meta: true })).toBe('x_|_');
});

test('detectIndentUnit follows the file', () => {
  expect(detectIndentUnit('a\n\tb\n')).toBe('\t');
  expect(detectIndentUnit('a\n    b\n        c')).toBe('    ');
  expect(detectIndentUnit('a\n  b\n    c')).toBe('  ');
  expect(detectIndentUnit('no indent')).toBe('  ');
});
