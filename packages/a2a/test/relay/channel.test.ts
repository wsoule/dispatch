import { describe, expect, it } from 'bun:test';

import { TenantChannel } from '../../src/relay/bridgePort.js';
import type { RelayToDaemon } from '../../src/relay/frames.js';
import { TenantLimiter } from '../../src/relay/limits.js';

const BIG = {
  inFlight: 10,
  streams: 10,
  requestsPerMinute: 1000,
  bytesPerMinute: 10_000_000,
};

// A channel whose sent frames are collected, answered by `answer`.
function channel(
  tenant: string,
  deadlineMs = 1000,
  limiter = new TenantLimiter(() => BIG)
) {
  const sent: RelayToDaemon[] = [];
  const ch = new TenantChannel({
    tenant,
    send: (f) => sent.push(f),
    limiter,
    deadlineMs,
  });
  return { ch, sent };
}

describe('TenantChannel', () => {
  it('turns a fetch into a call frame and the result into a Response', async () => {
    const { ch, sent } = channel('a');
    const pending = ch.fetch('relay://tenant/api/a2a/port/whoami', {
      method: 'GET',
      headers: {
        'x-a2a-client-authorization': 'Bearer t',
        authorization: 'Bearer host',
      },
    });
    await Promise.resolve();
    const frame = sent[0];
    expect(frame).toMatchObject({
      t: 'call',
      route: '/whoami',
      method: 'GET',
      headers: { 'x-a2a-client-authorization': 'Bearer t' },
    });
    if (frame.t !== 'call') throw new Error('no call');
    ch.receive({
      t: 'result',
      id: frame.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses a result for a call it does not own', () => {
    const { ch } = channel('a');
    expect(
      ch.receive({
        t: 'result',
        id: 'z'.repeat(22),
        status: 200,
        headers: {},
        body: null,
      })
    ).toBe(false);
  });

  it('streams chunks until end, and an aborted stream sends cancel', async () => {
    const { ch, sent } = channel('a');
    const ac = new AbortController();
    const pending = ch.fetch('relay://tenant/api/a2a/port/tasks/x/watch', {
      signal: ac.signal,
    });
    await Promise.resolve();
    const id = (sent[0] as { id: string }).id;
    ch.receive({
      t: 'result',
      id,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: null,
    });
    const res = await pending;
    const reader = res.body!.getReader();
    ch.receive({ t: 'chunk', id, data: 'data: 1\n\n' });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'data: 1\n\n'
    );
    ch.receive({ t: 'end', id });
    expect((await reader.read()).done).toBe(true);
    const again = ch.fetch('relay://tenant/api/a2a/port/tasks/y/watch', {
      signal: ac.signal,
    });
    await Promise.resolve();
    ac.abort();
    await expect(again).rejects.toThrow();
    expect(sent.at(-1)).toMatchObject({ t: 'cancel' });
  });

  it('a stalled tenant times out on its own deadline while another answers', async () => {
    const a = channel('a', 50);
    const b = channel('b', 50);
    const stalled = a.ch.fetch('relay://tenant/api/a2a/port/whoami', {});
    const quick = b.ch.fetch('relay://tenant/api/a2a/port/whoami', {});
    await Promise.resolve();
    const id = (b.sent[0] as { id: string }).id;
    b.ch.receive({ t: 'result', id, status: 200, headers: {}, body: '{}' });
    expect((await quick).status).toBe(200);
    await expect(stalled).rejects.toThrow();
  });

  it('a tenant over its in-flight cap gets 429 without a frame; closing fails what is pending', async () => {
    const limiter = new TenantLimiter(() => ({ ...BIG, inFlight: 1 }));
    const { ch, sent } = channel('a', 1000, limiter);
    const first = ch.fetch('relay://tenant/api/a2a/port/whoami', {});
    const second = await ch.fetch('relay://tenant/api/a2a/port/whoami', {});
    expect(second.status).toBe(429);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    ch.close();
    await expect(first).rejects.toThrow();
  });
});
