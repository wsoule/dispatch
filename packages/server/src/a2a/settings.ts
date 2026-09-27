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
import { dirname, join } from 'node:path';

import { runsDir } from '../orchestrator/paths.js';
import { bindModeFor } from '../shared.js';

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

// The file's settings, or the key whose value has the wrong type. A missing
// optional key takes its default, so a hand-written file can stay short.
function parseSettings(
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

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.startsWith('127.')
  );
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
      error: mode.error.replace('--host', 'host'),
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
  const host =
    s.host === '::1' ? '[::1]' : s.host === 'localhost' ? '127.0.0.1' : s.host;
  const publicUrl = s.publicUrl ?? `http://${host}:${s.port}`;
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
      host: s.host,
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
