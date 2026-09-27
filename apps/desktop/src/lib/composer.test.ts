import { ApiError } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import type { ComposeKind, ComposeState } from './composer';
import {
  composeProblem,
  dropTrailingMention,
  fieldLabel,
  problemText,
  resolveMention,
  sendProblem,
  toSendInput,
  trailingMention,
  wakeDefault,
} from './composer';

describe('mentions', () => {
  it('finds the @token being typed at the end, and nothing mid-word or already finished', () => {
    expect(trailingMention('ping @t-1a')).toEqual({ start: 5, query: 't-1a' });
    expect(trailingMention('@')).toEqual({ start: 0, query: '' });
    expect(trailingMention('mail me@work')).toBeNull();
    expect(trailingMention('@t-1a done')).toBeNull();
    expect(dropTrailingMention('ping @t-1a')).toBe('ping ');
  });

  it('picks the highlighted match, accepts a typed kind:id, and blames `to` for anything else', () => {
    const matches = [
      { address: 'task:t-1a2b3c' },
      { address: 'task:t-1a9999' },
    ];
    expect(resolveMention('t-1a', matches, 1)).toEqual({
      kind: 'address',
      address: 'task:t-1a9999',
    });
    expect(resolveMention('t-1a', matches, null)).toEqual({
      kind: 'address',
      address: 'task:t-1a2b3c',
    });
    expect(resolveMention('task:t-zzzzzz', [], null)).toEqual({
      kind: 'address',
      address: 'task:t-zzzzzz',
    });
    const miss = resolveMention('bogus', [], null);
    expect(miss.kind === 'problem' ? miss.problem.field : null).toBe('to');
    expect(miss.kind === 'problem' ? miss.problem.message : '').toContain(
      '@bogus'
    );
  });

  it('takes a complete typed address that is listed over the first match, unless one was picked', () => {
    const people = [{ address: 'human:adam' }, { address: 'human:ada' }];
    expect(resolveMention('human:ada', people, null)).toEqual({
      kind: 'address',
      address: 'human:ada',
    });
    expect(resolveMention('Human:Ada', people, null)).toEqual({
      kind: 'address',
      address: 'human:ada',
    });
    expect(resolveMention('human:ada', people, 0)).toEqual({
      kind: 'address',
      address: 'human:adam',
    });
    const rooms = [
      { address: 'channel:general-2' },
      { address: 'channel:general' },
    ];
    expect(resolveMention('#general', rooms, null)).toEqual({
      kind: 'address',
      address: 'channel:general',
    });
  });
});

describe('drafts', () => {
  const draft: ComposeState = {
    to: ['task:t-1a2b3c'],
    body: 'hi',
    kind: 'message',
    urgent: false,
    wake: true,
  };

  it('blocks an unfinished @token, no recipient and an empty body, in that order', () => {
    expect(composeProblem({ ...draft, body: 'hi @bog' })?.field).toBe('to');
    expect(composeProblem({ ...draft, to: [] })?.field).toBe('to');
    expect(composeProblem({ ...draft, body: '   ' })?.field).toBe('body');
    expect(composeProblem(draft)).toBeNull();
  });

  it('makes a question blocking, marks urgency only when set, and maps wake', () => {
    expect(toSendInput({ ...draft, kind: 'question', urgent: true })).toEqual({
      to: ['task:t-1a2b3c'],
      kind: 'question',
      body: 'hi',
      urgent: true,
      blocking: true,
      wake: 'request',
    });
    expect(toSendInput({ ...draft, wake: false })).toEqual({
      to: ['task:t-1a2b3c'],
      kind: 'message',
      body: 'hi',
      wake: 'none',
    });
    expect(wakeDefault(['human:ada'])).toBe(false);
    expect(wakeDefault(['human:ada', 'task:t-1a2b3c'])).toBe(true);
  });

  it('sends each kind as itself, and only a question blocks', () => {
    const kinds: ComposeKind[] = ['message', 'question', 'notice'];
    expect(
      kinds.map((kind) => {
        const input = toSendInput({ ...draft, kind });
        return [input.kind, input.blocking === true];
      })
    ).toEqual([
      ['message', false],
      ['question', true],
      ['notice', false],
    ]);
  });
});

describe('send errors', () => {
  it("names the daemon's field in words", () => {
    const problem = sendProblem(
      new ApiError(
        'invalid address "task:t-zzzzzz": not a task id',
        400,
        undefined,
        'to[0]'
      )
    );
    expect(problemText(problem)).toBe(
      'Recipient 1: invalid address "task:t-zzzzzz": not a task id'
    );
  });

  it('names the field once when the daemon already led with it', () => {
    const choice = sendProblem(
      new ApiError(
        'choice: choose one of accept, decline',
        400,
        undefined,
        'choice'
      )
    );
    expect(problemText(choice)).toBe('Choice: choose one of accept, decline');
    const body = sendProblem(
      new ApiError('body: required', 400, undefined, 'body')
    );
    expect(problemText(body)).toBe('Message: required');
  });

  it('numbers indexed fields from one and names the rest, leaving unknown ones as sent', () => {
    expect(fieldLabel('refs[1]')).toBe('Reference 2');
    expect(fieldLabel('choices[0]')).toBe('Choice 1');
    expect(fieldLabel('body')).toBe('Message');
    expect(fieldLabel('about')).toBe('about');
  });

  it('reads a lost answer race as a reply problem, and anything else as a send problem', () => {
    expect(
      sendProblem(new ApiError('question m-1 already has an answer', 409)).field
    ).toBe('replyTo');
    expect(sendProblem(new Error('offline'))).toEqual({
      field: 'send',
      message: 'offline',
    });
  });
});
