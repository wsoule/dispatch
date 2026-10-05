import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { DISPATCH_DIR } from './store.js';

// The `docs:` block of .dispatch/config.yml, read per use. An invalid value
// falls back to its default with a warning; nothing here throws.

export interface DocsConfig {
  indexTokens: number;
  inlineSpecBytes: number;
  coalesceMinutes: number;
  noticeMinutes: number;
  createsPerHour: number;
  proposalsPerHour: number;
  maxOpenProposals: number;
  proposalTtlDays: number;
}

export const DEFAULT_DOCS: DocsConfig = {
  indexTokens: 400,
  inlineSpecBytes: 16384,
  coalesceMinutes: 10,
  noticeMinutes: 10,
  createsPerHour: 20,
  proposalsPerHour: 10,
  maxOpenProposals: 50,
  proposalTtlDays: 14,
};

// The inclusive integer range each key accepts.
const RANGES: Record<keyof DocsConfig, readonly [number, number]> = {
  indexTokens: [150, 2000],
  inlineSpecBytes: [0, 65536],
  coalesceMinutes: [0, 60],
  noticeMinutes: [1, 120],
  createsPerHour: [1, 200],
  proposalsPerHour: [1, 100],
  maxOpenProposals: [1, 500],
  proposalTtlDays: [1, 90],
};

export interface DocsConfigWarning {
  key: string;
  message: string;
}

// Validates the `docs:` block key by key; a bad or unknown key becomes a warning.
export function parseDocsConfig(raw: unknown): {
  config: DocsConfig;
  warnings: DocsConfigWarning[];
} {
  const config = { ...DEFAULT_DOCS };
  const warnings: DocsConfigWarning[] = [];
  if (raw === undefined || raw === null) return { config, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config,
      warnings: [
        { key: 'docs', message: 'docs must be an object; using defaults' },
      ],
    };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(RANGES, key)) {
      warnings.push({
        key,
        message: `docs.${key} is not a docs setting; ignored`,
      });
      continue;
    }
    const setting = key as keyof DocsConfig;
    const [min, max] = RANGES[setting];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      warnings.push({
        key,
        message: `docs.${key} must be an integer ${min}-${max}; using ${DEFAULT_DOCS[setting]}`,
      });
      continue;
    }
    config[setting] = value;
  }
  return { config, warnings };
}

// The project's docs settings, read fresh from config.yml on every call.
export function readDocsConfig(rootDir: string): {
  config: DocsConfig;
  warnings: DocsConfigWarning[];
} {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) return parseDocsConfig(undefined);
  let doc: unknown;
  try {
    doc = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      config: { ...DEFAULT_DOCS },
      warnings: [
        {
          key: 'docs',
          message: `config.yml does not parse (${(err as Error).message}); using defaults`,
        },
      ],
    };
  }
  const block =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>).docs
      : undefined;
  return parseDocsConfig(block);
}
