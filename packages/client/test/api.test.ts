import { describe, expect, it } from 'bun:test';

import { httpToWs, taskQueryString } from '../src/api';

describe('httpToWs', () => {
  it('swaps http for ws and appends /ws', () => {
    expect(httpToWs('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });

  it('swaps https for wss and appends /ws', () => {
    expect(httpToWs('https://dispatch.example')).toBe(
      'wss://dispatch.example/ws'
    );
  });
});

describe('taskQueryString', () => {
  it('returns an empty string with no filter', () => {
    expect(taskQueryString()).toBe('');
    expect(taskQueryString({})).toBe('');
  });

  it('encodes a single filter field', () => {
    expect(taskQueryString({ status: 'todo' })).toBe('?status=todo');
  });

  it('encodes multiple filter fields in status/kind/parent order', () => {
    expect(
      taskQueryString({ status: 'todo', kind: 'task', parent: 'epic-1' })
    ).toBe('?status=todo&kind=task&parent=epic-1');
  });
});
