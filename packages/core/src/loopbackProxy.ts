// The names every local daemon address goes by: the CLI and the MCP server
// call dispatchd at http://127.0.0.1:<port>, and the other two cover a caller
// that says localhost or the IPv6 loopback.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// The proxy exemption list in both spellings: Bun and curl read NO_PROXY,
// Node's env proxy (undici) reads no_proxy first.
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;

/**
 * Adds the loopback addresses to `NO_PROXY` and `no_proxy` in `env` (this
 * process's environment by default), keeping every entry already there.
 *
 * Bun's fetch sends a request for http://127.0.0.1 through `HTTP_PROXY` or
 * `ALL_PROXY` like any other, with no loopback exemption of its own, so on a
 * machine with a proxy set the daemon's bearer token in every CLI and MCP call
 * would reach the proxy. Both runtimes read the exemption list on each
 * request, so calling this first thing in an entry point covers every fetch
 * the process makes after it; a proxy for any other address is untouched.
 * A list of `*` already exempts everything and is left alone.
 */
export function exemptLoopbackFromProxy(
  env: Record<string, string | undefined> = process.env
): void {
  for (const key of NO_PROXY_KEYS) {
    const current = env[key] ?? '';
    const entries = current.split(/[\s,]+/).filter((entry) => entry !== '');
    if (entries.includes('*')) continue;
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    if (missing.length === 0) continue;
    env[key] = [...entries, ...missing].join(',');
  }
}
