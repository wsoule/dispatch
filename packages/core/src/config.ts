import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { DISPATCH_DIR } from './store.js';
import { STATUSES } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
  if (!existsSync(path)) {
    return {
      statuses: [...DEFAULTS.statuses],
      autoCommit: DEFAULTS.autoCommit,
    };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${(err as Error).message}`
    );
  }
  const raw = (parsed ?? {}) as Partial<DispatchConfig>;
  if (
    raw.statuses !== undefined &&
    (!Array.isArray(raw.statuses) ||
      raw.statuses.some((s) => typeof s !== 'string'))
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: statuses must be an array of strings'
    );
  }
  if (raw.autoCommit !== undefined && typeof raw.autoCommit !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: autoCommit must be a boolean'
    );
  }
  return {
    statuses: [...(raw.statuses ?? DEFAULTS.statuses)],
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
  };
}
