import type { Message } from './envelope.js';

const DIGEST_WIDTH = 80;

function refText(m: Message): string | null {
  if (m.refs.length === 0) return null;
  return `refs: ${m.refs.map((r) => `${r.type}:${r.id}${r.at ? `@${r.at}` : ''}`).join(', ')}`;
}

// The text a pushed message becomes inside an agent's session: a labelled
// header the agent can tell apart from its own prompt, then the payload.
export function renderForAgent(m: Message): string {
  const tags = [m.kind, ...(m.urgent ? ['urgent'] : []), m.id].join(' · ');
  const lines = [`[message from ${m.from} · ${tags}]`, m.body];
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

// One line for a pulled (channel) message: where, who, the first line, the id.
export function renderDigestLine(m: Message): string {
  const channel = m.to.find((a) => a.startsWith('channel:'));
  const where =
    channel === undefined ? '' : ` #${channel.slice('channel:'.length)} ·`;
  const first = m.body.split('\n')[0] ?? '';
  const text =
    first.length > DIGEST_WIDTH
      ? `${first.slice(0, DIGEST_WIDTH - 1)}…`
      : first;
  return `📬${where} ${m.kind} from ${m.from}: ${text} (${m.id})`;
}
