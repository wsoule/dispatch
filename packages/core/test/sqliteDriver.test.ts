import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openDispatchDb, queryOne } from '../src/sqliteDb.js';
import { SqliteTaskStore } from '../src/sqliteTaskStore.js';

const SQLITE_DB_SRC = resolve(import.meta.dir, '..', 'src', 'sqliteDb.ts');

/**
 * Pins which SQLite driver each runtime actually loads.
 *
 * This exists because `node:sqlite` does not exist in every Bun: it arrived in
 * 1.4.0, and the version `.prototools` pins — the one the release binaries and
 * CI are built with — is older than that. A build that loads `node:sqlite`
 * under Bun therefore works on a developer's machine and is dead in the
 * shipped product, which is exactly what happened.
 *
 * Note what these assert against. `sqliteDriver()` only reports what the
 * selector WOULD choose; a loader that ignored it and required the wrong
 * module would still satisfy it. So the assertions below read the `driver`
 * brand off a handle openDispatchDb actually built, which is the module that
 * was really loaded. Without that, on a Bun new enough to have both modules
 * the whole suite passes either way — and "a Bun new enough to have both" is
 * every Bun from 1.4.0 on, so the net would have died the moment the pin moved.
 */
describe('sqlite driver selection', () => {
  it('runs this suite under Bun, which is what makes the rest meaningful', () => {
    expect(process.versions.bun).toBeString();
  });

  it('loads bun:sqlite under Bun, not node:sqlite', () => {
    const db = openDispatchDb(':memory:');
    try {
      expect(db.driver).toBe('bun:sqlite');
    } finally {
      db.close();
    }
  });

  it('opens a database and round-trips a task through the loaded driver', () => {
    const db = openDispatchDb(':memory:');
    try {
      // Through the real store rather than hand-written SQL: a literal row has
      // to restate all 23 columns, and a second copy of that literal is how the
      // previous version of this file drifted into seeding an invalid priority.
      const store = new SqliteTaskStore(tmpdir(), db);
      const created = store.create({ title: 'Driver seam' });
      expect(store.get(created.meta.id)?.meta.title).toBe('Driver seam');
    } finally {
      db.close();
    }
  });

  /**
   * bun:sqlite's `Statement.get()` answers a miss with null; node:sqlite's
   * answers with undefined. queryOne is typed `Row | undefined` and callers
   * lean on that, so the seam has to normalize rather than pass the driver's
   * answer straight through.
   */
  it('reports a missing row as undefined, not null, whichever driver is loaded', () => {
    const db = openDispatchDb(':memory:');
    try {
      const missing = queryOne<{ title: string }>(
        db,
        'SELECT title FROM tasks WHERE id = ?',
        ['t-nope00']
      );
      expect(missing).toBeUndefined();
      expect(missing).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

// What a probe prints on stdout, whichever runtime runs it.
interface ProbeResult {
  driver: string;
  label: string;
  missIsUndefined: boolean;
}

// A self-contained script that opens a database, writes a row and reads it
// back, then reports the driver it got there through. Shared by the two
// out-of-process tests below so they prove the same thing about each runtime.
//
// It writes to a table it creates itself rather than to one of the schema's:
// the probe is about the driver, and coupling it to the DDL is how the
// previous version of this file ended up with a stale hand-written INSERT.
const PROBE = `
import { openDispatchDb } from ${JSON.stringify(SQLITE_DB_SRC)};
const db = openDispatchDb(':memory:');
db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, label TEXT NOT NULL)');
db.prepare('INSERT INTO probe (id, label) VALUES (?, ?)').run('p-1', 'probe');
console.log(
  JSON.stringify({
    driver: db.driver,
    label: db.prepare('SELECT label FROM probe WHERE id = ?').get('p-1').label,
    missIsUndefined:
      db.prepare('SELECT 1 FROM probe WHERE id = ?').get('nope') === undefined,
  })
);
db.close();
`;

// Reports a spawn's failure with the output attached, so a red test says what
// the subprocess actually printed instead of just "exit code 1".
function expectOk(
  step: string,
  result: { status: number | null; stdout: string; stderr: string }
): void {
  if (result.status !== 0) {
    throw new Error(
      `${step} exited ${String(result.status)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );
  }
}

/**
 * The Node half of the seam, which nothing else in this repo covers.
 *
 * Every test above runs under `bun test`, so they all exercise the Bun branch;
 * `node:sqlite` has no in-process coverage anywhere. That is the mirror image
 * of the bug this seam fixes — a branch nobody executes in the runtime it is
 * written for — so it is checked out of process instead of assumed.
 *
 * The probe is bundled for Node rather than run from source: node cannot
 * resolve this package's `./store.js` specifiers back to TypeScript.
 */
describe('the node:sqlite branch', () => {
  // node:sqlite ships unflagged from 22.13 only, and the Node on a CI runner
  // is not the one `.node-version` pins. Below that there is nothing to test
  // and the failure would be about the runner, not the code.
  const nodeVersion = ((): string | null => {
    const probe = spawnSync('node', ['-p', 'process.versions.node'], {
      encoding: 'utf8',
    });
    return probe.status === 0 ? probe.stdout.trim() : null;
  })();

  const supported = ((): boolean => {
    if (nodeVersion === null) return false;
    const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 13);
  })();

  if (!supported) {
    console.warn(
      `[sqliteDriver.test] skipping the node:sqlite branch: node ${nodeVersion ?? 'not found on PATH'} has no unflagged node:sqlite (needs >= 22.13). The Bun branch is still covered; the Node branch is NOT verified in this run.`
    );
  }

  it.skipIf(!supported)(
    'opens a database through node:sqlite when the runtime is Node',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dispatch-node-driver-'));
      try {
        writeFileSync(join(dir, 'probe.ts'), PROBE);
        // `bun build` without --compile: a plain ESM bundle Node can run, so
        // this costs a bundle rather than a 70 MB executable.
        const bundled = spawnSync(
          process.execPath,
          [
            'build',
            '--target',
            'node',
            '--format',
            'esm',
            'probe.ts',
            '--outfile',
            'probe.mjs',
          ],
          { cwd: dir, encoding: 'utf8' }
        );
        expectOk('bun build --target node', bundled);

        const ran = spawnSync('node', ['probe.mjs'], {
          cwd: dir,
          encoding: 'utf8',
        });
        expectOk('node probe.mjs', ran);
        expect(JSON.parse(ran.stdout) as ProbeResult).toEqual({
          driver: 'node:sqlite',
          label: 'probe',
          missIsUndefined: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000
  );
});

/**
 * The bug this seam fixes only ever showed up in a `bun build --compile`
 * binary, so one test actually compiles one.
 *
 * The driver-brand tests above are the guard that catches a regression on any
 * Bun; this is the one that proves the whole path holds end to end — that the
 * bundler leaves the `createRequire` driver load alone instead of resolving it
 * at build time, and that the driver is really there once the runtime has been
 * baked into an executable. Nothing cheaper covers that: the repo's existing
 * compiled-binary smoke test (scripts/build-sidecar.ts) boots dispatchd
 * against a file-backed project and never opens a database at all, which is
 * precisely how a released binary shipped with a dead one.
 *
 * It compiles a ~70 MB executable, so it runs in CI and on request rather than
 * on every local `bun test`.
 */
describe('the compiled-binary path', () => {
  const optedIn =
    process.env.CI !== undefined ||
    process.env.DISPATCH_TEST_COMPILE !== undefined;

  if (!optedIn) {
    console.warn(
      '[sqliteDriver.test] skipping the compiled-binary test (~70 MB build). Set DISPATCH_TEST_COMPILE=1 to run it locally; CI always does.'
    );
  }

  it.skipIf(!optedIn)(
    'opens a database from an executable compiled by the running Bun',
    () => {
      // The compile runs in the temp dir too, not just the probe: `bun build
      // --compile` drops a stray `.<hash>-00000000.bun-build` staging file in
      // its cwd, which has no business landing in the repo root.
      const dir = mkdtempSync(join(tmpdir(), 'dispatch-compile-'));
      try {
        writeFileSync(join(dir, 'probe.ts'), PROBE);
        // process.execPath, never a bare 'bun': PATH here serves a different
        // Bun than .prototools pins, and this test is worthless if it proves
        // the wrong toolchain works.
        const built = spawnSync(
          process.execPath,
          ['build', '--compile', 'probe.ts', '--outfile', 'probe'],
          { cwd: dir, encoding: 'utf8' }
        );
        expectOk('bun build --compile', built);

        const ran = spawnSync(join(dir, 'probe'), [], {
          cwd: dir,
          encoding: 'utf8',
        });
        expectOk('the compiled probe', ran);
        expect(JSON.parse(ran.stdout) as ProbeResult).toEqual({
          driver: 'bun:sqlite',
          label: 'probe',
          missIsUndefined: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
