// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

// One command an implementer actually ran, recorded instead of narrated in
// a prose report — a reviewer can compare this against the diff directly.
export interface CommandEvidence {
  command: string;
  exitCode: number;
  durationMs: number;
  summary: string; // e.g. "158 pass, 0 fail"
  at: string;
}

// One mutation test: a guard reverted, tests re-run. `testsFailed: 0` means
// the guard is dead code, or the test meant to protect it is vacuous.
export interface MutationEvidence {
  guard: string; // what was reverted
  file: string;
  testsFailed: number;
  at: string;
}
