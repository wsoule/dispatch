import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateEpicNames } from '../src/migrateEpicNames.js';
import { runsDir } from '../src/orchestrator/paths.js';

// The boot step that moves a pre-rename project's on-disk state onto the
// milestone names: the runs dir's two ledgers and the concurrency config key.

let root: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-epic-names-')));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const configPath = () => join(root, '.dispatch', 'config.yml');

describe('migrateEpicNames', () => {
  it('renames the session and PR ledgers in the runs dir', () => {
    const dir = runsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'epic-sessions.json'), '{"sessions":[]}');
    writeFileSync(join(dir, 'epic-prs.json'), '{}');

    migrateEpicNames(root);

    expect(readFileSync(join(dir, 'milestone-sessions.json'), 'utf8')).toBe(
      '{"sessions":[]}'
    );
    expect(existsSync(join(dir, 'milestone-prs.json'))).toBe(true);
    expect(existsSync(join(dir, 'epic-sessions.json'))).toBe(false);
    expect(existsSync(join(dir, 'epic-prs.json'))).toBe(false);
  });

  it('never overwrites a ledger that already has the new name', () => {
    const dir = runsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'epic-prs.json'), '{"old":true}');
    writeFileSync(join(dir, 'milestone-prs.json'), '{"new":true}');

    migrateEpicNames(root);

    expect(readFileSync(join(dir, 'milestone-prs.json'), 'utf8')).toBe(
      '{"new":true}'
    );
  });

  it('moves orchestrator.epicConcurrency to milestoneConcurrency, keeping the rest', () => {
    writeFileSync(
      configPath(),
      '# team settings\norchestrator:\n  maxConcurrency: 6\n  epicConcurrency: 4\n'
    );

    migrateEpicNames(root);

    const text = readFileSync(configPath(), 'utf8');
    expect(text).toContain('# team settings');
    expect(text).toContain('maxConcurrency: 6');
    expect(text).toContain('milestoneConcurrency: 4');
    expect(text).not.toContain('epicConcurrency');
  });

  it('leaves a config without the old key byte for byte', () => {
    const original = 'orchestrator:\n  milestoneConcurrency: 2 # tuned\n';
    writeFileSync(configPath(), original);

    migrateEpicNames(root);

    expect(readFileSync(configPath(), 'utf8')).toBe(original);
  });
});
