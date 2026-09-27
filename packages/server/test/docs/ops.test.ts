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
    const doc = { ...DOC };
    expect(() =>
      applyOps(doc, [
        { op: 'replace', find: 'Intro.', text: 'Changed.' },
        { op: 'replace_section', section: 'Missing', text: 'x' },
      ])
    ).toThrow('ops[1]: section "Missing" not found');
    expect(doc.body).toBe(DOC.body);
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

  it('refuses an op named after an object prototype member', () => {
    expect(() => parseOps([{ op: 'toString' }])).toThrow('ops[0].op');
    expect(() => parseOps([{ op: '__proto__' }])).toThrow('ops[0].op');
  });
});
