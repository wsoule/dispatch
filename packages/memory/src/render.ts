import { untrustedBlock, untrustedInline } from '@dispatch-foo/core';

import { cutUtf8, utf8Bytes } from './limits.js';
import { KIND_CLASS } from './rank.js';
import type { RankContext } from './rank.js';
import type { MemoryEntry } from './types.js';

export type IndexVariant = 'tools' | 'no-tools';

export interface RenderIndexOptions {
  budgetTokens: number;
  variant: IndexVariant;
  ctx: RankContext;
  personalUnavailable?: boolean;
}

export interface RenderedIndex {
  text: string | null;
  included: MemoryEntry[];
  omitted: number;
  pinnedOverflow: boolean;
}

const HEADER: Record<IndexVariant, string> = {
  tools: [
    '## Memory',
    'Lessons and preferences from earlier work, one line each. Open one with',
    'memory_read("#…"); memory_search finds more. "unreviewed" lines were written',
    'by an agent and no human has checked them.',
  ].join('\n'),
  'no-tools': [
    '## Memory',
    'Lessons and preferences from earlier work, one line each. "unreviewed" lines',
    'were written by an agent and no human has checked them.',
  ].join('\n'),
};

const BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;

export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 3);
}

export function reachTags(entry: MemoryEntry, ctx: RankContext): string[] {
  const tags: string[] = [];
  if (entry.scope === 'personal') tags.push('you');
  if (entry.scope === 'project') tags.push('local');
  if (ctx.taskId !== null && entry.appliesTo.includes(ctx.taskId))
    tags.push('task');
  else if (entry.epic !== null && entry.epic === ctx.epic) tags.push('epic');
  return tags;
}

export function indexLine(entry: MemoryEntry, ctx: RankContext): string {
  const tags = [
    ...reachTags(entry, ctx),
    ...(entry.trust === 'agent' ? ['unreviewed'] : []),
  ];
  return `- ${[entry.kind, ...tags].join(' · ')}: ${untrustedInline(entry.title)} (${entry.handle})`;
}

// A class-3 body for executors with no tools: 300 bytes, structure escaped, indented.
function bodyExcerpt(entry: MemoryEntry): string {
  const cut = cutUtf8(entry.body, 300).replace(BREAKS, '\n');
  return untrustedBlock(cut)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function overflowLine(variant: IndexVariant, count: number): string {
  return variant === 'tools'
    ? `(${count} more not shown; memory_search finds them)`
    : `(${count} more not shown)`;
}

// Adds ranked lines until the next would cross the budget, reserving room for the overflow line.
export function renderIndex(
  ranked: readonly MemoryEntry[],
  opts: RenderIndexOptions
): RenderedIndex {
  const notes =
    opts.personalUnavailable === true ? ['(personal memory unavailable)'] : [];
  if (ranked.length === 0 && notes.length === 0)
    return { text: null, included: [], omitted: 0, pinnedOverflow: false };
  const budget = opts.budgetTokens * 3;
  const reserved = utf8Bytes(overflowLine(opts.variant, ranked.length)) + 1;
  const lines = [HEADER[opts.variant], ...notes];
  let used = utf8Bytes(lines.join('\n'));
  const included: MemoryEntry[] = [];
  for (const entry of ranked) {
    let block = indexLine(entry, opts.ctx);
    if (
      opts.variant === 'no-tools' &&
      KIND_CLASS[entry.kind] === 3 &&
      entry.body.trim() !== ''
    )
      block += `\n${bodyExcerpt(entry)}`;
    const cost = utf8Bytes(block) + 1;
    const last = included.length + 1 === ranked.length;
    if (used + cost + (last ? 0 : reserved) > budget) break;
    lines.push(block);
    used += cost;
    included.push(entry);
  }
  const omitted = ranked.length - included.length;
  if (omitted > 0) lines.push(overflowLine(opts.variant, omitted));
  const kept = new Set(included);
  return {
    text: lines.join('\n'),
    included,
    omitted,
    pinnedOverflow: ranked.some((e) => e.pinned && !kept.has(e)),
  };
}
