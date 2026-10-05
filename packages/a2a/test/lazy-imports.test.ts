import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../src');
// TLS and HTTP servers, a WebSocket library, and the SDK's client, which only
// outbound work uses.
const AT_LOAD =
  /^\s*import\s(?!type\b)[^;]*from\s+['"]((node:)?(tls|https|http|http2)|ws|@a2a-js\/sdk\/client)['"]/m;
// The relay's modules also keep sockets out of load.
const RELAY_AT_LOAD =
  /^\s*import\s(?!type\b)[^;]*from\s+['"]((node:)?net|ws)['"]/m;

// dispatchd loads @dispatch/a2a at boot. Under Bun 1.3.14 a native-pty
// Bun.spawn can deadlock with a child that exits before it returns, and the
// heavier the boot the likelier that is (POST /api/terminals hung in
// terminals-api.test.ts). These modules load on first use instead.
it('loads TLS, HTTP servers and the SDK client only on first use', () => {
  const offenders = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => AT_LOAD.test(readFileSync(join(SRC, path), 'utf8')));
  expect(offenders).toEqual([]);
});

it('loads no sockets with the relay core', () => {
  const relay = join(SRC, 'relay');
  const offenders = readdirSync(relay)
    .filter((path) => path.endsWith('.ts'))
    .filter((path) =>
      RELAY_AT_LOAD.test(readFileSync(join(relay, path), 'utf8'))
    );
  expect(offenders).toEqual([]);
});
