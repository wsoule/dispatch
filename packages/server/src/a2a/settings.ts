import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import { runsDir } from '../orchestrator/paths.js';
import { bindModeFor, isLoopbackAddress } from '../shared.js';

export interface ListenerSettings {
  enabled: boolean;
  host: string;
  port: number | null;
  publicUrl: string | null;
  tls: { certPath: string; keyPath: string } | null;
  trustForwardedFor: boolean;
  standalone: boolean;
}

// One-boot overrides from dispatchd's `--a2a-*` flags; never written back.
export interface ListenerOverrides {
  host?: string;
  port?: number;
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
}

export interface ResolvedListener {
  host: string;
  port: number;
  publicUrl: string;
  tls: { certPath: string; keyPath: string } | null;
  trustForwardedFor: boolean;
}

export const DEFAULT_LISTENER: ListenerSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: null,
  publicUrl: null,
  tls: null,
  trustForwardedFor: false,
  standalone: false,
};

// Machine-local, never committed: a key in config.yml would open a listener
// on every teammate's machine at their next pull.
export function listenerSettingsPath(rootDir: string): string {
  return join(runsDir(rootDir), 'a2a-listener.json');
}

// The file's (or a PUT body's) settings, or the key whose value has the wrong
// type. A missing optional key takes its default, so a file can stay short.
export function parseSettings(
  raw: unknown
): { ok: true; settings: ListenerSettings } | { ok: false; key: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, key: '(top level)' };
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_LISTENER;
  const bool = (
    key: 'enabled' | 'trustForwardedFor' | 'standalone'
  ): boolean | null => {
    const value = r[key];
    if (value === undefined) return d[key];
    return typeof value === 'boolean' ? value : null;
  };
  const enabled = bool('enabled');
  if (enabled === null) return { ok: false, key: 'enabled' };
  const host = r.host === undefined ? d.host : r.host;
  if (typeof host !== 'string') return { ok: false, key: 'host' };
  const port = r.port ?? null;
  if (port !== null && !(typeof port === 'number' && Number.isInteger(port)))
    return { ok: false, key: 'port' };
  const publicUrl = r.publicUrl ?? null;
  if (publicUrl !== null && typeof publicUrl !== 'string')
    return { ok: false, key: 'publicUrl' };
  const tls = (r.tls ?? null) as Record<string, unknown> | null;
  if (
    tls !== null &&
    (typeof tls !== 'object' ||
      typeof tls.certPath !== 'string' ||
      typeof tls.keyPath !== 'string')
  )
    return { ok: false, key: 'tls' };
  const trustForwardedFor = bool('trustForwardedFor');
  if (trustForwardedFor === null)
    return { ok: false, key: 'trustForwardedFor' };
  const standalone = bool('standalone');
  if (standalone === null) return { ok: false, key: 'standalone' };
  return {
    ok: true,
    settings: {
      enabled,
      host,
      port,
      publicUrl,
      tls:
        tls === null
          ? null
          : {
              certPath: tls.certPath as string,
              keyPath: tls.keyPath as string,
            },
      trustForwardedFor,
      standalone,
    },
  };
}

// Never throws: a missing file is the defaults, and an unreadable or
// malformed one is the defaults plus the reason the listener stays closed.
export function readListenerSettings(rootDir: string): {
  settings: ListenerSettings;
  error: string | null;
} {
  const path = listenerSettingsPath(rootDir);
  if (!existsSync(path))
    return { settings: { ...DEFAULT_LISTENER }, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      settings: { ...DEFAULT_LISTENER },
      error: `${path} is not valid JSON (${(err as Error).message}); the A2A listener stays closed`,
    };
  }
  const parsed = parseSettings(raw);
  return parsed.ok
    ? { settings: parsed.settings, error: null }
    : {
        settings: { ...DEFAULT_LISTENER },
        error: `${path} has the wrong shape (${parsed.key}); the A2A listener stays closed`,
      };
}

// Written to a temp file and renamed over, so a crash never leaves half a file.
export function writeListenerSettings(
  rootDir: string,
  settings: ListenerSettings
): void {
  const path = listenerSettingsPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// Any flag turns the listener on for this boot; TLS takes both files or none.
export function applyOverrides(
  settings: ListenerSettings,
  o: ListenerOverrides | undefined
): ListenerSettings {
  if (o === undefined || Object.keys(o).length === 0) return settings;
  return {
    ...settings,
    enabled: true,
    ...(o.host === undefined ? {} : { host: o.host }),
    ...(o.port === undefined ? {} : { port: o.port }),
    ...(o.publicUrl === undefined ? {} : { publicUrl: o.publicUrl }),
    ...(o.tlsCert === undefined || o.tlsKey === undefined
      ? {}
      : { tls: { certPath: o.tlsCert, keyPath: o.tlsKey } }),
  };
}

// Validates dispatchd's raw `--a2a-*` flag values; TLS paths resolve
// against the working directory the daemon was started from.
export function parseListenerFlags(
  flags: Partial<
    Record<'host' | 'port' | 'publicUrl' | 'tlsCert' | 'tlsKey', string>
  >
): { ok: true; overrides: ListenerOverrides } | { ok: false; error: string } {
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    return {
      ok: false,
      error: `--a2a-port must be a port number, not "${flags.port}"`,
    };
  if ((flags.tlsCert === undefined) !== (flags.tlsKey === undefined))
    return {
      ok: false,
      error: '--a2a-tls-cert and --a2a-tls-key go together',
    };
  return {
    ok: true,
    overrides: {
      ...(flags.host === undefined ? {} : { host: flags.host }),
      ...(port === undefined ? {} : { port }),
      ...(flags.publicUrl === undefined ? {} : { publicUrl: flags.publicUrl }),
      ...(flags.tlsCert === undefined
        ? {}
        : { tlsCert: resolve(flags.tlsCert) }),
      ...(flags.tlsKey === undefined ? {} : { tlsKey: resolve(flags.tlsKey) }),
    },
  };
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// A URL hostname that is this machine: localhost or a loopback IP literal,
// never a DNS name that merely starts with 127.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const bare = hostname.replace(/^\[(.*)\]$/, '$1');
  return isIP(bare) !== 0 && isLoopbackAddress(bare);
}

// Checked every time the listener opens; a failing rule keeps it closed and
// names the settings key at fault.
export function resolveListener(
  s: ListenerSettings,
  daemonPorts: readonly number[]
):
  | { ok: true; listener: ResolvedListener }
  | { ok: false; key: string; error: string } {
  const mode = bindModeFor(s.host);
  if (!mode.ok)
    return {
      ok: false,
      key: 'host',
      error: `host ${s.host} is not supported: use 127.0.0.1 (this machine, or behind a tunnel) or 0.0.0.0 (every interface, with TLS)`,
    };
  const loopback = mode.mode === 'loopback';
  if (s.port === null || s.port < 1 || s.port > 65535) {
    return {
      ok: false,
      key: 'port',
      error: 'port is required (1-65535): a card URL needs a stable port',
    };
  }
  if (daemonPorts.includes(s.port)) {
    return {
      ok: false,
      key: 'port',
      error: `port ${s.port} is the daemon's own; /api never shares the A2A port`,
    };
  }
  if (!loopback) {
    if (s.tls === null) {
      return {
        ok: false,
        key: 'tls',
        error: 'a wildcard host needs TLS (tls.certPath and tls.keyPath)',
      };
    }
    if (!readable(s.tls.certPath))
      return {
        ok: false,
        key: 'tls.certPath',
        error: `cannot read ${s.tls.certPath}`,
      };
    if (!readable(s.tls.keyPath))
      return {
        ok: false,
        key: 'tls.keyPath',
        error: `cannot read ${s.tls.keyPath}`,
      };
    if (s.publicUrl === null) {
      return {
        ok: false,
        key: 'publicUrl',
        error: 'a wildcard host needs publicUrl',
      };
    }
  }
  // localhost binds 127.0.0.1 explicitly: Bun can resolve it to ::1 alone,
  // and the default URL has to be where the listener answers.
  const bindHost = s.host === 'localhost' ? '127.0.0.1' : s.host;
  const urlHost = bindHost === '::1' ? '[::1]' : bindHost;
  const scheme = s.tls === null ? 'http' : 'https';
  const publicUrl = s.publicUrl ?? `${scheme}://${urlHost}:${s.port}`;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return {
      ok: false,
      key: 'publicUrl',
      error: `publicUrl ${publicUrl} is not a URL`,
    };
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    return {
      ok: false,
      key: 'publicUrl',
      error: 'publicUrl must be https unless its host is loopback',
    };
  }
  return {
    ok: true,
    listener: {
      host: bindHost,
      port: s.port,
      publicUrl: publicUrl.replace(/\/$/, ''),
      tls: s.tls,
      trustForwardedFor: loopback && s.trustForwardedFor,
    },
  };
}

// The IP per-IP limits key on. The right-most X-Forwarded-For entry is the
// one the tunnel appended, trusted only on a loopback listener.
export function clientIpFor(
  req: Request,
  peer: string | null,
  trustForwardedFor: boolean
): string | null {
  if (!trustForwardedFor) return peer;
  const last = req.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .at(-1);
  return last ?? peer;
}
