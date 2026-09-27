// Reads back what the daemon writes into a run transcript for a bus message:
// renderForAgent's header and quoted body, and renderDigestLine's one line.

const HEADER = /^\[message from (\S+) · (.+)\]$/;
const QUOTED = /^│ (.*)$/;
const DIGEST = /^📬(?: #(\S+) ·)? (\S+) from (\S+): (.*) \((m-[^\s)]+)\)$/u;

/** A pushed message as the agent saw it, split back into its parts. */
export interface DeliveredMessage {
  from: string;
  kind: string;
  urgent: boolean;
  messageId: string;
  body: string;
  /** Lines after the body: in-reply-to, choices, choice, refs, the waiting note. */
  notes: string[];
}

/** renderForAgent's output split back into parts, or null for text in any other shape. */
export function parseDeliveredText(text: string): DeliveredMessage | null {
  const lines = text.split('\n');
  const header = HEADER.exec(lines[0] ?? '');
  if (header === null) return null;
  const tags = (header[2] ?? '').split(' · ');
  const messageId = tags[tags.length - 1] ?? '';
  if (tags.length < 2 || !messageId.startsWith('m-')) return null;
  const body: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const quoted = QUOTED.exec(lines[i] ?? '');
    if (quoted === null) break;
    body.push(quoted[1] ?? '');
  }
  return {
    from: header[1] ?? '',
    kind: tags[0] ?? '',
    urgent: tags.slice(1, -1).includes('urgent'),
    messageId,
    body: body.join('\n'),
    notes: lines.slice(i),
  };
}

/** A channel digest line, split back into its parts. */
export interface DigestLine {
  channel: string | null;
  kind: string;
  from: string;
  summary: string;
  messageId: string;
}

/** renderDigestLine's output split back into parts, or null for any other line. */
export function parseDigestLine(text: string): DigestLine | null {
  const match = DIGEST.exec(text.trim());
  if (match === null) return null;
  return {
    channel: match[1] ?? null,
    kind: match[2] ?? '',
    from: match[3] ?? '',
    summary: match[4] ?? '',
    messageId: match[5] ?? '',
  };
}
