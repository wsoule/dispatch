import { describe, expect, it } from 'bun:test';

import {
  isAgentAuthored,
  parseAddress,
  SYSTEM_ADDRESS,
} from '../src/address.js';
import { MessagingError } from '../src/errors.js';

describe('parseAddress', () => {
  it.each([
    ['human:wyat', { kind: 'human', handle: 'wyat' }],
    [
      'agent:wyat/claude-code.macbook',
      { kind: 'agent', handle: 'claude-code.macbook', operator: 'wyat' },
    ],
    ['agent:dispatch', { kind: 'agent', handle: 'dispatch', operator: null }],
    ['task:t-4a8cce', { kind: 'task', id: 't-4a8cce' }],
    ['task:e-c25f9c', { kind: 'task', id: 'e-c25f9c' }],
    ['run:r-9f2c01', { kind: 'run', id: 'r-9f2c01' }],
    ['channel:epic/e-c25f9c', { kind: 'channel', name: 'epic/e-c25f9c' }],
    ['channel:auth-refactor', { kind: 'channel', name: 'auth-refactor' }],
  ])('parses %s', (raw, expected) => {
    expect(parseAddress(raw)).toEqual({ ...expected, address: raw } as never);
  });

  it.each([
    '',
    'human',
    'agent',
    'human:Wyat',
    'human:wyat/x',
    'task:t-XYZ',
    'task:4a8cce',
    'run:9f2c01',
    'channel:',
    'channel:a//b',
    'channel:a/',
    'channel:/a',
    'robot:x',
  ])('rejects %j with the field name', (raw) => {
    try {
      parseAddress(raw, 'to[0]');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MessagingError);
      expect((err as MessagingError).code).toBe('invalid');
      expect((err as MessagingError).field).toBe('to[0]');
    }
  });
});

describe('isAgentAuthored', () => {
  it('counts runs and agents but not humans or the system', () => {
    expect(isAgentAuthored('run:r-000001')).toBe(true);
    expect(isAgentAuthored('agent:wyat/claude')).toBe(true);
    expect(isAgentAuthored(SYSTEM_ADDRESS)).toBe(false);
    expect(isAgentAuthored('human:wyat')).toBe(false);
  });
});
