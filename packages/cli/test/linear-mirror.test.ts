import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The CLI mirrors the daemon's Linear types by hand (the server is FSL and
// unimportable here), so this reads both sources to catch a field that drifts.

function serverSource(file: string): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  return readFileSync(
    join(dirname(pkgJsonPath), 'src', 'linear', file),
    'utf8'
  );
}

const CLI_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'apiClient.ts'),
  'utf8'
);

// An interface's top-level member names: those indented one level, so the
// members of a nested object type are left out.
function members(source: string, name: string): string[] {
  const start = new RegExp(`^(?:export )?interface ${name} \\{$`, 'm').exec(
    source
  );
  if (start === null) throw new Error(`no interface ${name}`);
  const body = source.slice(start.index + start[0].length);
  const end = body.search(/^\}$/m);
  return [...body.slice(0, end).matchAll(/^ {2}(\w+)\??:/gm)]
    .map((m) => m[1] ?? '')
    .sort();
}

describe('Linear mirror types', () => {
  it.each([
    ['LinearSyncSummary', 'reconcile.ts'],
    ['LinearBulkOutcome', 'state.ts'],
    ['LinearCapacity', 'client.ts'],
    ['LinearCoverage', 'coverage.ts'],
    ['LinearExportPreview', 'coverage.ts'],
    ['LinearUnlinkedTask', 'coverage.ts'],
    ['LinearProgress', 'sync.ts'],
  ])('%s carries every field the server sends', (name, file) => {
    const cli = members(CLI_SOURCE, name);
    expect(cli.length).toBeGreaterThanOrEqual(4);
    expect(cli).toEqual(members(serverSource(file), name));
  });

  it('LinearStatus reads only fields the server sends', () => {
    const server = new Set(members(serverSource('sync.ts'), 'LinearStatus'));
    const cli = members(CLI_SOURCE, 'LinearStatus');
    expect(cli).toContain('lastExport');
    expect(cli.filter((field) => !server.has(field))).toEqual([]);
  });
});
