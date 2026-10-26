import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// One message of the recordings in test/fixtures/claude-overseer-stream.json,
// slimmed to the fields the Overseer reads (see the file's `about`). Shared by
// the Overseer's and the executor's live text tests.
interface RecordedEvent {
  type: string;
  subtype?: string;
  parent: string | null;
  event?: string;
  index?: number;
  block?: string;
  delta?: string;
  text?: string;
  msgId?: string;
  content?: { type: string; text?: string; name?: string; id?: string }[];
  result?: string;
  is_error?: boolean;
}

const RECORDINGS = JSON.parse(
  readFileSync(
    join(import.meta.dir, '..', 'fixtures', 'claude-overseer-stream.json'),
    'utf8'
  )
) as Record<'string' | 'stream', { events: RecordedEvent[] }>;

// The Messages API stream event a recorded `stream_event` carried.
function streamEventOf(e: RecordedEvent): Record<string, unknown> {
  if (e.event === 'message_start') {
    return { type: 'message_start', message: { id: e.msgId } };
  }
  if (e.event === 'content_block_start') {
    return {
      type: 'content_block_start',
      index: e.index,
      content_block: { type: e.block },
    };
  }
  if (e.event === 'content_block_delta') {
    const delta =
      e.delta === 'text_delta'
        ? { type: 'text_delta', text: e.text }
        : e.delta === 'input_json_delta'
          ? { type: 'input_json_delta', partial_json: e.text }
          : { type: e.delta };
    return { type: 'content_block_delta', index: e.index, delta };
  }
  return {
    type: e.event,
    ...(e.index === undefined ? {} : { index: e.index }),
  };
}

// A recorded message back in the SDK's own shape.
function sdkMessageOf(e: RecordedEvent): Record<string, unknown> {
  const base = {
    type: e.type,
    parent_tool_use_id: e.parent,
    session_id: 'sess-rec',
    ...(e.subtype === undefined ? {} : { subtype: e.subtype }),
  };
  if (e.type === 'stream_event') return { ...base, event: streamEventOf(e) };
  if (e.type === 'assistant') {
    return {
      ...base,
      message: {
        id: e.msgId,
        content: (e.content ?? []).map((b) =>
          b.type === 'tool_use' ? { ...b, input: {} } : b
        ),
      },
    };
  }
  if (e.type === 'user') {
    return { ...base, message: { role: 'user', content: e.content } };
  }
  if (e.type === 'result') {
    return { ...base, result: e.result, is_error: e.is_error };
  }
  return base;
}

// A replay of one recording, as an SDK query's message stream: `keep` drops
// events (all stream events, say, to replay a CLI without partial messages).
export function recorded(
  name: 'string' | 'stream',
  keep: (e: RecordedEvent) => boolean = () => true
): () => Iterable<unknown> {
  const messages = RECORDINGS[name].events.filter(keep).map(sdkMessageOf);
  return () => messages;
}
