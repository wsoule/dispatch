import type { AgentStatus } from '@dispatch/protocol';
import { openMessagesDb, SqliteMessageStore } from '@dispatch/protocol';
import { expect } from 'bun:test';
import { join } from 'node:path';

import { tokenHash } from '../../src/a2a/auth.js';
import { runsDir } from '../../src/orchestrator/paths.js';

// Writes an agent row straight into a running daemon's messages.db (a second
// WAL connection), the way a pre-P1 registration left `a2a.*` names.
export function seedAgent(
  rootDir: string,
  address: string,
  token: string,
  status: AgentStatus = 'approved'
): void {
  const db = openMessagesDb(join(runsDir(rootDir), 'messages.db'));
  new SqliteMessageStore(db).putAgent({
    address,
    displayName: address,
    client: 'a2a',
    tokenHash: tokenHash(token),
    status,
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

// A throwaway self-signed certificate for localhost, valid one day.
export async function selfSigned(
  dir: string
): Promise<{ cert: string; key: string }> {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  expect(await proc.exited).toBe(0);
  return { cert, key };
}

let seedBase = '';

// Each daemon test calls this after boot(), so approvedClient reaches its /api.
export function useSeedBase(base: string): void {
  seedBase = base;
}

// A client added and approved through the route, as the owner would.
export async function approvedClient(
  name: string
): Promise<{ caller: { address: string; name: string }; token: string }> {
  const res = await fetch(`${seedBase}/api/a2a/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, approve: true }),
  });
  if (res.status !== 201)
    throw new Error(
      `approvedClient ${name}: ${res.status} ${await res.text()}`
    );
  const body = (await res.json()) as { address: string; token: string };
  return {
    caller: { address: body.address, name: `a2a.${name}` },
    token: body.token,
  };
}

// The SDK's result shape for sendMessage is Task | Message (or its oneof wrapper).
export function taskIdOf(result: unknown): string {
  const r = result as {
    id?: string;
    payload?: { value?: { id?: string } };
    task?: { id?: string };
  };
  return r.payload?.value?.id ?? r.task?.id ?? r.id ?? '';
}
