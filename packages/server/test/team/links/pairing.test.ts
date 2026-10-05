import { decodePairingCode, encodePairingCode } from '@dispatch/a2a';
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { randomBytes } from 'node:crypto';

import { waitFor } from '../../messaging/harness.js';
import { useLinkDaemons } from './daemons.js';
import type { LinkDaemon } from './daemons.js';

// Real daemons pairing over a scratch bare repo, with no listener.
setDefaultTimeout(90_000);

const { daemon, remote } = useLinkDaemons();

const call = (d: LinkDaemon, path: string, body?: unknown, token?: string) =>
  fetch(`http://127.0.0.1:${d.handle.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function offer(a: LinkDaemon, alias = 'bob') {
  const res = await call(a, '/api/a2a/pairings', {
    alias,
    link: { remote: remote() },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; code: string };
}

const settleAll = async (...ds: LinkDaemon[]) => {
  for (let i = 0; i < 2; i++)
    for (const d of ds) await d.handle.a2a.links!.settle();
};

describe('pairing over a link (T55)', () => {
  it('completes over a link branch with the same proof checks, and the link carries A2A', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    const { id, code } = await offer(ada);
    const accepted = await call(bob, '/api/a2a/pairings/accept', {
      code,
      alias: 'ada',
    });
    expect(accepted.status).toBe(200);
    const { sas } = (await accepted.json()) as { sas: string };
    expect(bob.handle.a2a.peerStatus('ada')).toBe('active');
    await waitFor(() => ada.handle.a2a.peerStatus('bob') === 'active', 30_000);
    expect(ada.handle.a2a.store!.pairing(id)?.state).toBe('completed');
    // Both sides show the same SAS.
    await waitFor(
      () =>
        ada.handle.messaging.engine
          .inbox(ada.owner)
          .some(({ message }) => message.body.includes(`SAS ${sas}`)),
      10_000
    );
    await ada.handle.messaging.engine.send(
      { to: ['a2a:bob'], kind: 'question', body: 'over the new link?' },
      { address: ada.owner, canDecide: true }
    );
    await waitFor(
      () =>
        bob.handle.messaging.engine
          .openBlocking()
          .some((m) => m.body === 'over the new link?'),
      30_000
    );
  });

  it('ignores, with a problem, a proof from someone without the code', async () => {
    const ada = await daemon('link-ada-');
    const carl = await daemon('link-carl-');
    const { id, code } = await offer(ada);
    // Carl saw the code's link but not its secret.
    const real = decodePairingCode(code, new Date());
    const forged = encodePairingCode({
      ...real,
      secret: randomBytes(32).toString('base64url'),
    });
    const res = await call(carl, '/api/a2a/pairings/accept', {
      code: forged,
      alias: 'ada',
    });
    expect(res.status).toBe(200);
    await settleAll(carl, ada);
    expect(ada.handle.a2a.peerStatus('bob')).toBeNull();
    expect(ada.handle.a2a.store!.pairing(id)?.state).toBe('offered');
    const links = (await (await call(ada, '/api/a2a/links')).json()) as {
      offers: { pairedId: string; problems: string[] }[];
    };
    const o = links.offers.find((x) => x.pairedId === id);
    expect(o?.problems.join(' ')).toContain('did not check out');
  });

  it('needs the operator tier when the link remote is a local path', async () => {
    const ada = await daemon('link-ada-');
    const lead = ada.handle.team.teammates.issue('lead', 'decide');
    const res = await call(
      ada,
      '/api/a2a/pairings',
      { alias: 'bob', link: { remote: remote() } },
      lead
    );
    expect(res.status).toBe(403);
    expect(ada.handle.a2a.store!.pairings()).toEqual([]);
  });

  it('shows link health: unpublished, last exchange and problems', async () => {
    const ada = await daemon('link-ada-');
    const bob = await daemon('link-bob-');
    const { code } = await offer(ada);
    expect(
      (await call(bob, '/api/a2a/pairings/accept', { code, alias: 'ada' }))
        .status
    ).toBe(200);
    await settleAll(bob, ada, bob);
    const body = (await (await call(bob, '/api/a2a/links')).json()) as {
      enabled: boolean;
      links: {
        alias: string;
        unpublished: number;
        lastExchangeAt: string | null;
        problems: unknown[];
      }[];
    };
    expect(body.enabled).toBe(true);
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ alias: 'ada', unpublished: 0 });
    expect(body.links[0].lastExchangeAt).not.toBeNull();
    expect(Array.isArray(body.links[0].problems)).toBe(true);
  });
});
