import type { Message } from './envelope.js';
import { LINE_BREAK } from './lines.js';

const DIGEST_WIDTH = 80;

function refText(m: Message): string | null {
  if (m.refs.length === 0) return null;
  return `refs: ${m.refs.map((r) => `${r.type}:${r.id}${r.at ? `@${r.at}` : ''}`).join(', ')}`;
}

// The text a pushed message becomes inside an agent's session: a labelled
// header, then the body quoted line by line so it can never pass for a header.
export function renderForAgent(m: Message): string {
  const tags = [m.kind, ...(m.urgent ? ['urgent'] : []), m.id].join(' · ');
  const body = m.body.split(LINE_BREAK).map((line) => `│ ${line}`);
  const lines = [`[message from ${m.from} · ${tags}]`, ...body];
  if (m.replyTo !== null) lines.push(`(in reply to ${m.replyTo})`);
  if (m.choices !== undefined) lines.push(`choices: ${m.choices.join(' | ')}`);
  if (m.choice !== undefined) lines.push(`choice: ${m.choice}`);
  const refs = refText(m);
  if (refs !== null) lines.push(refs);
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
export function renderDigestLine(m: Message): string {
  const channel = m.to.find((a) => a.startsWith('channel:'));
  const where =
    channel === undefined ? '' : ` #${channel.slice('channel:'.length)} ·`;
  return `📬${where} ${m.kind} from ${m.from}: ${firstLine(m.body)} (${m.id})`;
}
