import { describe, expect, test } from 'bun:test';

import { draftFromParams, taskFromText } from '../src/tasks';

describe('a task from typed text', () => {
  test('takes the first line as the title and the rest as the description', () => {
    expect(
      taskFromText('Fix the flaky merge-queue test\n\nIt fails one run in ten.')
    ).toEqual({
      ok: true,
      input: {
        title: 'Fix the flaky merge-queue test',
        description: 'It fails one run in ten.',
      },
    });
  });

  test('sends no description for a one-line task', () => {
    expect(taskFromText('  Rename the Mac tab  \n\n')).toEqual({
      ok: true,
      input: { title: 'Rename the Mac tab' },
    });
  });

  test('skips leading blank lines and a note heading or bullet', () => {
    const result = taskFromText('\n\n# Upgrade Expo\n- check the camera');
    expect(result).toEqual({
      ok: true,
      input: { title: 'Upgrade Expo', description: '- check the camera' },
    });
    expect(taskFromText('• Tidy the run log')).toEqual({
      ok: true,
      input: { title: 'Tidy the run log' },
    });
  });

  test('cuts a long first line at a word and keeps it whole below', () => {
    const line = `Make the ${'very '.repeat(40)}long title fit`;
    const result = taskFromText(`${line}\nmore`);
    if (!result.ok) throw new Error(result.error);
    expect(result.input.title.length).toBeLessThanOrEqual(120);
    expect(result.input.title.endsWith('very…')).toBe(true);
    expect(result.input.description).toBe(`${line}\n\nmore`);
  });

  test('refuses nothing but whitespace', () => {
    expect(taskFromText(' \n\t\n')).toEqual({
      ok: false,
      error: 'Write what the task is first.',
    });
  });

  test('reads Windows and old Mac line endings', () => {
    expect(taskFromText('Title\r\nBody\rMore')).toEqual({
      ok: true,
      input: { title: 'Title', description: 'Body\nMore' },
    });
  });
});

describe('the New task form from a link', () => {
  test('puts a shared page title first and its address below', () => {
    expect(
      draftFromParams({
        title: 'Checkout crashes on Safari',
        url: 'https://example.com/bug/12',
      })
    ).toBe('Checkout crashes on Safari\n\nhttps://example.com/bug/12');
  });

  test('takes plain shared text, and drops a repeated part', () => {
    expect(draftFromParams({ text: 'Look at this' })).toBe('Look at this');
    expect(
      draftFromParams({ text: 'https://a.example', url: 'https://a.example' })
    ).toBe('https://a.example');
  });

  test('ignores repeated params and anything it does not know', () => {
    expect(draftFromParams({ text: ['a', 'b'], dispatch: 'now' })).toBe('');
  });

  test('keeps what a link may fill in to a readable draft', () => {
    expect(draftFromParams({ text: 'x'.repeat(10_000) }).length).toBe(4000);
  });
});
