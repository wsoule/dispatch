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

/**
 * P2: below the operator tier a link is https only. ssh and git:// resolve
 * the host themselves (ssh through the user's config: ProxyCommand, HostName
 * aliases), so a host check there is only advisory; the operator may use
 * them, and a local path.
 */
export function schemeAllowed(
  remote: string,
  tier: 'operator' | 'decide'
): boolean {
  return tier === 'operator' || /^https:\/\//i.test(remote);
}

// The proxy variables curl reads, in both cases.
const PROXY_ENV = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

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
 * remote (which only the operator tier may pair with), and never follows a
 * redirect; a decide-tier link also runs with no proxy.
 */
export function linkGitRunner(
  base: AsyncGitRunner,
  remote: string,
  // This pass's address pin (P1), read at each command.
  pin: () => string[] = () => [],
  // The pairing's tier: a decide-tier link runs with no proxy (P2).
  tier: () => 'operator' | 'decide' = () => 'operator'
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
    // P2: a redirect would leave the pinned, checked host.
    '-c',
    'http.followRedirects=false',
  ];
  return (cwd, args, env, maxOut) => {
    if (tier() !== 'decide')
      return base(cwd, [...flags, ...pin(), ...args], env, maxOut);
    // P2: a proxy resolves the host itself, so the pin would not hold.
    const noProxy: Record<string, string> = {};
    for (const k of PROXY_ENV) {
      noProxy[k] = '';
      noProxy[k.toUpperCase()] = '';
    }
    return base(
      cwd,
      // A per-URL proxy beats http.proxy, so this URL's is emptied too: an
      // exact URL is the most specific match git's urlmatch knows.
      [
        ...flags,
        '-c',
        'http.proxy=',
        '-c',
        `http.${remote}.proxy=`,
        ...pin(),
        ...args,
      ],
      { ...env, ...noProxy },
      maxOut
    );
  };
}
