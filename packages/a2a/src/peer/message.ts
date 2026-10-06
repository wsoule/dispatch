import type { JsonValue, Message } from '@dispatch-foo/protocol';

import { utf8Bytes } from '../ext.js';
import { ENVELOPE_URI, WORK_URI } from '../uris.js';
import type { MessageJson, PartJson } from '../wire.js';

export const PEER_OUTPUT_MODES = [
  'text/markdown',
  'text/plain',
  'application/json',
] as const;
const BUILT_IN = new Set([
  'message',
  'question',
  'answer',
  'handoff',
  'notice',
]);
const MAX_TITLE_BYTES = 200;

export interface PeerLink {
  contextId: string | null;
  taskId: string | null;
}

// The handoff's first non-empty line, cut to 200 bytes on a character boundary.
function handoffTitle(body: string): string {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  let title = '';
  for (const ch of line) {
    if (utf8Bytes(title + ch) > MAX_TITLE_BYTES) break;
    title += ch;
  }
  return title === '' ? 'Handoff from Dispatch' : title;
}

// The A2A message a Dispatch message becomes for one peer: its own id as
// messageId, `to` reduced to the peer, refs as opaque ids (spec:1450-1459).
export function peerOutboundMessage(
  m: Message,
  alias: string,
  link: PeerLink
): MessageJson {
  // An A2A text part must say something: an answer by choice alone sends the choice.
  const text = m.body.trim() !== '' ? m.body : (m.choice ?? '(no text)');
  const parts: PartJson[] = [{ text, mediaType: 'text/markdown' }];
  if (m.data !== undefined)
    parts.push({ data: m.data, mediaType: 'application/json' });
  const envelope: Record<string, JsonValue> = {
    from: m.from,
    to: [`a2a:${alias}`],
    kind: BUILT_IN.has(m.kind) ? m.kind : 'message',
  };
  if (m.replyTo !== null) envelope.replyTo = m.replyTo;
  if (m.blocking) envelope.blocking = true;
  if (m.choices !== undefined) envelope.choices = [...m.choices];
  if (m.choice !== undefined) envelope.choice = m.choice;
  if (m.refs.length > 0)
    envelope.refs = m.refs.map(({ type, id }) => ({ type, id }));
  const metadata: Record<string, JsonValue> = { [ENVELOPE_URI]: envelope };
  const extensions: string[] = [ENVELOPE_URI];
  if (m.kind === 'handoff') {
    metadata[WORK_URI] = { skill: 'handoff', title: handoffTitle(m.body) };
    extensions.push(WORK_URI);
  }
  const out: MessageJson = {
    messageId: m.id,
    role: 'ROLE_USER',
    parts,
    metadata,
    extensions,
  };
  if (link.contextId !== null) out.contextId = link.contextId;
  if (link.taskId !== null) out.taskId = link.taskId;
  return out;
}
