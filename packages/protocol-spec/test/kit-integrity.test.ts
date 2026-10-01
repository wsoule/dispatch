import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { isRecord } from '../src/guards.js';
import { LINE_BREAK } from '../src/lines.js';
import { loadVectors, VECTORS_DIR } from '../src/load.js';
import { loadRegistry, REGISTRY_NAMES } from '../src/registries.js';
import { listSections, SPEC_DIR } from '../src/sections.js';

const { vectors } = loadVectors();
const ids = new Set(vectors.map((v) => v.id));
const sections = new Set(listSections(SPEC_DIR));

// Every line break of §1.4, each sequence once.
const BREAKS = ['\r\n', '\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'];

// The distinct line-break sequences in every string under `value`, sorted.
function breaksIn(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string')
      for (const m of v.matchAll(new RegExp(LINE_BREAK.source, 'g')))
        found.add(m[0]);
    else if (typeof v === 'object' && v !== null)
      Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found].sort();
}

describe('the kit', () => {
  it('names only sections that exist', () => {
    for (const v of vectors)
      for (const s of v.sections)
        expect({ id: v.id, s, ok: sections.has(s) }).toEqual({
          id: v.id,
          s,
          ok: true,
        });
  });

  it('lists only vectors that exist in every registry entry', () => {
    const registry = loadRegistry();
    for (const name of REGISTRY_NAMES)
      for (const e of registry[name])
        for (const id of e.vectors)
          expect({ entry: e.value, id, ok: ids.has(id) }).toEqual({
            entry: e.value,
            id,
            ok: true,
          });
  });

  // A provisional entry has no vectors yet (§11.11), so it lists none and no
  // vector tests a section that provisional entries alone define.
  it('tests no provisional entry', () => {
    const registry = loadRegistry();
    const statuses = new Map<string, Set<string>>();
    const listed: string[] = [];
    for (const name of REGISTRY_NAMES)
      for (const e of registry[name]) {
        statuses.set(
          e.section,
          (statuses.get(e.section) ?? new Set()).add(e.status)
        );
        if (e.status === 'provisional')
          listed.push(...e.vectors.map((id) => `${e.value}: ${id}`));
      }
    expect(listed).toEqual([]);
    const provisional = (s: string) => {
      const found = statuses.get(s);
      return found?.size === 1 && found.has('provisional');
    };
    expect(
      vectors.filter((v) => v.sections.some(provisional)).map((v) => v.id)
    ).toEqual([]);
  });

  // A handoff exists only through work/v1 (§8.6), so while that extension is
  // provisional no vector validates a work/v1 request or projects a handoff;
  // once it is permanent, vectors do both.
  it('tests handoffs exactly when work/v1 is permanent', () => {
    const work = loadRegistry()['extension-uris'].find((e) =>
      e.value.endsWith('/a2a/ext/work/v1')
    );
    const handoffs = vectors.filter((v) =>
      v.when.some(
        (s) =>
          (s.op === 'a2a.validate' && s['extension'] === 'work') ||
          (s.op === 'a2a.project' &&
            isRecord(s['facts']) &&
            s['facts']['skill'] === 'handoff')
      )
    );
    const ops = new Set(handoffs.flatMap((v) => v.when.map((s) => s.op)));
    expect({ status: work?.status, ops: [...ops].sort() }).toEqual(
      work?.status === 'permanent'
        ? { status: 'permanent', ops: ['a2a.project', 'a2a.validate'] }
        : { status: 'provisional', ops: [] }
    );
  });

  // §12.3: the literal system address makes a vector dispatch; core ones write $system.
  it('writes no core vector with the literal agent:dispatch', () => {
    const literal = vectors
      .filter((v) => v.profile === 'core')
      .filter((v) => JSON.stringify(v).includes('agent:dispatch'))
      .map((v) => v.id);
    expect(literal).toEqual([]);
  });

  // Raw, these three are invisible in a diff and some editors strip them.
  it('writes NEL, U+2028 and U+2029 in vector files as JSON escapes', () => {
    const files = readdirSync(VECTORS_DIR, {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const lines = readFileSync(new URL(f, VECTORS_DIR), 'utf8').split('\n');
      const raw = lines.flatMap((line, i) =>
        /[\u0085\u2028\u2029]/.test(line) ? [`${f}:${i + 1}`] : []
      );
      expect(raw).toEqual([]);
    }
  });

  it('sends every line break of §1.4 through a push and a digest', () => {
    for (const id of [
      'core.render.every-line-break-starts-a-quoted-line',
      'core.render.a-digest-ends-at-the-first-line-break',
    ]) {
      const v = vectors.find((x) => x.id === id);
      expect({ id, breaks: breaksIn(v?.when) }).toEqual({
        id,
        breaks: [...BREAKS].sort(),
      });
    }
  });
});
