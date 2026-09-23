import { describe, expect, it } from 'bun:test';

import type { Message } from '../src/envelope.js';
import { renderDigestLine, renderForAgent } from '../src/render.js';

const m: Message = {
  id: 'm-01abc',
  thread: 'm-01abc',
  replyTo: null,
  from: 'run:r-000001',
  to: ['channel:epic/e-000001'],
  kind: 'question',
  body: 'Did you change the API shape?\nsecond line',
  refs: [{ type: 'file', id: 'src/api.ts', at: 'abc123' }],
  urgent: true,
  blocking: true,
  choices: ['yes', 'no'],
  wake: 'none',
  createdAt: '2026-09-23T10:00:00.000Z',
};

describe('renderForAgent', () => {
  it('labels sender, kind, urgency and id, then body, choices, refs and reply hint', () => {
    expect(renderForAgent(m)).toBe(
      [
        '[message from run:r-000001 · question · urgent · m-01abc]',
        'Did you change the API shape?\nsecond line',
        'choices: yes | no',
        'refs: file:src/api.ts@abc123',
        'The sender is waiting. Answer with msg_reply(messageId: "m-01abc").',
      ].join('\n')
    );
  });
});

describe('renderDigestLine', () => {
  it('summarizes the first line with the channel', () => {
    expect(renderDigestLine(m)).toBe(
      '📬 #epic/e-000001 · question from run:r-000001: Did you change the API shape? (m-01abc)'
    );
  });
  it('truncates long first lines', () => {
    const line = renderDigestLine({
      ...m,
      to: ['task:t-000001'],
      body: 'x'.repeat(200),
    });
    expect(line).toContain(`${'x'.repeat(79)}…`);
    expect(line.startsWith('📬 question from')).toBe(true);
  });
});
