import { untrustedFenced } from './untrusted.js';

// The fields of a memory read that memory_read reshapes; the rest pass through.
interface MemoryReadInput<E> {
  entry: E & {
    body: string;
    handle: string;
    author: unknown;
    trust: unknown;
    decidedBy: unknown;
    decidedByPolicy: unknown;
  };
  revisions: readonly { rev: number; by: string; cause: string; at: string }[];
}

/**
 * What memory_read hands a model, from the MCP and the overseer alike: the
 * body fenced as untrusted text, and each revision without its snapshot.
 */
export function memoryReadView<E>(read: MemoryReadInput<E>) {
  const { body, ...entry } = read.entry;
  return {
    entry,
    body: untrustedFenced(`memory ${read.entry.handle}`, body),
    provenance: {
      author: read.entry.author,
      trust: read.entry.trust,
      decidedBy: read.entry.decidedBy,
      decidedByPolicy: read.entry.decidedByPolicy,
    },
    revisions: read.revisions.map(({ rev, by, cause, at }) => ({
      rev,
      by,
      cause,
      at,
    })),
  };
}
