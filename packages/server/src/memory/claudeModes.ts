import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute } from 'node:path';

import type { RunKind } from '../orchestrator/types.js';

type MemoryMode = 'export' | 'native' | 'prompt';

export type PreflightResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export interface ModeInput {
  isClaude: boolean;
  runKind: RunKind | 'overseer';
  hasOperator: boolean;
  // False when the operator's personal store will not open, a reused handle included.
  personalAvailable: boolean;
  operatorIsOwner: boolean;
  ownerImport: 'complete' | 'failed' | 'unconfirmed' | 'running' | null;
  claudeAutoMemory: 'export' | 'off';
  preflight: PreflightResult;
  // Writes the export; called only once every other step says export.
  exportWritten: () => boolean;
}

// The oldest Claude Code version the live export-mode probe passed on; boot
// records it, and null would keep export mode off.
export const PROBED_CLAUDE_CODE_VERSION: string | null = '2.1.207';

// The line an export-mode prompt carries in place of the memory index.
export const EXPORT_PROMPT_LINE =
  'Your memory index is MEMORY.md in your auto-memory directory, managed by Dispatch. ' +
  'Save new memories there as usual. `memory_search` and `memory_read` reach older entries, ' +
  'and `memory_save` with `scope: "team"` proposes a lesson for everyone.';

// Picks how a session carries memory, first match wins. The store check comes
// before the owner's import check because that import state lives in the store.
export function chooseMemoryMode(i: ModeInput): {
  mode: MemoryMode;
  index: boolean;
  reason: string;
} {
  if (!i.isClaude)
    return { mode: 'prompt', index: true, reason: 'not a Claude executor' };
  if (i.runKind !== 'execute' && i.runKind !== 'overseer')
    return {
      mode: 'prompt',
      index: false,
      reason: `${i.runKind} runs carry no memory`,
    };
  if (!i.hasOperator)
    return { mode: 'prompt', index: true, reason: 'the run acts for no one' };
  if (!i.personalAvailable)
    return {
      mode: 'prompt',
      index: true,
      reason: "the operator's personal memory is unavailable",
    };
  if (i.operatorIsOwner && i.ownerImport !== 'complete')
    return {
      mode: 'native',
      index: true,
      reason: `the owner's Claude notes are not imported (${i.ownerImport ?? 'not started'})`,
    };
  if (i.claudeAutoMemory === 'off')
    return {
      mode: 'prompt',
      index: true,
      reason: 'memory.claudeAutoMemory is off',
    };
  if (!i.preflight.ok)
    return {
      mode: 'prompt',
      index: true,
      reason: `export preflight failed: ${i.preflight.reason}`,
    };
  if (!i.exportWritten())
    return {
      mode: 'prompt',
      index: true,
      reason: 'the export could not be written',
    };
  return { mode: 'export', index: true, reason: 'export' };
}

// The flag-layer settings and extra directories a mode needs. `native` leaves
// Claude's own auto memory alone; the other two pin the env switch as well.
export function claudeMemorySettings(
  mode: MemoryMode,
  dir?: string
): {
  settings: Record<string, unknown> | null;
  additionalDirectories: string[];
} {
  if (mode === 'native') return { settings: null, additionalDirectories: [] };
  if (mode === 'prompt')
    return {
      settings: {
        autoMemoryEnabled: false,
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
      additionalDirectories: [],
    };
  if (dir === undefined || !isAbsolute(dir))
    throw new Error('export mode needs an absolute directory');
  return {
    settings: {
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
      autoMemoryEnabled: true,
      autoMemoryDirectory: dir,
      autoDreamEnabled: false,
      // `//path` is an absolute path in a permission rule.
      permissions: { allow: [`Read(/${dir}/**)`, `Edit(/${dir}/**)`] },
    },
    additionalDirectories: [dir],
  };
}

function envOf(settings: Record<string, unknown>): Record<string, string> {
  return (settings.env as Record<string, string> | undefined) ?? {};
}

// Lays memory settings over the floor's, merging the two env blocks so the
// floor's pins survive beside the memory switch.
export function mergeFlagSettings(
  floor: Record<string, unknown>,
  memory: Record<string, unknown> | null
): Record<string, unknown> {
  if (memory === null) return floor;
  return { ...floor, ...memory, env: { ...envOf(floor), ...envOf(memory) } };
}

function versionPart(parts: string[], i: number): number {
  const n = Number.parseInt(i < parts.length ? parts[i] : '0', 10);
  return Number.isNaN(n) ? 0 : n;
}

// Compares dotted versions part by part as integers; a missing part is 0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = versionPart(pa, i) - versionPart(pb, i);
    if (d !== 0) return d;
  }
  return 0;
}

// Names the first managed setting that would beat the flag layer, or null.
function managedOverride(managed: Record<string, unknown>): string | null {
  if (managed.autoMemoryDirectory !== undefined)
    return 'managed settings set autoMemoryDirectory';
  if (managed.autoMemoryEnabled === false)
    return 'managed settings turn auto memory off';
  if (envOf(managed).CLAUDE_CODE_DISABLE_AUTO_MEMORY !== undefined)
    return 'managed settings set CLAUDE_CODE_DISABLE_AUTO_MEMORY';
  return null;
}

// The managed tier's settings, merged in precedence order, as the CLI would
// resolve them in `cwd`; null when no managed source sets anything.
export async function resolveManagedSettings(
  cwd: string,
  resolve: typeof resolveSettings = resolveSettings
): Promise<Record<string, unknown> | null> {
  const resolved = await resolve({
    cwd,
    settingSources: ['user', 'project', 'local'],
  });
  let managed: Record<string, unknown> | null = null;
  for (const { source, settings } of resolved.sources) {
    if (source !== 'managed') continue;
    const layer = settings as Record<string, unknown>;
    managed = managed === null ? layer : mergeFlagSettings(managed, layer);
  }
  return managed;
}

// Checks export mode can work: a probed CLI at least as new as the probe, no
// env switch in the daemon, and no managed setting overriding ours. Any throw fails.
export async function runPreflight(input: {
  env: Record<string, string | undefined>;
  probePassed: string | null;
  cliVersion: () => Promise<string | null>;
  resolveManaged: () => Promise<Record<string, unknown> | null>;
}): Promise<PreflightResult> {
  try {
    if (input.probePassed === null)
      return { ok: false, reason: 'no live probe has passed' };
    const version = await input.cliVersion();
    if (version === null)
      return { ok: false, reason: 'the Claude Code version is unknown' };
    if (compareVersions(version, input.probePassed) < 0)
      return {
        ok: false,
        reason: `Claude Code ${version} is older than the probed ${input.probePassed}`,
      };
    if (input.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== undefined)
      return {
        ok: false,
        reason: "CLAUDE_CODE_DISABLE_AUTO_MEMORY is set in the daemon's env",
      };
    const managed = await input.resolveManaged();
    const override = managed === null ? null : managedOverride(managed);
    if (override !== null) return { ok: false, reason: override };
    return { ok: true, version };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
