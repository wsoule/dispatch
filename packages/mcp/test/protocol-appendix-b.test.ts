import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDispatchMcpServer } from '../src/index.js';

// The tool families the protocol's Appendix B documents.
const FAMILIES = /^(msg|inbox|thread|channel|memory)_/;
const appendix = readFileSync(
  new URL(
    '../../protocol-spec/spec/appendix-b-agent-tools.md',
    import.meta.url
  ),
  'utf8'
);

// Each table row whose first cell is a tool name, mapped to the parameter
// names its second cell writes in code, sorted.
function documented(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of appendix.matchAll(/^\| `([a-z_]+)` +\| ([^|]*)\|/gm)) {
    const params = [...(m[2] ?? '').matchAll(/`([A-Za-z]+)`/g)];
    out.set(m[1] ?? '', params.map((p) => p[1] ?? '').sort());
  }
  return out;
}

let root: string | null = null;
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

it('App. B names exactly the registered messaging and memory tools and their parameters', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dmp-appendix-b-')));
  const server = createDispatchMcpServer(root);
  const client = new Client({ name: 'appendix-b', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const { tools } = await client.listTools();
  const registered = new Map(
    tools
      .filter((t) => FAMILIES.test(t.name))
      .map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {}).sort()])
  );
  expect(registered.size).toBeGreaterThan(0);
  expect(documented()).toEqual(registered);
  await client.close();
});
