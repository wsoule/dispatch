import {
  DEFAULT_STATUS_MODEL,
  loadConfig,
  statusModelOf,
} from '@dispatch/core';
import type { StatusModel } from '@dispatch/core';

/**
 * The project's status model (types and lifecycle roles), read fresh so a
 * config edit applies at once. A config that will not load falls back to
 * the built-in model: a status write must never fail on a config typo.
 */
export function statusModelFor(rootDir: string): StatusModel {
  try {
    return statusModelOf(loadConfig(rootDir));
  } catch {
    return DEFAULT_STATUS_MODEL;
  }
}
