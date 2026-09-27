import { openMessagesDb, SqliteMessageStore } from '@dispatch/protocol';
import { join } from 'node:path';

import { tokenHash } from '../../src/a2a/auth.js';
import { runsDir } from '../../src/orchestrator/paths.js';

// Writes an approved agent row straight into a running daemon's messages.db
// (a second WAL connection), the way a pre-P1 registration left `a2a.*` names.
export function seedAgent(
  rootDir: string,
  address: string,
  token: string
): void {
  const db = openMessagesDb(join(runsDir(rootDir), 'messages.db'));
  new SqliteMessageStore(db).putAgent({
    address,
    displayName: address,
    client: 'a2a',
    tokenHash: tokenHash(token),
    status: 'approved',
    muted: false,
    approvedBy: 'human:test',
    createdAt: new Date().toISOString(),
  });
  db.close();
}

// A port nothing listens on right now, for a listener a test is about to open.
export async function freePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}
