#!/usr/bin/env bun
// Freezes a release: copies spec/, schemas/ and registries/ to
// versions/<version>/ and records each file's sha256 in versions/manifest.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { VersionsManifest } from '../src/versions.js';
import { computeAliases, extensionSource, isVersion } from '../src/versions.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const versionsDir = join(pkgDir, 'versions');
const manifestPath = join(versionsDir, 'manifest.json');
const FROZEN = ['spec', 'schemas', 'registries'];
const SCHEMA_ID_PREFIX = /https:\/\/dispatch\.foo\/protocol\/[^/]+\/schemas\//g;
// The §8 subsection each extension URI renders.
const EXTENSION_SECTIONS: Record<string, string> = {
  envelope: '## 8.4 ',
  gate: '## 8.5 ',
  work: '## 8.6 ',
};

function fail(message: string): never {
  console.error(`snapshot: ${message}`);
  process.exit(1);
}

// Points every schema $id under the given schemas directory at `version`.
function pinSchemaIds(dir: string, version: string): void {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.schema.json'))) {
    const path = join(dir, f);
    const text = readFileSync(path, 'utf8');
    const pinned = text.replace(
      SCHEMA_ID_PREFIX,
      `https://dispatch.foo/protocol/${version}/schemas/`
    );
    if (pinned !== text) writeFileSync(path, pinned);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Object keys sorted at every depth, so the manifest's bytes are stable.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
  );
}

const version = process.argv[2] ?? '';
if (!isVersion(version)) fail(`usage: snapshot <semver>; got "${version}"`);
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  version: string;
};
if (pkg.version !== version)
  fail(`package.json is at ${pkg.version}; bump it to ${version} first`);
const target = join(versionsDir, version);
if (existsSync(target))
  fail(
    `versions/${version}/ exists: released text never changes; cut the next draft`
  );

const registries = spawnSync(process.execPath, ['scripts/registries.ts'], {
  cwd: pkgDir,
  stdio: 'inherit',
});
if (registries.status !== 0) fail('scripts/registries.ts failed');

pinSchemaIds(join(pkgDir, 'schemas'), version);
for (const d of FROZEN)
  cpSync(join(pkgDir, d), join(target, d), { recursive: true });
pinSchemaIds(join(target, 'schemas'), version);

const files: Record<string, string> = {};
for (const path of walk(target)) {
  const key = relative(target, path).split('\\').join('/');
  files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
}

const previous = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as VersionsManifest)
  : { versions: {} };
const versions = {
  ...previous.versions,
  [version]: { date: new Date().toISOString().slice(0, 10), files },
};
const names = Object.keys(versions);
const bindingText = (v: string): string => {
  const path = join(versionsDir, v, 'spec', '08-a2a-binding.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const extensions: Record<string, string> = {};
for (const [name, heading] of Object.entries(EXTENSION_SECTIONS)) {
  const source = extensionSource(names, (v) =>
    bindingText(v)
      .split('\n')
      .some((l) => l.startsWith(heading))
  );
  if (source !== null) extensions[name] = source;
}
const manifest: VersionsManifest = {
  versions,
  aliases: computeAliases(names),
  extensions,
};
writeFileSync(manifestPath, `${JSON.stringify(sortKeys(manifest), null, 2)}\n`);
console.log(
  `froze ${Object.keys(files).length} files under versions/${version}/`
);
