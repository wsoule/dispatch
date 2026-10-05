import { ecThumbprint, loadOrCreateLinkKeys } from '@dispatch-foo/a2a';
import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLinkPairedRecords } from '../../../src/a2a/pairing.js';
import { CardSigner, loadSigningKeys } from '../../../src/a2a/signing.js';
import type { ServerHandle, StartServerOptions } from '../../../src/index.js';
import { startServer } from '../../../src/index.js';
import { initGitRepo, runGitSync } from '../../orchestrator/helpers.js';
import { useTestAuth } from '../../testAuth.js';

export interface LinkDaemon {
  handle: ServerHandle;
  root: string;
  owner: string;
}

// Daemons with no A2A listener, on scratch roots, sharing a scratch
// DISPATCH_HOME and one bare remote per test.
export function useLinkDaemons() {
  let home: string;
  let scratch: string;
  let remote: string;
  const daemons: LinkDaemon[] = [];
  const originalHome = process.env.DISPATCH_HOME;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-link-home-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-link-remote-')));
    remote = join(scratch, 'remote.git');
    runGitSync(scratch, ['init', '-q', '--bare', '-b', 'main', remote]);
    process.env.DISPATCH_HOME = home;
  });
  afterEach(async () => {
    for (const d of daemons.splice(0)) {
      await d.handle.stop();
      rmSync(d.root, { recursive: true, force: true });
    }
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function daemon(
    prefix: string,
    extra: Partial<StartServerOptions> = {}
  ): Promise<LinkDaemon> {
    const root = initGitRepo(prefix);
    TaskStore.init(root);
    const handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      a2aLinkIntervalMs: 200,
      ...extra,
    });
    useTestAuth(handle);
    const owner = (
      (await (
        await fetch(`http://127.0.0.1:${handle.port}/api/whoami`)
      ).json()) as { ref: string }
    ).ref;
    const d = { handle, root, owner };
    daemons.push(d);
    return d;
  }

  // Pairs `a` (calling the other `aliasOnA`) and `b` over the bare remote,
  // writing what a completed link pairing writes on each side.
  async function linkPair(
    a: LinkDaemon,
    aliasOnA: string,
    b: LinkDaemon,
    aliasOnB: string
  ): Promise<string> {
    const id = randomBytes(16).toString('base64url');
    const at = new Date().toISOString();
    for (const [x, alias, y, role] of [
      [a, aliasOnA, b, 'offer'],
      [b, aliasOnB, a, 'accept'],
    ] as const) {
      const jwk = new CardSigner(loadSigningKeys(y.root)).publicJwk();
      const thumbprint = ecThumbprint(jwk) ?? '';
      const link = await loadOrCreateLinkKeys(y.root);
      if (link === null) throw new Error('no link keys');
      const peers = x.handle.a2a.peers;
      const store = x.handle.a2a.store;
      const hub = await x.handle.a2a.ensureLinks();
      if (peers === null || store === null || hub === null)
        throw new Error('the bridge is down');
      writeLinkPairedRecords(
        { ...peers.deps, notices: peers.notices, emit: peers.emit },
        {
          alias,
          pairedId: id,
          name: alias,
          peer: { thumbprint, jwk },
          creator: x.owner,
          creatorTier: 'operator',
        }
      );
      store.putPairing({
        id,
        role,
        secretHash: null,
        alias,
        reach: { kind: 'link', transport: {} },
        createdBy: x.owner,
        createdTier: 'operator',
        createdAt: at,
        expiresAt: at,
        state: 'completed',
        peerThumbprint: thumbprint,
        completedAt: at,
      });
      hub.add({
        alias,
        pairedId: id,
        remote,
        branch: `dispatch-a2a-${id}`,
        signPub: link.signPub,
        sealPub: link.sealPub,
        createdAt: at,
      });
    }
    return id;
  }

  return { daemon, linkPair, home: () => home, remote: () => remote };
}
