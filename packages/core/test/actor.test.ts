import { describe, expect, it } from 'bun:test';

import {
  ActorRefError,
  formatActorRef,
  isValidAssignee,
  parseActorRef,
} from '../src/actor.js';

describe('parseActorRef', () => {
  it('returns null for the unassigned value', () => {
    expect(parseActorRef('none')).toBeNull();
  });

  it('parses the legacy unspecified values', () => {
    expect(parseActorRef('human')).toEqual({
      kind: 'human',
      handle: null,
      operator: null,
    });
    expect(parseActorRef('agent')).toEqual({
      kind: 'agent',
      handle: null,
      operator: null,
    });
  });

  it('parses a named human', () => {
    expect(parseActorRef('human:wyat')).toEqual({
      kind: 'human',
      handle: 'wyat',
      operator: null,
    });
  });

  it('parses an operator-scoped agent', () => {
    expect(parseActorRef('agent:wyat/claude')).toEqual({
      kind: 'agent',
      handle: 'claude',
      operator: 'wyat',
    });
  });

  it('parses a standing agent with no operator', () => {
    expect(parseActorRef('agent:reviewer')).toEqual({
      kind: 'agent',
      handle: 'reviewer',
      operator: null,
    });
  });

  it('rejects an unknown kind', () => {
    expect(() => parseActorRef('robot:x')).toThrow(ActorRefError);
  });

  it('rejects a handle with illegal characters', () => {
    expect(() => parseActorRef('human:Wyat Soule')).toThrow(ActorRefError);
  });

  it('rejects an empty handle', () => {
    expect(() => parseActorRef('human:')).toThrow(ActorRefError);
  });

  it('rejects a human with an operator segment', () => {
    expect(() => parseActorRef('human:a/b')).toThrow(ActorRefError);
  });
});

describe('formatActorRef', () => {
  it('round-trips every valid form', () => {
    for (const raw of [
      'none',
      'human',
      'agent',
      'human:wyat',
      'agent:reviewer',
      'agent:wyat/claude',
    ]) {
      expect(formatActorRef(parseActorRef(raw))).toBe(raw);
    }
  });
});

describe('isValidAssignee', () => {
  it('accepts valid forms and rejects malformed ones', () => {
    expect(isValidAssignee('agent:wyat/claude')).toBe(true);
    expect(isValidAssignee('none')).toBe(true);
    expect(isValidAssignee('robot:x')).toBe(false);
  });
});
