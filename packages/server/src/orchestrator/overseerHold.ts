import { isAbsolute, normalize, resolve, sep } from 'node:path';

/**
 * Why the Overseer must ask before a call, beyond the irreversible floor: it would
 * change Dispatch itself through a side door the approval cards do not see.
 * - `dispatch-cli`: the `dispatch` CLI, which acts with this user's credentials;
 * - `daemon-api`: the daemon's HTTP API, or the file holding its token;
 * - `dispatch-files`: a write into a `.dispatch/` directory.
 */
export type OverseerHold = 'dispatch-cli' | 'daemon-api' | 'dispatch-files';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// `dispatch` as a command: at the start or after a separator, past env
// assignments and a runner, as a bare name or a path ending in it.
const DISPATCH_CLI =
  /(?:^|[;&|`\n(]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+)?(?:(?:bunx|npx|bun\s+x|pnpm(?:\s+exec)?|yarn)\s+)?(?:\S*\/)?dispatch(?=\s|$|[;&|)`])/;

const LOCAL_HOST =
  /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\/api\b/;
const HTTP_CLIENT = /\b(?:curl|wget|http|https|xh|nc|fetch)\b/;
const DAEMON_FILE = /\.dispatch\/daemons\//;
const DISPATCH_DIR = /(?:^|[\s'"=/])\.dispatch\//;
const SHELL_WRITE =
  /(?:>>?|\b(?:rm|mv|cp|sed\s+-i|perl\s+-pi|tee|truncate|touch|chmod|ln)\b)/;

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

function pathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as { file_path?: unknown; notebook_path?: unknown };
  const path = record.file_path ?? record.notebook_path;
  return typeof path === 'string' ? path : null;
}

// Whether a path, resolved against the checkout, sits inside a `.dispatch` directory.
function inDispatchDir(path: string, rootDir: string): boolean {
  const full = normalize(isAbsolute(path) ? path : resolve(rootDir, path));
  return full.split(sep).includes('.dispatch');
}

/** The hold one Overseer tool call needs, or null when its normal permission path applies. */
export function overseerHoldFor(
  toolName: string,
  input: unknown,
  rootDir: string
): OverseerHold | null {
  if (EDIT_TOOLS.has(toolName)) {
    const path = pathOf(input);
    return path !== null && inDispatchDir(path, rootDir)
      ? 'dispatch-files'
      : null;
  }
  const command = commandOf(input);
  if (command === null) return null;
  if (DISPATCH_CLI.test(command)) return 'dispatch-cli';
  if (DAEMON_FILE.test(command)) return 'daemon-api';
  if (HTTP_CLIENT.test(command) && LOCAL_HOST.test(command)) {
    return 'daemon-api';
  }
  if (DISPATCH_DIR.test(command) && SHELL_WRITE.test(command)) {
    return 'dispatch-files';
  }
  return null;
}
