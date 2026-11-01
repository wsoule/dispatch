import { DISPATCH_DIR } from '@dispatch-foo/core';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { runsDir } from './orchestrator/paths.js';

// Files a pre-rename daemon kept in the runs dir, by their new names.
const RENAMED_RUN_FILES = [
  ['epic-sessions.json', 'milestone-sessions.json'],
  ['epic-prs.json', 'milestone-prs.json'],
] as const;

/**
 * Moves a project's on-disk state off the retired `epic` names once, at boot:
 * the runs dir's session and PR ledgers, and `orchestrator.epicConcurrency` in
 * config.yml. Nothing else reads the old names, so this must run before the
 * config is loaded or the orchestrator hydrates. Idempotent.
 */
export function migrateEpicNames(rootDir: string): void {
  const dir = runsDir(rootDir);
  for (const [from, to] of RENAMED_RUN_FILES) {
    const source = join(dir, from);
    const target = join(dir, to);
    if (existsSync(source) && !existsSync(target)) renameSync(source, target);
  }

  const configPath = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(configPath)) return;
  const doc = YAML.parseDocument(readFileSync(configPath, 'utf8'));
  const legacy = doc.getIn(['orchestrator', 'epicConcurrency']);
  if (legacy === undefined) return;
  if (!doc.hasIn(['orchestrator', 'milestoneConcurrency'])) {
    doc.setIn(['orchestrator', 'milestoneConcurrency'], legacy);
  }
  doc.deleteIn(['orchestrator', 'epicConcurrency']);
  writeFileSync(configPath, doc.toString());
}
