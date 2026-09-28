import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  computeAliases,
  extensionSource,
} from '../src/versions.js';
import type { VersionsManifest } from '../src/versions.js';

describe('version rules', () => {
  it('orders drafts, releases and later drafts', () => {
    const sorted = [
      '1.1.0',
      '1.0.0-draft.10',
      '1.0.0',
      '1.1.0-draft.1',
      '1.0.0-draft.2',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      '1.0.0-draft.2',
      '1.0.0-draft.10',
      '1.0.0',
      '1.1.0-draft.1',
      '1.1.0',
    ]);
  });
  it('points latest at the newest draft until a release exists', () => {
    expect(computeAliases(['1.0.0-draft.1'])).toEqual({
      latest: '1.0.0-draft.1',
      draft: '1.0.0-draft.1',
    });
    expect(computeAliases(['1.0.0-draft.1', '1.0.0', '1.1.0-draft.1'])).toEqual(
      { latest: '1.0.0', draft: '1.1.0-draft.1', '1.0': '1.0.0' }
    );
  });
  it('renders a stable extension URI from the newest non-pre-release that has it', () => {
    const has = (v: string): boolean => v !== '1.0.0';
    expect(
      extensionSource(['1.0.0-draft.1', '1.0.0-draft.2'], () => true)
    ).toBe('1.0.0-draft.2');
    expect(
      extensionSource(['1.0.0-draft.1', '1.0.0', '1.1.0-draft.1'], () => true)
    ).toBe('1.0.0');
    expect(
      extensionSource(['1.0.0-draft.1', '1.0.0', '1.1.0-draft.1'], has)
    ).toBe('1.1.0-draft.1');
  });
});

describe('frozen versions', () => {
  const dir = fileURLToPath(new URL('../versions/', import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf8')
  ) as VersionsManifest;
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]
    );

  it('never changes a released file', () => {
    for (const [version, { files }] of Object.entries(manifest.versions)) {
      const onDisk = walk(join(dir, version))
        .map((f) => relative(join(dir, version), f).split('\\').join('/'))
        .sort();
      expect(onDisk).toEqual(Object.keys(files).sort());
      for (const [path, sha] of Object.entries(files)) {
        const actual = createHash('sha256')
          .update(readFileSync(join(dir, version, path)))
          .digest('hex');
        expect({ version, path, sha: actual }).toEqual({ version, path, sha });
      }
    }
  });
  it('records the aliases the rules compute', () => {
    expect(manifest.aliases).toEqual(
      computeAliases(Object.keys(manifest.versions))
    );
  });
  // A frozen schema names the version it was frozen under.
  it("names its own version in every frozen schema's $id", () => {
    for (const version of Object.keys(manifest.versions)) {
      const schemas = join(dir, version, 'schemas');
      for (const f of readdirSync(schemas)) {
        const { $id } = JSON.parse(readFileSync(join(schemas, f), 'utf8')) as {
          $id: string;
        };
        expect({ version, f, $id }).toEqual({
          version,
          f,
          $id: `https://dispatch.foo/protocol/${version}/schemas/${f}`,
        });
      }
    }
  });
});
