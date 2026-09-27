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
