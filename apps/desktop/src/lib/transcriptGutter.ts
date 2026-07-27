import type { NormalizedEntry } from '@dispatch/client';

/**
 * The short tag that leads each transcript line.
 *
 * The point of the gutter is that you can see the *shape* of what an agent did without reading a
 * word of it — five reads, a think, two edits, a test run. That only works if the tags are few
 * and fixed-width, so `tool` collapses into read / edit / run by what the tool actually does
 * rather than surfacing thirty distinct tool names.
 */
export type GutterTag =
  | 'read'
  | 'edit'
  | 'run'
  | 'think'
  | 'says'
  | 'you'
  | 'sys';

/** Tools that only look at things. Grouped because "it read four files" is one fact. */
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoRead',
]);

/** Tools that change things — the ones worth noticing in a scan. */
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Update',
]);

export function gutterTag(entry: NormalizedEntry): GutterTag {
  switch (entry.kind) {
    case 'thinking':
      return 'think';
    case 'assistant':
      return 'says';
    case 'system':
    case 'usage':
      return 'sys';
    case 'message':
      // An inbound message is either the human steering, or another run talking to this one.
      // Both are "not the agent's own train of thought", which is what the accent marks.
      return entry.from === 'user' ? 'you' : 'says';
    case 'tool': {
      const name = entry.toolName ?? '';
      if (READ_TOOLS.has(name)) return 'read';
      if (EDIT_TOOLS.has(name)) return 'edit';
      // Bash and everything unrecognised read as "run": an unknown tool is more likely to do
      // something than to merely look, so the safer default is the one that draws the eye.
      return 'run';
    }
  }
}

/** How each tag is emphasised. Meaning, not decoration — see the per-tag reasoning. */
export type GutterTone = 'muted' | 'normal' | 'accent' | 'good' | 'bad';

export function gutterTone(entry: NormalizedEntry): GutterTone {
  const tag = gutterTag(entry);
  // A failed command is the one thing in a transcript you always want to find, so it outranks
  // whatever its tag would otherwise have been.
  if (entry.status === 'error') return 'bad';
  if (tag === 'think') return 'muted';
  // Thinking is context, not action, so it recedes; the user's own turns stand out from the
  // agent's stream so you can find what you told it and when.
  if (tag === 'you') return 'accent';
  if (tag === 'sys') return 'muted';
  if (tag === 'run' && entry.status === 'done') return 'good';
  return 'normal';
}
