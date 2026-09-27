import type { DocOp } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import { applyOps, parseOps } from '../../src/docs/ops.js';

const DOC = {
  title: 'Auth',
  body: '# Auth\nIntro.\n## API\nOld api.\n### Errors\nCodes.\n## API\nSecond.\n```\n## Risks\n```\n#### Deep\n## Risks\nNone.\n',
};

describe('applyOps', () => {
  it('replaces a section after its heading, subsections included, as whole lines', () => {
    const r = applyOps(DOC, [
      { op: 'replace_section', section: '#api', text: 'New api.' },
    ]);
    expect(r.body).toBe(
      '# Auth\nIntro.\n## API\nNew api.\n## API\nSecond.\n```\n## Risks\n```\n#### Deep\n## Risks\nNone.\n'
    );
    expect(r.summary).toBe('replaced "## API"');
  });

  it('treats h4 headings and headings in fences as text of their section', () => {
    const r = applyOps(DOC, [
      { op: 'replace_section', section: '#api-1', text: 'Only.\n' },
    ]);
    expect(r.body.endsWith('## API\nOnly.\n## Risks\nNone.\n')).toBe(true);
  });

  it('refuses an ambiguous heading and names the anchors', () => {
    expect(() =>
      applyOps(DOC, [{ op: 'replace_section', section: 'API', text: 'x' }])
    ).toThrow('ops[0]: ambiguous: #api, #api-1');
  });

  it('replaces text found exactly once, like the Edit tool', () => {
    expect(
      applyOps(DOC, [{ op: 'replace', find: 'Old api.', text: 'New.' }]).body
    ).toContain('## API\nNew.\n');
    expect(() =>
      applyOps(DOC, [{ op: 'replace', find: 'nowhere', text: 'x' }])
    ).toThrow('ops[0]: find: not found');
    expect(() =>
      applyOps(DOC, [{ op: 'replace', find: '## API', text: 'x' }])
    ).toThrow('ops[0]: find: found 2 times');
  });

  it('inserts above a heading and appends at the end of a section or the doc', () => {
    const r = applyOps(DOC, [
      { op: 'insert', before: '### Errors', text: 'Before errors.' },
      { op: 'append', section: 'Errors', text: 'More codes.' },
      { op: 'append', text: 'The end.' },
    ]);
    expect(r.body).toContain(
      'Old api.\nBefore errors.\n### Errors\nCodes.\nMore codes.\n## API\n'
    );
    expect(r.body.endsWith('None.\nThe end.\n')).toBe(true);
    expect(r.summary).toBe(
      'inserted before "### Errors"; appended to "### Errors"; appended'
    );
  });

  it('adds the newline a last line lacks before appending', () => {
    expect(
      applyOps({ title: 'T', body: '# T\nlast' }, [
        { op: 'append', text: 'next' },
      ]).body
    ).toBe('# T\nlast\nnext\n');
    expect(
      applyOps({ title: 'T', body: '# T' }, [
        { op: 'replace_section', section: 'T', text: 'body' },
      ]).body
    ).toBe('# T\nbody\n');
  });

  it('applies ops in order and is atomic when a later op fails', () => {
    // Frozen, so any write to the caller's doc would throw a TypeError instead.
    expect(() =>
      applyOps(Object.freeze({ ...DOC }), [
        { op: 'replace', find: 'Intro.', text: 'Changed.' },
        { op: 'replace_section', section: 'Missing', text: 'x' },
      ])
    ).toThrow('ops[1]: section "Missing" not found');
  });

  it('sets the title after checking it', () => {
    expect(
      applyOps(DOC, [{ op: 'set_title', title: 'Auth v2' }])
    ).toMatchObject({ title: 'Auth v2', summary: 'set the title' });
    expect(() =>
      applyOps(DOC, [{ op: 'set_title', title: 'two\nlines' }])
    ).toThrow('ops[0]');
  });

  it('normalizes CRLF in op text', () => {
    expect(
      applyOps(DOC, [{ op: 'replace', find: 'Intro.', text: 'a\r\nb' }]).body
    ).toContain('a\nb\n## API');
  });

  it('cuts the summary to 200 bytes', () => {
    const ops = Array.from({ length: 30 }, () => ({
      op: 'append' as const,
      text: 'x',
    }));
    expect(
      new TextEncoder().encode(applyOps(DOC, ops).summary).byteLength
    ).toBeLessThanOrEqual(200);
  });

  it('keeps a BOM in op text that lands inside the body', () => {
    const doc = { title: 'T', body: '# T\na b c\n' };
    expect(
      applyOps(doc, [{ op: 'replace', find: 'b', text: '\uFEFFb' }]).body
    ).toBe('# T\na \uFEFFb c\n');
    expect(
      applyOps(doc, [{ op: 'append', section: 'T', text: '\uFEFFd' }]).body
    ).toBe('# T\na b c\n\uFEFFd\n');
  });

  it('keeps the leading BOM the head already had', () => {
    const doc = { title: 'T', body: '\uFEFFx\n' };
    expect(applyOps(doc, [{ op: 'set_title', title: 'U' }]).body).toBe(
      '\uFEFFx\n'
    );
    expect(
      applyOps(doc, [{ op: 'replace', find: 'x', text: '\uFEFFy' }]).body
    ).toBe('\uFEFFy\n');
  });

  it('strips the leading BOMs an ops call adds', () => {
    expect(
      applyOps({ title: 'T', body: '' }, [
        { op: 'append', text: '\uFEFF\uFEFFx' },
      ]).body
    ).toBe('x\n');
    expect(
      applyOps({ title: 'T', body: '# T\n' }, [
        { op: 'insert', before: 'T', text: '\uFEFF\uFEFFx' },
      ]).body
    ).toBe('x\n# T\n');
    expect(
      applyOps({ title: 'T', body: 'X\uFEFFabc\n' }, [
        { op: 'replace', find: 'X', text: '' },
      ]).body
    ).toBe('abc\n');
  });

  it('matches find exactly, folding only line endings', () => {
    const doc = { title: 'T', body: 'a\uFEFFbc\nd\n' };
    expect(
      applyOps(doc, [{ op: 'replace', find: '\uFEFFbc', text: 'Q' }]).body
    ).toBe('aQ\nd\n');
    expect(
      applyOps(doc, [{ op: 'replace', find: '\uFEFF', text: '' }]).body
    ).toBe('abc\nd\n');
    expect(
      applyOps(doc, [{ op: 'replace', find: 'c\r\nd', text: 'C' }]).body
    ).toBe('a\uFEFFbC\n');
  });

  it('refuses an op kind that did not come through parseOps', () => {
    expect(() => applyOps(DOC, [{ op: 'bogus' } as unknown as DocOp])).toThrow(
      'ops[0].op'
    );
  });

  it('refuses an empty find that did not come through parseOps', () => {
    expect(() =>
      applyOps(DOC, [{ op: 'replace', find: '', text: 'x' }])
    ).toThrow('ops[0].find: 1 byte to 8 KiB');
  });

  it('refuses the op that takes the body over 768 KiB', () => {
    expect(() =>
      applyOps({ title: 'x', body: '# x\n' }, [
        { op: 'append', text: 'ok' },
        { op: 'append', text: '#\n'.repeat(400_000) },
        { op: 'append', section: 'x', text: 'never runs' },
      ])
    ).toThrow('ops[1]: the body would be over 768 KiB');
  });

  it('refuses section ops once a call has outlined too many lines', () => {
    const body = `# a\n${'\n'.repeat(700_000)}`;
    const once = applyOps({ title: 'a', body }, [
      { op: 'append', section: 'a', text: 'one' },
    ]);
    expect(once.body.endsWith('\none\n')).toBe(true);
    expect(() =>
      applyOps({ title: 'a', body }, [
        { op: 'append', section: 'a', text: 'one' },
        { op: 'insert', before: 'a', text: 'two' },
      ])
    ).toThrow(
      'ops[1]: these ops scan too much of a long doc; send fewer section ops, or save the whole body'
    );
  });

  it('counts heading lines as more work than plain lines', () => {
    const op: DocOp = { op: 'append', section: 'a', text: 'x' };
    const plain = `# a\n${'\n'.repeat(250_000)}`;
    expect(
      applyOps({ title: 'a', body: plain }, [op]).body.endsWith('\n\nx\n')
    ).toBe(true);
    const headings = `# a\n${'#\n'.repeat(250_000)}`;
    expect(() => applyOps({ title: 'a', body: headings }, [op])).toThrow(
      'ops[0]: these ops scan too much of a long doc'
    );
    expect(
      applyOps({ title: 'a', body: headings }, [
        { op: 'append', text: 'x' },
        { op: 'replace', find: '#\n#\n#\nx\n', text: 'end\n' },
      ]).body.endsWith('#\nend\n')
    ).toBe(true);
  });

  it('charges each replace a scan of the body against the budget', () => {
    const body = `# a\n${'\n'.repeat(620_000)}`;
    const section: DocOp = { op: 'append', section: 'a', text: 'x' };
    const same: DocOp = { op: 'replace', find: '# a\n', text: '# a\n' };
    expect(() =>
      applyOps({ title: 'a', body }, [section, section])
    ).not.toThrow();
    expect(() =>
      applyOps({ title: 'a', body }, [
        section,
        ...Array.from({ length: 10 }, () => same),
        section,
      ])
    ).toThrow('ops[11]: these ops scan');
  });

  it('does doc-end appends without spending the budget', () => {
    const body = `# a\n${'\n'.repeat(450_000)}`;
    const r = applyOps({ title: 'a', body }, [
      { op: 'append', section: 'a', text: 'first' },
      ...Array.from({ length: 47 }, () => ({
        op: 'append' as const,
        text: 'x',
      })),
      { op: 'replace', find: '# a\n', text: '# b\n' },
      { op: 'append', section: 'b', text: 'last' },
    ]);
    expect(r.body.startsWith('# b\n')).toBe(true);
    expect(r.body.endsWith(`first\n${'x\n'.repeat(47)}last\n`)).toBe(true);
  });
});

describe('parseOps', () => {
  it('accepts the five ops and refuses anything else by field', () => {
    expect(parseOps([{ op: 'append', text: 'x' }])).toEqual([
      { op: 'append', text: 'x' },
    ]);
    expect(() => parseOps([])).toThrow('ops: at least one op');
    expect(() =>
      parseOps(Array.from({ length: 51 }, () => ({ op: 'append', text: 'x' })))
    ).toThrow('ops: at most 50');
    expect(() => parseOps([{ op: 'delete' }])).toThrow('ops[0].op');
    expect(() => parseOps([{ op: 'replace', find: '', text: 'x' }])).toThrow(
      'ops[0].find: 1 byte to 8 KiB'
    );
    expect(() =>
      parseOps([{ op: 'replace', find: 'x'.repeat(8193), text: 'x' }])
    ).toThrow('ops[0].find');
    expect(() =>
      parseOps([{ op: 'replace_section', section: 1, text: 'x' }])
    ).toThrow('ops[0].section');
  });

  it('returns only the fields each op takes', () => {
    expect(
      parseOps([
        { op: 'append', text: 'x', junk: { deep: 1 } },
        { op: 'append', section: 'A', text: 'y', extra: 1 },
        { op: 'set_title', title: 'T', section: 'A' },
      ])
    ).toStrictEqual([
      { op: 'append', text: 'x' },
      { op: 'append', text: 'y', section: 'A' },
      { op: 'set_title', title: 'T' },
    ]);
  });

  it('refuses an op named after an object prototype member', () => {
    expect(() => parseOps([{ op: 'toString' }])).toThrow('ops[0].op');
    expect(() => parseOps([{ op: '__proto__' }])).toThrow('ops[0].op');
  });
});
