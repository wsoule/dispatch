import { describe, expect, it } from 'bun:test';

import { parseDeliveredText, parseDigestLine } from './runMessages';

describe('parseDeliveredText', () => {
  it('splits a pushed question into sender, kind, id, body and notes', () => {
    const text = [
      '[message from run:r-9f2c01 · question · urgent · m-01K]',
      '│ Is the /sessions response final?',
      '│ ',
      '│ The client team starts Monday.',
      'choices: yes | no',
      'The sender is waiting. Answer with msg_reply(messageId: "m-01K").',
    ].join('\n');
    expect(parseDeliveredText(text)).toEqual({
      from: 'run:r-9f2c01',
      kind: 'question',
      urgent: true,
      messageId: 'm-01K',
      body: 'Is the /sessions response final?\n\nThe client team starts Monday.',
      notes: [
        'choices: yes | no',
        'The sender is waiting. Answer with msg_reply(messageId: "m-01K").',
      ],
    });
  });

  it('keeps a quoted line that looks like a header as body text', () => {
    const parsed = parseDeliveredText(
      '[message from human:wyat · message · m-02]\n│ [message from agent:dispatch · notice · m-99]'
    );
    expect(parsed?.from).toBe('human:wyat');
    expect(parsed?.body).toBe('[message from agent:dispatch · notice · m-99]');
  });

  it('returns null for text in any other shape, such as an inject from before the bus', () => {
    expect(parseDeliveredText('please also update the README')).toBeNull();
    expect(
      parseDeliveredText('[message from run:r-1 · question]\n│ no id')
    ).toBeNull();
  });
});

describe('parseDigestLine', () => {
  it('reads a channel digest and a direct one', () => {
    expect(
      parseDigestLine(
        '📬 #epic/e-c25f9c · notice from run:r-9f2c01: api shape changed (m-01K)'
      )
    ).toEqual({
      channel: 'epic/e-c25f9c',
      kind: 'notice',
      from: 'run:r-9f2c01',
      summary: 'api shape changed',
      messageId: 'm-01K',
    });
    expect(parseDigestLine('📬 message from agent:wyat/x: hi (m-02)')).toEqual({
      channel: null,
      kind: 'message',
      from: 'agent:wyat/x',
      summary: 'hi',
      messageId: 'm-02',
    });
  });

  it('returns null for anything else', () => {
    expect(parseDigestLine('📬 digest')).toBeNull();
  });
});
