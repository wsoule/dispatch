import type { NormalizedEntry } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { gutterTag, gutterTone } from './transcriptGutter';

function entry(over: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return { ts: '2026-07-27T00:00:00.000Z', kind: 'assistant', ...over };
}

describe('gutterTag', () => {
  test.each([
    ['Read', 'read'],
    ['Glob', 'read'],
    ['Grep', 'read'],
    ['WebFetch', 'read'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['MultiEdit', 'edit'],
    ['Bash', 'run'],
  ] as [string, ReturnType<typeof gutterTag>][])(
    '%s -> %s',
    (toolName, expected) => {
      expect(gutterTag(entry({ kind: 'tool', toolName }))).toBe(expected);
    }
  );

  // An unknown tool is likelier to do something than to merely look, so the safer default is
  // the tag that draws the eye.
  test('an unrecognised tool reads as run, not read', () => {
    expect(gutterTag(entry({ kind: 'tool', toolName: 'SomeNewTool' }))).toBe(
      'run'
    );
  });

  test('a tool with no name still gets a tag', () => {
    expect(gutterTag(entry({ kind: 'tool' }))).toBe('run');
  });

  test.each([
    ['thinking', 'think'],
    ['assistant', 'says'],
    ['system', 'sys'],
    ['usage', 'sys'],
  ] as [NormalizedEntry['kind'], ReturnType<typeof gutterTag>][])(
    '%s -> %s',
    (kind, expected) => {
      expect(gutterTag(entry({ kind }))).toBe(expected);
    }
  );

  test('a user message is the human steering', () => {
    expect(gutterTag(entry({ kind: 'message', from: 'user' }))).toBe('you');
  });

  // An inbound message from another run is not the human, and must not be accented as though
  // it were — you need to be able to find your own interjections.
  test('a message from another agent is not marked as yours', () => {
    expect(gutterTag(entry({ kind: 'message', from: 'agent' }))).toBe('says');
  });
});

describe('gutterTone', () => {
  test('thinking recedes because it is context, not action', () => {
    expect(gutterTone(entry({ kind: 'thinking' }))).toBe('muted');
  });

  test('your own turns are accented so you can find them', () => {
    expect(gutterTone(entry({ kind: 'message', from: 'user' }))).toBe('accent');
  });

  test('a command that passed reads as passed', () => {
    expect(
      gutterTone(entry({ kind: 'tool', toolName: 'Bash', status: 'done' }))
    ).toBe('good');
  });

  // The one thing you always want to find in a transcript, so it outranks every other rule.
  test('a failure outranks whatever the tag would otherwise be', () => {
    expect(gutterTone(entry({ kind: 'thinking', status: 'error' }))).toBe(
      'bad'
    );
    expect(
      gutterTone(entry({ kind: 'message', from: 'user', status: 'error' }))
    ).toBe('bad');
  });

  test('an ordinary read is unemphasised', () => {
    expect(gutterTone(entry({ kind: 'tool', toolName: 'Read' }))).toBe(
      'normal'
    );
  });

  test('a still-running command is not yet marked as passed', () => {
    expect(
      gutterTone(entry({ kind: 'tool', toolName: 'Bash', status: 'running' }))
    ).toBe('normal');
  });
});
