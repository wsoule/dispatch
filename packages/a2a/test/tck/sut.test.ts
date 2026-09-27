import { afterAll, beforeAll, expect, it } from 'bun:test';

import type {
  MessageJson,
  PartJson,
  StreamResponseJson,
  TaskJson,
} from '../../src/wire.js';
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

// Every data event of an SSE response, read until the server ends it.
async function sseEvents(res: Response): Promise<StreamResponseJson[]> {
  return (await res.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map(
      (line) => JSON.parse(line.slice('data: '.length)) as StreamResponseJson
    );
}

// The task state a stream event carries, if it carries one.
function stateOf(event: StreamResponseJson | undefined): string | undefined {
  if (event === undefined) return undefined;
  if ('task' in event) return event.task.status.state;
  if ('statusUpdate' in event) return event.statusUpdate.status.state;
  return undefined;
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

// CORE-MULTI-002a (§3.4.1): a client contextId is kept or refused, never
// replaced; the TCK passes it only when the send succeeds.
it('keeps a client contextId on a new task instead of minting one', async () => {
  const { task } = await send('tck-complete-task-ctx', {
    contextId: 'tck-client-context-rejected-001',
  });
  expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
  expect(task?.contextId).toBe('tck-client-context-rejected-001');
  expect(task?.status.message?.contextId).toBe(
    'tck-client-context-rejected-001'
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

// STREAM-SUB-002: the TCK subscribes to its input-required task, completes it
// with a follow-up 0.5 s later, and expects the stream to end on that state.
it('keeps a subscription open until a follow-up completes the task', async () => {
  const { task } = await send('tck-input-required-sub');
  const res = await fetch(`${base}/a2a/v1/tasks/${task?.id}:subscribe`, {
    headers: HEADERS,
  });
  const followUp = Bun.sleep(500).then(() =>
    send('tck-complete-task-sub', { taskId: task?.id })
  );
  const events = await sseEvents(res);
  await followUp;
  expect(stateOf(events[0])).toBe('TASK_STATE_INPUT_REQUIRED');
  expect(stateOf(events.at(-1))).toBe('TASK_STATE_COMPLETED');
});

// A changed artifact is resent whole (append false), never as a trailing chunk.
it('streams a chunked artifact whole, then completes', async () => {
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
  const events = await sseEvents(res);
  const chunked = events.flatMap((e) =>
    'artifactUpdate' in e && e.artifactUpdate.artifact.artifactId === 'chunked'
      ? [e.artifactUpdate]
      : []
  );
  expect('task' in events[0]).toBe(true);
  expect(chunked.length).toBeGreaterThan(0);
  for (const update of chunked)
    expect(update).toMatchObject({ append: false, lastChunk: true });
  expect(chunked.at(-1)?.artifact.parts).toEqual([
    { text: 'chunk-1 ' },
    { text: 'chunk-2' },
  ]);
  expect(stateOf(events.at(-1))).toBe('TASK_STATE_COMPLETED');
});
