import { describe, expect, it, spyOn } from 'bun:test';

import {
  diffExport,
  kindFromClaudeType,
  newIndexLines,
  parsedHash,
  parseMemoryFile,
  projectOnlyForClaudeType,
  renderClaudeIndex,
  renderTopicFile,
  topicFileName,
} from '../src/claudeFiles.js';
import type { ManifestRow } from '../src/claudeFiles.js';
import { newMemoryEntry } from '../src/records.js';

const NOW = '2026-09-25T10:00:00.000Z';
const entry = {
  ...newMemoryEntry(
    {
      scope: 'team',
      kind: 'hazard',
      title: 'pnpm 11 ignores [onlyBuiltDependencies]',
      body: '# not a heading\n~~~~ nor a fence\nuse allowBuilds',
      author: 'run:r-9f2c01',
      trust: 'agent',
    },
    `mem-01K5Z6G${'0'.repeat(19)}`,
    NOW
  ),
  rev: 3,
};
const ctx = { taskId: 't-1a2b3c', epic: null };

// The file as Claude Code rewrites it: `metadata: ` with a trailing space, its
// own node_type and new keys, the body untouched.
function claudeTouch(text: string): string {
  const touched = text.replace(
    /^metadata:[ \t]*\n {2}node_type: memory\n/m,
    'metadata: \n  node_type: note\n  modified: 2026-09-26T08:00:00.000Z\n  originSessionId: 1b2c\n'
  );
  expect(touched).not.toBe(text);
  return touched;
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

describe('topic files', () => {
  it('render in Claude’s own layout with a provenance line and an escaped body', () => {
    const text = renderTopicFile(entry);
    expect(
      text.startsWith(
        `---\nname: ${entry.id}\ndescription: "pnpm 11 ignores [onlyBuiltDependencies]"\nmetadata:\n  node_type: memory\n  type: project\n  dispatch:\n    handle: "${entry.handle}"`
      )
    ).toBe(true);
    expect(text).toContain(
      `> Dispatch memory ${entry.handle} · team hazard · by run:r-9f2c01 · unreviewed: an agent wrote this and no human has checked it.`
    );
    expect(text).toContain('\n\\# not a heading\n\\~~~~ nor a fence\n');
  });

  it('parse back to the stored title and body', () => {
    const parsed = parseMemoryFile(
      renderTopicFile(entry),
      topicFileName(entry)
    );
    expect(parsed).toMatchObject({
      title: entry.title,
      body: entry.body,
      type: 'project',
    });
  });

  it('treat a frontmatter-only rewrite as no change', () => {
    const written = parsedHash(parseMemoryFile(renderTopicFile(entry), 'x.md'));
    expect(
      parsedHash(parseMemoryFile(claudeTouch(renderTopicFile(entry)), 'x.md'))
    ).toBe(written);
    expect(
      parseMemoryFile(claudeTouch(renderTopicFile(entry)), 'x.md').modified
    ).toBe('2026-09-26T08:00:00.000Z');
  });

  it('read Claude’s own files: nested metadata.type first, then top-level type, then the first line', () => {
    expect(
      parseMemoryFile(
        '---\nname: carto\ndescription: Carto needs node 22\nmetadata:\n  type: reference\n---\nbody',
        'carto.md'
      )
    ).toMatchObject({
      title: 'Carto needs node 22',
      type: 'reference',
      body: 'body',
    });
    expect(
      parseMemoryFile(
        '---\ntype: feedback\n---\n\nTerse comments.\nMore.',
        'f.md'
      )
    ).toMatchObject({ title: 'Terse comments.', type: 'feedback' });
    expect(parseMemoryFile('no frontmatter at all', 'n.md')).toMatchObject({
      title: 'no frontmatter at all',
      type: undefined,
    });
    expect(
      parseMemoryFile(
        '---\ntype: feedback\nmodified: "2026-01-01"\nmetadata:\n  type: reference\n  modified: "2026-02-02"\n---\nbody',
        'both.md'
      )
    ).toMatchObject({ type: 'reference', modified: '2026-02-02' });
  });

  it('round-trips body lines that already start with an escaping backslash', () => {
    const escaped = {
      ...entry,
      body: '\\# already escaped\n\\\\~~~~ twice\n  # indented\n\\not structure',
    };
    const text = renderTopicFile(escaped);
    for (const line of text.split('\n'))
      expect(line).not.toMatch(/^\s*(?:#{1,6}[ \t]|~{4,})/);
    expect(parseMemoryFile(text, 'e.md').body).toBe(escaped.body);
  });

  it('reads frontmatter behind a byte-order mark', () => {
    expect(
      parseMemoryFile(
        '\uFEFF---\ndescription: bom\nmetadata:\n  type: reference\n---\nbody',
        'bom.md'
      )
    ).toMatchObject({ title: 'bom', type: 'reference', body: 'body' });
  });

  it('reads frontmatter with an unknown tag without logging a warning', () => {
    const emit = spyOn(process, 'emitWarning');
    try {
      const parsed = parseMemoryFile(
        '---\ndescription: !foo hi\n---\nbody',
        'tag.md'
      );
      expect(parsed).toMatchObject({ title: 'hi', body: 'body' });
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  it('keeps the last of duplicate frontmatter keys', () => {
    expect(
      parseMemoryFile(
        '---\ndescription: one\ndescription: two\nmetadata:\n  type: reference\n---\nbody',
        'dup.md'
      )
    ).toMatchObject({ title: 'two', type: 'reference', body: 'body' });
  });

  it('trims trailing whitespace, Unicode spaces included', () => {
    expect(parseMemoryFile('text \t\u00a0\u3000\n\n', 'ws.md').body).toBe(
      'text'
    );
  });

  it('cuts a long body at 8 KiB on a line boundary with a marker', () => {
    const parsed = parseMemoryFile(
      `---\ndescription: big\n---\n${'line of text\n'.repeat(1000)}`,
      'big.md'
    );
    expect(parsed.truncated).toBe(true);
    expect(utf8(parsed.body)).toBeLessThanOrEqual(8192);
    expect(parsed.body).toMatch(
      /\n\[truncated by Dispatch: \d+ bytes; long-form belongs in Docs\]$/
    );
  });

  it('cuts a single line longer than 8 KiB instead of dropping it', () => {
    const parsed = parseMemoryFile('x'.repeat(10_000), 'long.md');
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.startsWith('xxx')).toBe(true);
    expect(utf8(parsed.body)).toBeLessThanOrEqual(8192);
  });

  it('reads unparseable frontmatter as body rather than failing', () => {
    const parsed = parseMemoryFile('---\nkey: [unclosed\n---\ntext', 'bad.md');
    expect(parsed.type).toBeUndefined();
    expect(parsed.body).toContain('text');
    expect(parsed.title).toBe('key: [unclosed');
  });

  it('maps Claude types to kinds and reach', () => {
    expect(
      ['user', 'feedback', 'project', 'reference', undefined, 'odd'].map(
        kindFromClaudeType
      )
    ).toEqual([
      'preference',
      'preference',
      'fact',
      'reference',
      'fact',
      'fact',
    ]);
    expect(
      ['user', 'feedback', 'project', 'reference'].map(projectOnlyForClaudeType)
    ).toEqual([false, false, true, true]);
  });
});

describe('MEMORY.md', () => {
  it('lists links that cannot pose as structure, within the budget', () => {
    const hostile = {
      ...entry,
      id: `mem-01K5Z6H${'0'.repeat(19)}`,
      title: '# heading] (evil.md) [x',
    };
    const { text } = renderClaudeIndex([entry, hostile], ctx, 1000);
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'Managed by Dispatch. Add a memory as a new file here. Changes to team and project entries become proposals, which a human reviews'
    );
    for (const line of lines.slice(2))
      expect(line.startsWith('- [')).toBe(true);
    // `\`, `[` and `]` are escaped; the leading `- [` already keeps a `#`
    // from starting a heading, so it stays as written.
    expect(text).toContain(
      `- [# heading\\] (evil.md) \\[x](${hostile.id}.md) — hazard · unreviewed`
    );
  });

  it('stops at the first line that would cross the budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...entry,
      id: `mem-01K5Z6J${String(i).padStart(19, '0')}`,
    }));
    const { text, included } = renderClaudeIndex(many, ctx, 200);
    expect(utf8(text)).toBeLessThanOrEqual(600);
    expect(included.length).toBeGreaterThan(0);
    expect(included).toEqual(many.slice(0, included.length));
    expect(text.split('\n')).toHaveLength(2 + included.length);
  });

  it('never skips a line that crosses the budget for a shorter one after it', () => {
    const at = (i: number, title: string) => ({
      ...entry,
      id: `mem-01K5Z6K${String(i).padStart(19, '0')}`,
      title,
    });
    const [short, long, shortToo] = [
      at(0, 'a'),
      at(1, 'x'.repeat(200)),
      at(2, 'b'),
    ];
    const fits = utf8(renderClaudeIndex([short, shortToo], ctx, 10_000).text);
    const { included } = renderClaudeIndex(
      [short, long, shortToo],
      ctx,
      Math.ceil(fits / 3)
    );
    expect(included).toEqual([short]);
  });

  // A link line becomes its link text (the target and Dispatch's ` — kind · tags`
  // suffix after it are dropped); a plain line keeps its text after `- `.
  it('finds lines Claude added that link to no file', () => {
    const written = renderClaudeIndex([entry], ctx, 1000).text;
    const current = `${written}\n- remember to run proto use first\n- [stale link](gone.md) — fact`;
    expect(
      newIndexLines(written, current, new Set([`${entry.id}.md`]))
    ).toEqual(['remember to run proto use first', 'stale link']);
  });

  it('ignores blank lines, the header and links to files that exist', () => {
    const written = renderClaudeIndex([], ctx, 1000).text;
    const current = `${written}\n\n- [kept file](note.md) — fact\n- [a \\[bracketed\\] title](x.md)`;
    expect(newIndexLines(written, current, new Set(['note.md']))).toEqual([
      'a [bracketed] title',
    ]);
  });

  it('drops a line with a link to a file here anywhere in it', () => {
    const current = [
      '* [starred](note.md)',
      '- see [note](note.md) first',
      '1. [numbered](note.md) — fact',
      '- **[bold](note.md)** — fact',
      '- see [other](gone.md) first',
      '- \\[escaped](note.md) is no link',
    ].join('\n');
    expect(newIndexLines('', current, new Set(['note.md']))).toEqual([
      'other',
      '\\[escaped](note.md) is no link',
    ]);
  });

  it('reads 64 KiB lines of brackets and escapes in linear time', () => {
    const current = ['[', '[a', '[\\]', '\\[']
      .map((unit) => `- ${unit.repeat(Math.floor(65_536 / unit.length))}`)
      .join('\n');
    const started = performance.now();
    const titles = newIndexLines('', current, new Set());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(titles).toHaveLength(4);
  });

  it('reads 64 KiB of distinct short lines in linear time', () => {
    const lines = Array.from({ length: 16_384 }, (_, i) => i.toString(36));
    const started = performance.now();
    const titles = newIndexLines('', lines.join('\n'), new Set());
    expect(performance.now() - started).toBeLessThan(500);
    expect(titles).toEqual(lines);
  });
});

describe('diffExport', () => {
  const row = (file: string, hash: string): ManifestRow => ({
    lineage: 'r-1',
    file,
    store: 'shared',
    memoryId: `id-${file}`,
    rev: 1,
    parsedHash: hash,
  });
  const scanned = (file: string, hash: string) => ({
    file,
    hash,
    parsed: {
      title: file,
      body: '',
      type: undefined,
      modified: undefined,
      truncated: false,
    },
  });

  it('classifies new, changed, deleted and renamed files by parsed hash', () => {
    const changes = diffExport(
      [row('a.md', 'A'), row('b.md', 'B'), row('c.md', 'C'), row('d.md', 'D')],
      [
        scanned('a.md', 'A'),
        scanned('b.md', 'B2'),
        scanned('moved.md', 'D'),
        scanned('new.md', 'N'),
      ]
    );
    expect(
      changes
        .map((c) => `${c.type} ${'row' in c ? c.row.file : c.file}`)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['changed b.md', 'deleted c.md', 'new new.md', 'renamed d.md']);
  });

  it('matches one rename per deleted row; a second copy is new', () => {
    const changes = diffExport(
      [row('d.md', 'D')],
      [scanned('one.md', 'D'), scanned('two.md', 'D')]
    );
    expect(
      changes.map((c) => [c.type, c.type === 'renamed' ? c.file : ''])
    ).toEqual([
      ['renamed', 'one.md'],
      ['new', ''],
    ]);
  });
});
