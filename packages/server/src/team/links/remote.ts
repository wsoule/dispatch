import type { AsyncGitRunner } from '../../sync/worktree.js';

const MAX_REMOTE = 1024;
const NETWORK = /^(https?|ssh|git):\/\//i;
// scp-like `user@host:path` (a Windows drive letter has no `@`).
const SCP = /^([^/\\@\s]+@)?([^/\\:\s]+):(?!\/\/)/;

// Any C0 control character or DEL: never part of a remote someone typed.
function hasControl(v: string): boolean {
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether `remote` may be a link's remote: no option-looking start, no
 * control characters, no `<helper>::` form (which runs a program), and at
 * most 1 KiB. Both the offer and a code's reader apply it.
 */
export function checkLinkRemote(remote: string): boolean {
  if (
    remote === '' ||
    remote.length > MAX_REMOTE ||
    remote.startsWith('-') ||
    hasControl(remote) ||
    remote.includes('::') ||
    // P1: git and the URL parser read a backslash differently.
    remote.includes('\\')
  )
    return false;
  if (!NETWORK.test(remote)) return true;
  // P1: what the guard checks must be what git connects to, byte for byte.
  try {
    return new URL(remote).href === remote;
  } catch {
    return false;
  }
}

/**
 * The flags that make curl connect an http(s) remote to `address`, the one
 * the guard just checked (P1); [] for ssh, git and local remotes.
 */
export function pinFlags(remote: string, address: string): string[] {
  if (!/^https?:\/\//i.test(remote)) return [];
  const u = new URL(remote);
  const port = u.port !== '' ? u.port : u.protocol === 'https:' ? '443' : '80';
  const at = address.includes(':') ? `[${address}]` : address;
  return ['-c', `http.curloptResolve=${u.hostname}:${port}:${at}`];
}

/** Whether `remote` names something on this machine: a path or file:// URL. */
export function isLocalRemote(remote: string): boolean {
  return !NETWORK.test(remote) && !SCP.test(remote);
}

/**
 * A network remote's host as a URL the address guard can check (scp form as
 * ssh://), or null for a local remote.
 */
export function remoteHostUrl(remote: string): string | null {
  if (NETWORK.test(remote)) {
    try {
      const u = new URL(remote);
      return `${u.protocol}//${u.host}/`;
    } catch {
      return null;
    }
  }
  const scp = SCP.exec(remote);
  return scp === null ? null : `ssh://${scp[2]}/`;
}

/** Text with any URL userinfo (`scheme://user:pass@`) replaced by `***`. */
export function redactRemotes(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/**
 * The git runner for one link: every command runs with protocol.allow=never
 * and explicit allows for https, ssh and git, plus file only for a local
 * remote (which only the operator tier may pair with).
 */
export function linkGitRunner(
  base: AsyncGitRunner,
  remote: string,
  // This pass's address pin (P1), read at each command.
  pin: () => string[] = () => []
): AsyncGitRunner {
  const flags = [
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'protocol.ssh.allow=always',
    '-c',
    'protocol.git.allow=always',
    '-c',
    `protocol.file.allow=${isLocalRemote(remote) ? 'always' : 'never'}`,
  ];
  return (cwd, args, env, maxOut) =>
    base(cwd, [...flags, ...pin(), ...args], env, maxOut);
}
