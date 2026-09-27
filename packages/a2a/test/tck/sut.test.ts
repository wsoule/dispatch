import { afterAll, beforeAll, expect, it } from 'bun:test';

import type { MessageJson, PartJson, TaskJson } from '../../src/wire.js';
import { startSut } from './sut.js';

let sut: ReturnType<typeof startSut>;
let base: string;

beforeAll(() => {
  sut = startSut();
  base = `http://127.0.0.1:${sut.port}`;
});
afterAll(() => sut.stop());

const HEADERS = { 'content-type': 'application/json', 'A2A-Version': '1.0' };

// A unary send with no Authorization header, as the TCK sends it.
async function send(
  messageId: string,
  message: Partial<MessageJson> = {}
): Promise<{ task?: TaskJson; message?: MessageJson }> {
  const res = await fetch(`${base}/a2a/v1/message:send`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ text: 'hi' }],
        ...message,
      },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { task?: TaskJson; message?: MessageJson };
}

// The first part of the first artifact: all the TCK's DM-ART-001 tests read.
function firstPart(task: TaskJson | undefined): PartJson | undefined {
  return task?.artifacts?.[0]?.parts[0];
}

it('serves a card whose interface is this SUT', async () => {
  const res = await fetch(`${base}/.well-known/agent-card.json`);
  const card = (await res.json()) as {
    supportedInterfaces: { url: string; protocolBinding: string }[];
  };
  expect(card.supportedInterfaces[0]).toMatchObject({
    url: `${base}/a2a/v1`,
    protocolBinding: 'HTTP+JSON',
  });
});

it('answers the core scenarios by messageId prefix', async () => {
  const done = await send('tck-complete-task-001');
  expect(done.task?.status.state).toBe('TASK_STATE_COMPLETED');
  expect(done.task?.status.message?.parts[0].text).toBe('Hello from TCK');
  expect((await send('tck-message-response-001')).message?.parts[0].text).toBe(
    'Direct message response'
  );
  expect((await send('tck-reject-task-001')).task?.status.state).toBe(
    'TASK_STATE_REJECTED'
  );
});

it("puts each artifact scenario's artifact first, where the TCK reads it", async () => {
  expect(firstPart((await send('tck-artifact-text-001')).task)).toMatchObject({
    text: 'Generated text content',
  });
  expect(firstPart((await send('tck-artifact-file-001')).task)).toEqual({
    raw: Buffer.from('TCK file content').toString('base64'),
    mediaType: 'text/plain',
    filename: 'output.txt',
  });
  expect(firstPart((await send('tck-artifact-file-url-001')).task)).toEqual({
    url: 'https://example.com/output.txt',
    mediaType: 'text/plain',
    filename: 'output.txt',
  });
  expect(firstPart((await send('tck-artifact-data-001')).task)).toMatchObject({
    data: { key: 'value', count: 42 },
  });
});

it('asks for input, then completes on the follow-up', async () => {
  const { task } = await send('tck-input-required-001');
  expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  const next = await send('tck-input-required-002', {
    taskId: task?.id,
    contextId: task?.contextId,
    parts: [{ text: 'more' }],
  });
  expect(next.task?.status.state).toBe('TASK_STATE_COMPLETED');
  expect(next.task?.status.message?.parts[0].text).toBe('Received: more');
});

it('streams a chunked artifact to completion', async () => {
  const res = await fetch(`${base}/a2a/v1/message:stream`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      message: {
        messageId: 'tck-stream-artifact-chunked-001',
        role: 'ROLE_USER',
        parts: [{ text: 'hi' }],
      },
    }),
  });
  const events = (await res.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  expect(events[0]).toContain('"task"');
  expect(events.join('\n')).toContain('chunk-2');
  expect(events.at(-1)).toContain('TASK_STATE_COMPLETED');
});
