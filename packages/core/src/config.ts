import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { DISPATCH_DIR } from './store.js';
import { STATUSES } from './types.js';

export interface DispatchConfig {
  statuses: string[];
  autoCommit: boolean;
}

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
};

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) return { ...DEFAULTS };
  const raw = (YAML.parse(readFileSync(path, 'utf8')) ?? {}) as Partial<DispatchConfig>;
  return {
    statuses: raw.statuses ?? DEFAULTS.statuses,
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
  };
}
