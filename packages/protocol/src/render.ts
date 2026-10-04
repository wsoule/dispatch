import type { Message } from './envelope.js';
import { LINE_BREAK } from './lines.js';

const DIGEST_WIDTH = 80;

function refText(m: Message): string | null {
  if (m.refs.length === 0) return null;
  return `refs: ${m.refs.map((r) => `${r.type}:${r.id}${r.at ? `@${r.at}` : ''}`).join(', ')}`;
}

// The sender as a header names it: a teammate's replica by its handle, an
// external sender marked as such.
function senderLabel(m: Message, external: boolean, remote?: string): string {
  if (remote !== undefined) return `${m.from} (remote: ${remote})`;
  return external ? `${m.from} (external)` : m.from;
}

// The text a pushed message becomes inside an agent's session: a labelled
// header, then the body quoted line by line so it can never pass for a header.
// An external or remote sender's carried lines (choices, choice, refs) are quoted too.
export function renderForAgent(
  m: Message,
  external = false,
  remote?: string
): string {
  const quote = (line: string) => `│ ${line}`;
  const tags = [m.kind, ...(m.urgent ? ['urgent'] : []), m.id].join(' · ');
  const lines = [
    `[message from ${senderLabel(m, external, remote)} · ${tags}]`,
    ...m.body.split(LINE_BREAK).map(quote),
  ];
  if (m.replyTo !== null) lines.push(`(in reply to ${m.replyTo})`);
  const carried: string[] = [];
  if (m.choices !== undefined)
    carried.push(`choices: ${m.choices.join(' | ')}`);
  if (m.choice !== undefined) carried.push(`choice: ${m.choice}`);
  const refs = refText(m);
  if (refs !== null) carried.push(refs);
  const quoteCarried = external || remote !== undefined;
  lines.push(...(quoteCarried ? carried.map(quote) : carried));
  if (m.blocking)
    lines.push(
      `The sender is waiting. Answer with msg_reply(messageId: "${m.id}").`
    );
  return lines.join('\n');
}

// A body's first line, cut to the digest width in code points, for one-line summaries.
export function firstLine(body: string): string {
  const first = body.split(LINE_BREAK, 1)[0] ?? '';
  const chars = Array.from(first);
  return chars.length > DIGEST_WIDTH
    ? `${chars.slice(0, DIGEST_WIDTH - 1).join('')}…`
    : first;
}

// One line for a pulled (channel) message: where, who, the first line, the id.
export function renderDigestLine(
  m: Message,
  external = false,
  remote?: string
): string {
  const channel = m.to.find((a) => a.startsWith('channel:'));
  const where =
    channel === undefined ? '' : ` #${channel.slice('channel:'.length)} ·`;
  return `📬${where} ${m.kind} from ${senderLabel(m, external, remote)}: ${firstLine(m.body)} (${m.id})`;
}
