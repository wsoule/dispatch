import type { CommandEvidence } from '@dispatch/core';
import { untrustedInline } from '@dispatch/core';
import type { JsonValue, Message } from '@dispatch/protocol';

import { utf8Bytes } from './ext.js';
import type { WorkArtifactV1 } from './ext.js';
import type { TaskFacts } from './port.js';
import type { ProjectionView } from './projection.js';
import { WORK_URI } from './uris.js';
import type { ArtifactJson, PartJson } from './wire.js';

type ArtifactView = Pick<ProjectionView, 'textMediaType' | 'extensions'>;
type PrFact = Extract<WorkArtifactV1, { kind: 'pr' }>;
type DiffstatFact = Extract<WorkArtifactV1, { kind: 'diffstat' }>;
type EvidenceFact = Extract<WorkArtifactV1, { kind: 'evidence' }>;
type WorkFact = PrFact | DiffstatFact | EvidenceFact;

export const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_PER_FILE = 200;
const MAX_EVIDENCE_ITEMS = 50;
// A `diff --git` header, its paths bare or quoted; the file is the b/ side.
const DIFF_HEADER = /^diff --git "?a\/.+ "?b\/(.+?)"?$/;

// An ask's answer as the `answer` artifact: its text, and its choice as data.
export function answerArtifact(
  answer: Message,
  view: ArtifactView
): ArtifactJson {
  const parts: PartJson[] = [
    { text: answer.body, mediaType: view.textMediaType },
  ];
  if (answer.choice !== undefined) {
    parts.push({
      data: { choice: answer.choice },
      mediaType: 'application/json',
    });
  }
  const artifact: ArtifactJson = {
    artifactId: 'answer',
    name: 'answer',
    parts,
  };
  if (view.extensions.has(WORK_URI)) {
    const ext: WorkArtifactV1 = {
      kind: 'answer',
      messageId: answer.id,
      ...(answer.choice === undefined ? {} : { choice: answer.choice }),
    };
    artifact.metadata = { [WORK_URI]: ext as unknown as JsonValue };
    artifact.extensions = [WORK_URI];
  }
  return artifact;
}

// The `pr` fact for a run's PR URL, or null when the URL names no PR number.
export function prFact(
  url: string,
  opts: { landed: boolean; open: boolean }
): PrFact | null {
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const state = opts.landed ? 'merged' : opts.open ? 'open' : undefined;
  return { kind: 'pr', url, number, ...(state === undefined ? {} : { state }) };
}

// Per-file counts from a unified patch, read only inside hunks so changed
// lines that look like `---`/`+++` headers still count; the patch never leaves.
export function diffstatFromPatch(patch: string): DiffstatFact {
  const perFile: DiffstatFact['perFile'] = [];
  let current: DiffstatFact['perFile'][number] | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = DIFF_HEADER.exec(line);
    if (header !== null) {
      current = { path: header[1], insertions: 0, deletions: 0 };
      perFile.push(current);
      inHunk = false;
    } else if (current === null) continue;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) current.insertions += 1;
    else if (inHunk && line.startsWith('-')) current.deletions += 1;
  }
  return {
    kind: 'diffstat',
    files: perFile.length,
    insertions: perFile.reduce((n, f) => n + f.insertions, 0),
    deletions: perFile.reduce((n, f) => n + f.deletions, 0),
    perFile: perFile.slice(0, MAX_PER_FILE),
  };
}

// The `evidence` fact: each command's outcome, without when it ran.
export function evidenceFact(items: readonly CommandEvidence[]): EvidenceFact {
  return {
    kind: 'evidence',
    items: items
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map(({ command, exitCode, durationMs, summary }) => ({
        command,
        exitCode,
        durationMs,
        summary,
      })),
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function workParts(fact: WorkFact, view: ArtifactView): PartJson[] {
  const mediaType = view.textMediaType;
  switch (fact.kind) {
    case 'pr': {
      const state = fact.state === undefined ? '' : ` (${fact.state})`;
      return [
        { url: fact.url },
        {
          text: `Pull request #${fact.number}${state}: ${fact.url}`,
          mediaType,
        },
      ];
    }
    case 'diffstat': {
      const { files, insertions, deletions, perFile } = fact;
      return [
        {
          text: `${plural(files, 'file')} changed, ${plural(insertions, 'insertion')}(+), ${plural(deletions, 'deletion')}(-)`,
          mediaType,
        },
        {
          data: { files, insertions, deletions, perFile },
          mediaType: 'application/json',
        },
      ];
    }
    case 'evidence':
      return [
        {
          data: { items: fact.items },
          mediaType: 'application/json',
        },
        {
          text: fact.items
            .map(
              (i) =>
                `${i.exitCode} ${untrustedInline(i.command)} (${i.durationMs} ms): ${untrustedInline(i.summary)}`
            )
            .join('\n'),
          mediaType,
        },
      ];
  }
}

function workArtifact(
  fact: WorkFact,
  view: ArtifactView,
  truncated: boolean
): ArtifactJson {
  const artifact: ArtifactJson = {
    artifactId: fact.kind,
    name: fact.kind,
    parts: workParts(fact, view),
  };
  const metadata: Record<string, JsonValue> = {};
  if (view.extensions.has(WORK_URI)) {
    metadata[WORK_URI] = fact as unknown as JsonValue;
    artifact.extensions = [WORK_URI];
  }
  if (truncated) metadata.truncated = true;
  if (Object.keys(metadata).length > 0) artifact.metadata = metadata;
  return artifact;
}

// The fact with half its perFile or items, or null when nothing is left to cut.
function halved(fact: WorkFact): WorkFact | null {
  if (fact.kind === 'diffstat' && fact.perFile.length > 0) {
    return {
      ...fact,
      perFile: fact.perFile.slice(0, Math.floor(fact.perFile.length / 2)),
    };
  }
  if (fact.kind === 'evidence' && fact.items.length > 0) {
    return {
      ...fact,
      items: fact.items.slice(0, Math.floor(fact.items.length / 2)),
    };
  }
  return null;
}

// A handoff's pr, diffstat and evidence artifacts, in that order; a list that
// would push an artifact past MAX_ARTIFACT_BYTES is halved and marked truncated.
export function workArtifacts(
  work: TaskFacts['work'],
  view: ArtifactView
): ArtifactJson[] {
  const out: ArtifactJson[] = [];
  for (const fact of [work.pr, work.diffstat, work.evidence]) {
    if (fact === undefined || fact.kind === 'answer') continue;
    let current = fact;
    let artifact = workArtifact(current, view, false);
    while (utf8Bytes(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES) {
      const smaller = halved(current);
      if (smaller === null) break;
      current = smaller;
      artifact = workArtifact(current, view, true);
    }
    out.push(artifact);
  }
  return out;
}
