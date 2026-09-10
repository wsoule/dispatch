// Webhook URLs (Slack, Discord) carry their secret in the path — the URL is
// the credential. GET /api/config hands the whole config back to any client
// with a request-tier token, so this masks those paths on the way out. The
// notifications block that stores one is landing separately (epic e-6cfcc7);
// keying on the field name rather than a config type means that landing is
// covered without this file changing.

// Keys whose string values (at any depth below them) are secret-bearing
// URLs. `notifications.webhook` is covered by the plain `webhook` entry.
const SECRET_URL_KEYS = new Set(['webhook', 'webhookUrl']);

// `https://hooks.slack.com/services/T0/B0/xyz` -> `https://hooks.slack.com/…`.
// Anything that is not an http(s) URL comes back untouched, so a
// misconfigured value still shows what the user typed.
function maskUrlPath(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
  return `${url.origin}/…`;
}

function walk(value: unknown, underSecretKey: boolean): unknown {
  if (typeof value === 'string') {
    return underSecretKey ? maskUrlPath(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, underSecretKey));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, underSecretKey || SECRET_URL_KEYS.has(key));
    }
    return out;
  }
  return value;
}

// Deep-copies `config`, masking the path of every http(s) URL string found
// under a key named `webhook` or `webhookUrl` (directly, or nested inside
// such a key's object). The result keeps `config`'s type: the shape is
// unchanged, only those strings are rewritten.
export function redactSecretUrls<T>(config: T): T {
  return walk(config, false) as T;
}
