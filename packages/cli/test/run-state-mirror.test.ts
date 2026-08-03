import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { RUN_STATES } from '../src/apiClient.js';
import { exitCodeForRunState } from '../src/orchestrateFormat.js';

// Nothing in the type system notices when the server grows a run state the
// CLI's hand-kept mirror never hears about, so this reads the server's source.
function readOrchestratorTypes(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  const source = readFileSync(
    join(dirname(pkgJsonPath), 'src', 'orchestrator', 'types.ts'),
    'utf8'
  );
  // Line comments go first: an apostrophe in prose would read as a member.
  return source.replace(/\/\/.*$/gm, '');
}

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function serverRunStates(): string[] {
  const match = /export type RunState =([\s\S]*?);/.exec(
    readOrchestratorTypes()
  );
  if (match === null) throw new Error('no RunState union in the server source');
  return quotedStrings(match[1] ?? '');
}

function serverTerminalRunStates(): string[] {
  const match =
    /export const TERMINAL_RUN_STATES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
      readOrchestratorTypes()
    );
  if (match === null) {
    throw new Error('no TERMINAL_RUN_STATES set in the server source');
  }
  return quotedStrings(match[1] ?? '');
}

// Exit codes keyed by state, so a failure names the state that drifted rather
// than just the code that came back.
function exitCodes(states: string[]): Record<string, number | null> {
  return Object.fromEntries(
    states.map((state) => [
      state,
      exitCodeForRunState(state as (typeof RUN_STATES)[number]),
    ])
  );
}

describe('RunState mirror', () => {
  it("carries exactly the server's own RunState members", () => {
    const mirrored: string[] = [...RUN_STATES];
    expect(mirrored.sort()).toEqual(serverRunStates().sort());
  });

  it('gives every terminal state an exit code, so --watch always exits', () => {
    const terminal = serverTerminalRunStates();
    expect(terminal.length).toBeGreaterThan(0);
    const codes = exitCodes(terminal);
    const hanging = Object.keys(codes).filter((s) => codes[s] === null);
    expect(hanging).toEqual([]);
  });

  it('leaves every non-terminal state without one, so --watch keeps waiting', () => {
    const terminal = new Set(serverTerminalRunStates());
    const live = serverRunStates().filter((s) => !terminal.has(s));
    const codes = exitCodes(live);
    const exiting = Object.keys(codes).filter((s) => codes[s] !== null);
    expect(exiting).toEqual([]);
  });
});
