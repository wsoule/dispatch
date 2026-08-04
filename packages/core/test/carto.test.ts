import { describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cartoInit,
  cartoSyncAsync,
  checkCartoHealth,
  discoverCarto,
  openCartoReader,
  pinHookWorkingDirs,
  redirectCartoOutput,
  supportsMcpServe,
} from '../src/carto.js';

// Writes an executable stub named `carto` that prints `version` for --version.
function writeFakeCarto(binDir: string, version: string): void {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'carto');
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
}

// Writes an executable `carto` stub whose `init` behavior is the given
// shell `body`, run with cwd set to the project root.
function writeStubCartoBinary(
  binDir: string,
  body: string
): { path: string; version: string } {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'carto');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { path: file, version: '2.9.9' };
}

// Writes an executable `carto` stub whose `doctor --json` prints `payload`
// and exits `exitCode`, so health-probe tests exercise the JSON contract
// rather than whatever carto is installed on the machine running them.
function writeDoctorStub(
  binDir: string,
  payload: string,
  exitCode = 0
): { path: string; version: string } {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'carto');
  writeFileSync(
    file,
    `#!/bin/sh\ncat <<'CARTO_JSON'\n${payload}\nCARTO_JSON\nexit ${String(exitCode)}\n`
  );
  chmodSync(file, 0o755);
  return { path: file, version: '2.1.4' };
}

// Installs a `loadAnci()` that always throws `sentinel` at
// packages/core/node_modules/carto-md/src/anci/consumer.js — nearer on the
// require search path than any real carto-md install, so it wins
// deterministically whether or not carto-md happens to be installed
// elsewhere on the machine running the test. Returns a cleanup function.
function installFakeCartoConsumer(sentinel: string): () => void {
  const packageDir = join(
    import.meta.dirname,
    '..',
    'node_modules',
    'carto-md'
  );
  const consumerDir = join(packageDir, 'src', 'anci');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'consumer.js'),
    `exports.loadAnci = function loadAnci() { throw new Error(${JSON.stringify(sentinel)}); };\n`
  );
  return () => rmSync(packageDir, { recursive: true, force: true });
}

describe('discoverCarto', () => {
  it('finds carto on PATH and reports its version', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '2.1.3');
      const result = discoverCarto({ PATH: binDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.binary.path).toBe(join(binDir, 'carto'));
        expect(result.binary.version).toBe('2.1.3');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not-found rather than throwing when carto is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = discoverCarto({ PATH: join(root, 'empty') }, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a version below the 2.x floor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, '1.9.0');
      const result = discoverCarto({ PATH: binDir }, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported-version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PATH cannot express "no carto here": discovery also searches the two
  // Homebrew prefixes, where an `npm install -g` carto commonly lands.
  it('reports not-found when DISPATCH_CARTO_DISABLED=1, even with carto present', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, 'carto-md 2.1.3');
      const result = discoverCarto({
        PATH: binDir,
        DISPATCH_CARTO_DISABLED: '1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The real carto-md CLI's --version prints `${pkg.name} ${pkg.version}`
  // ("carto-md 2.1.3"), not a bare version number — reproduced here rather
  // than assumed, since a bare-number parse silently reports every genuine
  // install as unsupported.
  it('parses the real CLI\'s "carto-md 2.1.3" --version format', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binDir = join(root, 'bin');
      writeFakeCarto(binDir, 'carto-md 2.1.3');
      const result = discoverCarto({ PATH: binDir });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.binary.version).toBe('2.1.3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('openCartoReader', () => {
  it('reports no-container when .carto is absent, rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('no-container');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports load-failed when .carto exists but is unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    const sentinel = 'SENTINEL: fake loadAnci threw';
    const uninstall = installFakeCartoConsumer(sentinel);
    try {
      mkdirSync(join(root, '.carto'), { recursive: true });
      writeFileSync(join(root, '.carto', 'carto.db'), 'not a database');
      const result = openCartoReader(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('load-failed');
        // Pins that the failure is `loadAnci()`'s own throw, mapped through
        // by openCartoReader — not merely require() failing to resolve the
        // specifier, which would produce a different message here. A wrong
        // require specifier, or a loadAnci throw no longer mapped to
        // load-failed, would fail this assertion.
        expect(result.detail).toBe(sentinel);
      }
    } finally {
      uninstall();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// carto 2.1.4 fixed the `carto serve` transport bug (carto#9): reached
// through the `carto` bin, server.js's `require.main === module` guard was
// false, so the stdio transport never connected and the MCP entry Dispatch
// wires into every run was inert.
describe('supportsMcpServe', () => {
  it('rejects 2.1.3, whose `carto serve` never connects its transport', () => {
    expect(supportsMcpServe('2.1.3')).toBe(false);
  });

  it('accepts 2.1.4, the release that connects it', () => {
    expect(supportsMcpServe('2.1.4')).toBe(true);
  });

  it('accepts later releases', () => {
    expect(supportsMcpServe('2.2.0')).toBe(true);
    expect(supportsMcpServe('3.0.0')).toBe(true);
    expect(supportsMcpServe('2.1.10')).toBe(true);
  });

  // Numeric comparison, not lexicographic: '2.1.9' < '2.1.10' as versions
  // but sorts after it as text.
  it('compares parts numerically rather than as text', () => {
    expect(supportsMcpServe('2.1.30')).toBe(true);
    expect(supportsMcpServe('10.0.0')).toBe(true);
  });

  // A version string shorter than the floor still has to place correctly:
  // '2.2' outranks 2.1.4, '2.1' does not.
  it('treats missing version parts as zero', () => {
    expect(supportsMcpServe('2.2')).toBe(true);
    expect(supportsMcpServe('2.1')).toBe(false);
    expect(supportsMcpServe('2')).toBe(false);
  });

  it('rejects a version it cannot parse rather than assuming support', () => {
    expect(supportsMcpServe('')).toBe(false);
    expect(supportsMcpServe('unknown')).toBe(false);
  });
});

describe('checkCartoHealth', () => {
  const ALL_OK = `{
  "results": [
    { "id": "node-version", "status": "ok", "label": "Node 22.19.0", "detail": "supported", "fix": null },
    { "id": "native-better-sqlite3", "status": "ok", "label": "Native module: better-sqlite3", "detail": "loaded", "fix": null },
    { "id": "index-exists", "status": "ok", "label": "Index at .carto/carto.db", "detail": "present", "fix": null }
  ],
  "ok": true
}`;

  it('reports healthy when every check passes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeDoctorStub(join(root, 'bin'), ALL_OK);
      expect(checkCartoHealth(root, binary).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The failure `dispatch doctor` could not previously see: `carto --version`
  // never loads a native module, so a carto with unbuilt bindings reported as
  // healthy while every `carto init` died.
  it('reports the failing check when a native module is broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeDoctorStub(
        join(root, 'bin'),
        `{
  "results": [
    { "id": "native-tree-sitter", "status": "fail", "label": "Native module: tree-sitter", "detail": "failed: No native build was found", "fix": "Reinstall the package: \`npm install -g carto-md\`." }
  ],
  "ok": false
}`,
        1
      );
      const health = checkCartoHealth(root, binary);
      expect(health.ok).toBe(false);
      if (!health.ok && health.reason === 'unhealthy') {
        expect(health.failures).toHaveLength(1);
        expect(health.failures[0]?.id).toBe('native-tree-sitter');
        expect(health.failures[0]?.detail).toContain('No native build');
        expect(health.failures[0]?.fix).toContain('npm install -g carto-md');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A missing container is a normal state under `carto.enabled: detect`, and
  // one `on` builds on demand — it is not an install defect, so it must not
  // make a working carto report as broken.
  it('does not treat a missing index as an unhealthy install', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeDoctorStub(
        join(root, 'bin'),
        `{
  "results": [
    { "id": "native-better-sqlite3", "status": "ok", "label": "Native module: better-sqlite3", "detail": "loaded", "fix": null },
    { "id": "index-exists", "status": "fail", "label": "Index at .carto/carto.db", "detail": "missing", "fix": "Run \`carto init\` to create the index." }
  ],
  "ok": false
}`,
        1
      );
      expect(checkCartoHealth(root, binary).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports every failing check, not just the first', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeDoctorStub(
        join(root, 'bin'),
        `{
  "results": [
    { "id": "native-tree-sitter", "status": "fail", "label": "Native module: tree-sitter", "detail": "failed", "fix": null },
    { "id": "grammars", "status": "fail", "label": "Tree-sitter grammars", "detail": "2 missing", "fix": null }
  ],
  "ok": false
}`,
        1
      );
      const health = checkCartoHealth(root, binary);
      expect(health.ok).toBe(false);
      if (!health.ok && health.reason === 'unhealthy') {
        expect(health.failures.map((f) => f.id)).toEqual([
          'native-tree-sitter',
          'grammars',
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // An older 2.x without `doctor --json`, or a carto that dies before it
  // prints, is unknown — not broken. The caller says so rather than
  // reporting a working install as defective.
  it('reports unreadable when the output is not the expected JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeDoctorStub(
        join(root, 'bin'),
        'Usage: carto <cmd>',
        1
      );
      const health = checkCartoHealth(root, binary);
      expect(health.ok).toBe(false);
      if (!health.ok) expect(health.reason).toBe('unreadable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unreadable when the binary cannot be spawned', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const health = checkCartoHealth(root, {
        path: join(root, 'nope', 'carto'),
        version: '2.1.4',
      });
      expect(health.ok).toBe(false);
      if (!health.ok) expect(health.reason).toBe('unreadable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // .carto/ only ever exists at the project root, so the probe must run
  // there — the same cwd pinning cartoSync already does.
  it('runs the probe at the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    const spy = spyOn(childProcess, 'spawnSync');
    try {
      const binary = writeDoctorStub(join(root, 'bin'), ALL_OK);
      checkCartoHealth(root, binary);
      expect(spy.mock.calls[0]?.[1]).toEqual(['doctor', '--json']);
      expect(spy.mock.calls[0]?.[2]).toMatchObject({ cwd: root });
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pinHookWorkingDirs', () => {
  it('rewrites carto sync to cd to the main worktree first', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\n# carto-md: keep index fresh on git events\ncarto sync >/dev/null 2>&1 || true\n'
      );
      const rewritten = pinHookWorkingDirs(root);
      expect(rewritten).toContain(join(hooks, 'pre-commit'));
      const body = readFileSync(join(hooks, 'pre-commit'), 'utf8');
      expect(body).toContain('--git-common-dir');
      expect(body).not.toMatch(/^carto sync/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second call does not double-wrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
      );
      pinHookWorkingDirs(root);
      const once = readFileSync(join(hooks, 'pre-commit'), 'utf8');
      pinHookWorkingDirs(root);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe(once);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves unrelated hook lines untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, 'pre-commit'),
        '#!/bin/sh\nbun run lint\ncarto sync >/dev/null 2>&1 || true\n'
      );
      pinHookWorkingDirs(root);
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain(
        'bun run lint'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites all four hooks in one call, not just the first match', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      // pre-commit is deliberately long so a successful match on it leaves
      // BARE_SYNC_RE.lastIndex far into the string; the shorter hooks below
      // would be silently skipped if a leftover lastIndex ever leaked
      // across loop iterations (see BARE_SYNC_RE's reset, and its comment).
      writeFileSync(
        join(hooks, 'pre-commit'),
        `#!/bin/sh\n${'#'.repeat(500)}\ncarto sync >/dev/null 2>&1 || true\n`
      );
      for (const name of ['post-checkout', 'post-merge', 'post-rewrite']) {
        writeFileSync(
          join(hooks, name),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
      }
      const rewritten = pinHookWorkingDirs(root);
      expect(rewritten).toHaveLength(4);
      for (const name of [
        'pre-commit',
        'post-checkout',
        'post-merge',
        'post-rewrite',
      ]) {
        expect(readFileSync(join(hooks, name), 'utf8')).toContain(
          '--git-common-dir'
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // chmod 000 does not deny access to root, so this test is meaningless
  // (and would fail) when the suite runs as root.
  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'skips an unreadable hook without throwing, and still pins the others',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      try {
        const hooks = join(root, '.git', 'hooks');
        mkdirSync(hooks, { recursive: true });
        writeFileSync(
          join(hooks, 'pre-commit'),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
        chmodSync(join(hooks, 'pre-commit'), 0o000);
        writeFileSync(
          join(hooks, 'post-checkout'),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
        let rewritten: string[] = [];
        expect(() => {
          rewritten = pinHookWorkingDirs(root);
        }).not.toThrow();
        expect(rewritten).toContain(join(hooks, 'post-checkout'));
        expect(rewritten).not.toContain(join(hooks, 'pre-commit'));
        expect(readFileSync(join(hooks, 'post-checkout'), 'utf8')).toContain(
          '--git-common-dir'
        );
      } finally {
        try {
          chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o644);
        } catch {
          // pre-commit may not have been created if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'returns no rewritten hooks, without throwing, when the hooks dir is unreadable',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      try {
        const hooks = join(root, '.git', 'hooks');
        mkdirSync(hooks, { recursive: true });
        writeFileSync(
          join(hooks, 'pre-commit'),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
        chmodSync(hooks, 0o000);
        let rewritten: string[] = [];
        expect(() => {
          rewritten = pinHookWorkingDirs(root);
        }).not.toThrow();
        expect(rewritten).toEqual([]);
      } finally {
        try {
          chmodSync(join(root, '.git', 'hooks'), 0o755);
        } catch {
          // hooks dir may not have been created if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'skips a hook it cannot write, without throwing, and still pins the others',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      try {
        const hooks = join(root, '.git', 'hooks');
        mkdirSync(hooks, { recursive: true });
        writeFileSync(
          join(hooks, 'pre-commit'),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
        chmodSync(join(hooks, 'pre-commit'), 0o444);
        writeFileSync(
          join(hooks, 'post-checkout'),
          '#!/bin/sh\ncarto sync >/dev/null 2>&1 || true\n'
        );
        let rewritten: string[] = [];
        expect(() => {
          rewritten = pinHookWorkingDirs(root);
        }).not.toThrow();
        expect(rewritten).toContain(join(hooks, 'post-checkout'));
        expect(rewritten).not.toContain(join(hooks, 'pre-commit'));
        expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).not.toContain(
          '--git-common-dir'
        );
      } finally {
        try {
          chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o644);
        } catch {
          // pre-commit may not have been created if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});

describe('redirectCartoOutput', () => {
  it('repoints config.output away from AGENTS.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      mkdirSync(join(root, '.carto'), { recursive: true });
      writeFileSync(
        join(root, '.carto', 'config.json'),
        JSON.stringify({ version: '2', output: 'AGENTS.md' })
      );
      redirectCartoOutput(root);
      const config = JSON.parse(
        readFileSync(join(root, '.carto', 'config.json'), 'utf8')
      ) as { output: string; version: string };
      expect(config.output).toBe('.carto/CONTEXT.md');
      expect(config.version).toBe('2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when there is no config to repoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      expect(() => redirectCartoOutput(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Reached from cartoInit via DepMapCache.build() during a review, so a
  // throw here would fail the review run this integration must never fail.
  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'does not throw when the config file cannot be written',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      const config = join(root, '.carto', 'config.json');
      try {
        mkdirSync(join(root, '.carto'), { recursive: true });
        writeFileSync(config, JSON.stringify({ output: 'AGENTS.md' }));
        chmodSync(config, 0o444);
        expect(() => redirectCartoOutput(root)).not.toThrow();
      } finally {
        try {
          chmodSync(config, 0o644);
        } catch {
          // config.json may not exist if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});

describe('cartoInit', () => {
  it('restores AGENTS.md byte-for-byte even when the binary overwrites it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const sentinel = 'SENTINEL: original AGENTS.md must survive carto init\n';
      writeFileSync(join(root, 'AGENTS.md'), sentinel);
      // Stub mimics carto init's real side effect: it clobbers AGENTS.md
      // and builds a container.
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'echo "carto wrote this" > AGENTS.md',
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'touch .carto/carto.db',
          'exit 0',
        ].join('\n')
      );
      const result = cartoInit(root, binary);
      expect(result.ok).toBe(true);
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the AGENTS.md carto init creates when none existed before', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'echo "carto wrote this" > AGENTS.md',
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'touch .carto/carto.db',
          'exit 0',
        ].join('\n')
      );
      const result = cartoInit(root, binary);
      expect(result.ok).toBe(true);
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repoints config.output so AGENTS.md is safe on every later sync', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'touch .carto/carto.db',
          'exit 0',
        ].join('\n')
      );
      cartoInit(root, binary);
      const config = JSON.parse(
        readFileSync(join(root, '.carto', 'config.json'), 'utf8')
      ) as { output: string };
      expect(config.output).not.toBe('AGENTS.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Every container builder goes through here — `dispatch init` on an
  // already-initialized project, and the daemon's first review in `on` mode.
  it('gitignores .carto/ wherever it builds a container', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        ['mkdir -p .carto', 'touch .carto/carto.db', 'exit 0'].join('\n')
      );
      cartoInit(root, binary);
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain(
        '.carto/'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gitignores the .carto/ a failed init leaves behind', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'exit 1',
        ].join('\n')
      );
      expect(cartoInit(root, binary).ok).toBe(false);
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain(
        '.carto/'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves .gitignore alone when carto never created a container dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(join(root, 'bin'), 'exit 1');
      cartoInit(root, binary);
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports failure when the binary exits 0 but produces no container', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      // Reproduces the measured carto 2.1.3 failure mode: fatal error on
      // stderr, exit code 0, .carto/ left with only config.json.
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'echo "Fatal error: Could not locate the bindings file" 1>&2',
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'exit 0',
        ].join('\n')
      );
      const result = cartoInit(root, binary);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Fatal error');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports success when the container exists and exit status is 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        [
          'mkdir -p .carto',
          'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
          'touch .carto/carto.db',
          'exit 0',
        ].join('\n')
      );
      const result = cartoInit(root, binary);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('2.9.9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // chmod 000/444 do not deny access to root, so these tests are
  // meaningless (and would fail) when the suite runs as root.
  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'reports failure instead of throwing when AGENTS.md cannot be snapshotted',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      try {
        const agents = join(root, 'AGENTS.md');
        writeFileSync(agents, 'original\n');
        chmodSync(agents, 0o000);
        // Never actually invoked: cartoInit must fail before spawning carto.
        const binary = { path: join(root, 'no-such-carto'), version: '2.9.9' };
        let result: { ok: boolean; detail: string } | undefined;
        expect(() => {
          result = cartoInit(root, binary);
        }).not.toThrow();
        expect(result?.ok).toBe(false);
        expect(result?.detail).toContain('snapshot');
      } finally {
        try {
          chmodSync(join(root, 'AGENTS.md'), 0o644);
        } catch {
          // AGENTS.md may not have been created if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf((process.getuid?.() ?? -1) === 0)(
    'reports failure instead of throwing when AGENTS.md cannot be restored, and still cleans up the backup',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
      try {
        writeFileSync(join(root, 'AGENTS.md'), 'original\n');
        // Stub overwrites AGENTS.md, same as real carto init, then makes it
        // read-only so the post-init restore copy fails.
        const binary = writeStubCartoBinary(
          join(root, 'bin'),
          [
            'echo "carto wrote this" > AGENTS.md',
            'chmod 444 AGENTS.md',
            'mkdir -p .carto',
            'echo \'{"output":"AGENTS.md"}\' > .carto/config.json',
            'touch .carto/carto.db',
            'exit 0',
          ].join('\n')
        );
        let result: { ok: boolean; detail: string } | undefined;
        expect(() => {
          result = cartoInit(root, binary);
        }).not.toThrow();
        expect(result?.ok).toBe(false);
        expect(result?.detail).toContain('restore');
        expect(existsSync(join(root, '.carto-agents-backup'))).toBe(false);
      } finally {
        try {
          chmodSync(join(root, 'AGENTS.md'), 0o644);
        } catch {
          // AGENTS.md may not have been created if an earlier step threw
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});

describe('cartoSyncAsync', () => {
  it('resolves ok when the sync succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(join(root, 'bin'), 'exit 0');
      const result = await cartoSyncAsync(root, binary);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves with the failure detail rather than rejecting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const binary = writeStubCartoBinary(
        join(root, 'bin'),
        'echo "index is locked" 1>&2\nexit 1'
      );
      const result = await cartoSyncAsync(root, binary);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('index is locked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The daemon's watcher awaits this on the event loop; a rejection there
  // would be an unhandled one.
  it('resolves rather than rejecting when the binary cannot be spawned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    try {
      const result = await cartoSyncAsync(root, {
        path: join(root, 'no-such-carto'),
        version: '2.9.9',
      });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A child with unread piped stdout blocks forever once it fills the OS
  // pipe buffer (reproduced with ~800 KB under Node; Bun auto-drains, which
  // is why this checks the spawn call's stdio shape rather than a hang).
  it('discards child stdout instead of piping it unread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-'));
    const spy = spyOn(childProcess, 'spawn');
    try {
      const binary = writeStubCartoBinary(join(root, 'bin'), 'exit 0');
      await cartoSyncAsync(root, binary);
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]?.[2]).toMatchObject({
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
