import { describe, expect, it } from 'bun:test';

import {
  diffstatFromPatch,
  evidenceFact,
  MAX_ARTIFACT_BYTES,
  prFact,
  workArtifacts,
} from '../src/artifacts.js';
import { WORK_URI } from '../src/uris.js';
import type { ExtensionUri } from '../src/uris.js';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+added',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n');
const view = {
  textMediaType: 'text/markdown' as const,
  extensions: new Set<ExtensionUri>([WORK_URI]),
};

describe('work facts', () => {
  it('counts a patch per file', () => {
    expect(diffstatFromPatch(PATCH)).toEqual({
      kind: 'diffstat',
      files: 2,
      insertions: 2,
      deletions: 2,
      perFile: [
        { path: 'src/a.ts', insertions: 2, deletions: 1 },
        { path: 'README.md', insertions: 0, deletions: 1 },
      ],
    });
  });

  it('counts changed lines that look like file headers', () => {
    const patch = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,2 +1,2 @@',
      '----',
      '+++x',
    ].join('\n');
    expect(diffstatFromPatch(patch)).toMatchObject({
      insertions: 1,
      deletions: 1,
    });
  });

  it('parses a PR number and marks merged only when landed', () => {
    expect(
      prFact('https://github.com/acme/api/pull/42', {
        landed: true,
        open: false,
      })
    ).toEqual({
      kind: 'pr',
      url: 'https://github.com/acme/api/pull/42',
      number: 42,
      state: 'merged',
    });
    expect(
      prFact('https://github.com/acme/api/pull/42', {
        landed: false,
        open: true,
      })?.state
    ).toBe('open');
    expect(
      prFact('https://github.com/acme/api/pull/42', {
        landed: false,
        open: false,
      })
    ).not.toHaveProperty('state');
    expect(
      prFact('https://example.com/no-number', { landed: false, open: false })
    ).toBeNull();
  });

  it('keeps evidence to command, exit code, duration and summary', () => {
    expect(
      evidenceFact([
        {
          command: 'bun test',
          exitCode: 0,
          durationMs: 1200,
          summary: '158 pass',
          at: '2026-09-25T00:00:00Z',
        },
      ])
    ).toEqual({
      kind: 'evidence',
      items: [
        {
          command: 'bun test',
          exitCode: 0,
          durationMs: 1200,
          summary: '158 pass',
        },
      ],
    });
  });
});

describe('workArtifacts', () => {
  it('writes pr, diffstat and evidence with the work extension', () => {
    const artifacts = workArtifacts(
      {
        pr: prFact('https://github.com/acme/api/pull/42', {
          landed: true,
          open: false,
        })!,
        diffstat: diffstatFromPatch(PATCH),
      },
      view
    );
    expect(artifacts.map((a) => a.artifactId)).toEqual(['pr', 'diffstat']);
    expect(artifacts[0].parts[0]).toEqual({
      url: 'https://github.com/acme/api/pull/42',
    });
    expect(artifacts[1].metadata?.[WORK_URI]).toMatchObject({
      kind: 'diffstat',
      files: 2,
    });
  });

  it('writes evidence as data and one text line per command', () => {
    const [artifact] = workArtifacts(
      {
        evidence: evidenceFact([
          {
            command: 'bun test',
            exitCode: 0,
            durationMs: 1200,
            summary: '158 pass',
            at: '2026-09-25T00:00:00Z',
          },
        ]),
      },
      { ...view, extensions: new Set<ExtensionUri>() }
    );
    expect(artifact.artifactId).toBe('evidence');
    expect(artifact.parts[1]).toEqual({
      text: '0 bun test (1200 ms): 158 pass',
      mediaType: 'text/markdown',
    });
    expect(artifact.metadata).toBeUndefined();
    expect(artifact.extensions).toBeUndefined();
  });

  it('cuts perFile to fit 64 KiB and says so', () => {
    const perFile = Array.from({ length: 200 }, (_, i) => ({
      path: `${'p'.repeat(400)}/${i}.ts`,
      insertions: 1,
      deletions: 1,
    }));
    const [artifact] = workArtifacts(
      {
        diffstat: {
          kind: 'diffstat',
          files: 200,
          insertions: 200,
          deletions: 200,
          perFile,
        },
      },
      view
    );
    expect(
      new TextEncoder().encode(JSON.stringify(artifact)).byteLength
    ).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    expect(artifact.metadata?.truncated).toBe(true);
  });
});
