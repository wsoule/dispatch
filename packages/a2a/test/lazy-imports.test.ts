import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../src');
// TLS and HTTP servers, and the SDK's client, which only outbound work uses.
const AT_LOAD =
  /^\s*import\s(?!type\b)[^;]*from\s+['"]((node:)?(tls|https|http|http2)|@a2a-js\/sdk\/client)['"]/m;

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
