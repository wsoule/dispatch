import { cutMemoryBody } from '@dispatch/memory';

import { IDENTITY_PATTERN } from './identities.js';

// Long personal Claude notes overflow into a personal doc (docs Task 18). The
// rule is a privacy rule: only a personal entry keyed to this project may point
// at its human's personal doc; shared and cross-project entries stay plain.

interface OverflowInput {
  entryId: string;
  human: string;
  identity: string;
  // Who wrote the entry (an agent or run): the doc's text is theirs, unreviewed.
  author: string;
  title: string;
  body: string;
}

export interface DocsOverflowPort {
  // The doc now holding the full text; null when docs cannot take it.
  overflow(input: OverflowInput): string | null;
}

interface RefLike {
  type: string;
  id: string;
}

/** The body cut with a doc marker and the doc ref added, when the entry is a
 *  personal one keyed to this project and docs took its full text; null otherwise. */
export function overflowBody<R extends RefLike>(
  entry: {
    id: string;
    scope: string;
    projectKey: string | null;
    author: string;
    title: string;
    refs: readonly R[];
  },
  parsed: { fullBody?: string },
  ctx: {
    projectKey: string;
    human: string;
    identity: string;
    port: DocsOverflowPort | null;
  }
): { body: string; refs: (R | { type: 'doc'; id: string })[] } | null {
  const full = parsed.fullBody;
  if (
    full === undefined ||
    ctx.port === null ||
    entry.scope !== 'personal' ||
    entry.projectKey === null ||
    entry.projectKey !== ctx.projectKey
  )
    return null;
  let docId: string | null;
  try {
    docId = ctx.port.overflow({
      entryId: entry.id,
      human: ctx.human,
      identity: ctx.identity,
      author: entry.author,
      title: entry.title,
      body: full,
    });
  } catch (err) {
    console.error(`memory: overflowing ${entry.id} into a doc failed`, err);
    return null;
  }
  if (docId === null) return null;
  const id = docId;
  return {
    body: cutMemoryBody(
      full,
      (n) =>
        `\n[truncated by Dispatch: ${n} bytes; full text in doc ${id} of project ${ctx.projectKey}]`
    ),
    refs: [
      ...entry.refs.filter((r) => !(r.type === 'doc' && r.id === id)),
      { type: 'doc', id },
    ],
  };
}

/** The port over the docs service: null with docs down, and for a sentinel
 *  identity (identities.db down, a reused handle) that many humans share. */
export function docsOverflowPort(docs: {
  available: boolean;
  overflowFromMemory(input: OverflowInput): string | null;
}): DocsOverflowPort {
  return {
    overflow: (input) =>
      docs.available && IDENTITY_PATTERN.test(input.identity)
        ? docs.overflowFromMemory(input)
        : null,
  };
}
