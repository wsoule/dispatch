import {
  afterEach,
  describe,
  expect,
  it,
  setSystemTime,
  spyOn,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DOWNLOAD_TICKET_TTL_MS,
  type DownloadGrant,
  DownloadTickets,
  MAX_DOWNLOAD_TICKETS,
} from '../src/api/downloadTickets.js';
import { attachmentDisposition } from '../src/api/files.js';
import { worktreePath } from '../src/orchestrator/paths.js';
import { EventLoopWatchdog } from '../src/watchdog.js';
import { call, invite, liveRun, useWorld, type World } from './auth/world.js';
import { json } from './json.js';
import { rawFetch } from './testAuth.js';

// Download tickets: a bearer-authenticated POST mints a one-time URL for
// GET /api/files/raw, which then streams the file once with no header at all.

const world = useWorld();

afterEach(() => {
  // The expiry tests move the clock; never leave it moved for the next test.
  setSystemTime();
});

// Mints a ticket for `path` as `token`, failing the test on anything but 201.
async function ticketFor(
  w: World,
  token: string,
  path: string,
  runId?: string
): Promise<string> {
  const r = await call(w, token, 'POST', '/api/files/download-ticket', {
    path,
    ...(runId === undefined ? {} : { runId }),
  });
  if (r.status !== 201) throw new Error(`ticket: ${r.status} ${r.text}`);
  return r.json.ticket as string;
}

// The redeeming GET, sent with no credential of any kind.
function redeem(w: World, ticket: string, extra = ''): Promise<Response> {
  return rawFetch(
    `${w.base}/api/files/raw?ticket=${encodeURIComponent(ticket)}${extra}`
  );
}

function grant(path = 'a.txt'): DownloadGrant {
  return {
    runId: null,
    path,
    resolvedPath: `/repo/${path}`,
    stillAuthorized: () => true,
  };
}

describe('POST /api/files/download-ticket', () => {
  it('issues a ticket that streams the file once as an attachment', async () => {
    const w = world();
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    mkdirSync(join(w.root, 'out'), { recursive: true });
    writeFileSync(join(w.root, 'out', 'report "final".bin'), bytes);

    const issued = await call(w, w.app, 'POST', '/api/files/download-ticket', {
      path: 'out/report "final".bin',
    });
    expect(issued.status).toBe(201);
    expect(issued.json.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(issued.json.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(DOWNLOAD_TICKET_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(DOWNLOAD_TICKET_TTL_MS);

    const res = await redeem(w, issued.json.ticket);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="report _final_.bin"; filename*=UTF-8''report%20%22final%22.bin`
    );
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('refuses the same ticket a second time', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const ticket = await ticketFor(w, w.app, 'a.txt');
    expect((await redeem(w, ticket)).status).toBe(200);
    const again = await redeem(w, ticket);
    expect(again.status).toBe(403);
    expect((await json(again)).code).toBe('download_ticket_dead');
  });

  it('refuses a ticket after about a minute', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const ticket = await ticketFor(w, w.app, 'a.txt');
    setSystemTime(new Date(Date.now() + DOWNLOAD_TICKET_TTL_MS + 1_000));
    const res = await redeem(w, ticket);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('download_ticket_dead');
  });

  it('refuses unknown and malformed tickets', async () => {
    const w = world();
    for (const ticket of ['', 'nope', 'A'.repeat(43), '../../etc/passwd']) {
      const res = await redeem(w, ticket);
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe('download_ticket_dead');
    }
  });

  it('serves only the file it was issued for, and dies on a wrong one', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    writeFileSync(join(w.root, 'b.txt'), 'b\n');
    const ticket = await ticketFor(w, w.app, 'a.txt');
    const wrong = await redeem(w, ticket, '&path=b.txt');
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).code).toBe('download_ticket_wrong_path');
    // Presenting it was its one use.
    expect((await redeem(w, ticket)).status).toBe(403);

    // Naming the same file again is allowed.
    const second = await ticketFor(w, w.app, 'a.txt');
    const same = await redeem(w, second, '&path=a.txt');
    expect(same.status).toBe(200);
    expect(await same.text()).toBe('a\n');
  });

  it('applies the raw route’s path checks before issuing anything', async () => {
    const w = world();
    const outside = mkdtempSync(join(tmpdir(), 'ticket-outside-'));
    try {
      writeFileSync(join(outside, 'secret'), 'secret\n');
      symlinkSync(join(outside, 'secret'), join(w.root, 'link'));
      for (const path of [
        '../../etc/passwd',
        'src/../../../etc/passwd',
        '/etc/passwd',
        'link',
      ]) {
        const r = await call(w, w.app, 'POST', '/api/files/download-ticket', {
          path,
        });
        expect(r.status).toBe(400);
        expect(r.json.error).toContain('inside the project');
      }
      for (const runId of ['..', '../..', 'r-nope']) {
        const r = await call(w, w.app, 'POST', '/api/files/download-ticket', {
          path: 'README.md',
          runId,
        });
        expect(r.status).toBe(400);
      }
      for (const body of [{}, { path: '' }, { path: 3 }]) {
        const r = await call(
          w,
          w.app,
          'POST',
          '/api/files/download-ticket',
          body
        );
        expect(r.status).toBe(400);
      }
      mkdirSync(join(w.root, 'dir'));
      for (const path of ['missing.txt', 'dir']) {
        const r = await call(w, w.app, 'POST', '/api/files/download-ticket', {
          path,
        });
        expect(r.status).toBe(404);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a ticket whose file became a symlink out of the project', async () => {
    const w = world();
    const outside = mkdtempSync(join(tmpdir(), 'ticket-outside-'));
    try {
      writeFileSync(join(outside, 'secret'), 'secret\n');
      writeFileSync(join(w.root, 'a.txt'), 'a\n');
      const ticket = await ticketFor(w, w.app, 'a.txt');
      unlinkSync(join(w.root, 'a.txt'));
      symlinkSync(join(outside, 'secret'), join(w.root, 'a.txt'));
      const res = await redeem(w, ticket);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('secret\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('answers 404 when the file is gone by the time the ticket is used', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const ticket = await ticketFor(w, w.app, 'a.txt');
    unlinkSync(join(w.root, 'a.txt'));
    expect((await redeem(w, ticket)).status).toBe(404);
  });

  it('needs a credential to issue one', async () => {
    const w = world();
    const none = await call(w, null, 'POST', '/api/files/download-ticket', {
      path: 'README.md',
    });
    expect(none.status).toBe(401);
    const bogus = await call(
      w,
      'x'.repeat(64),
      'POST',
      '/api/files/download-ticket',
      {
        path: 'README.md',
      }
    );
    expect(bogus.status).toBe(401);
  });

  it('is good only on GET /api/files/raw, never as a token elsewhere', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const ticket = await ticketFor(w, w.app, 'a.txt');
    // As a query parameter on any other route it is ignored.
    for (const path of [
      `/api/files/read?path=a.txt&ticket=${ticket}`,
      `/api/files/tree?ticket=${ticket}`,
      `/api/tasks?ticket=${ticket}`,
    ]) {
      expect((await rawFetch(`${w.base}${path}`)).status).toBe(401);
    }
    // As a bearer it is no token at all, the raw route included.
    for (const path of ['/api/tasks', '/api/files/raw?path=a.txt']) {
      expect((await call(w, ticket, 'GET', path)).status).toBe(401);
    }
    // None of that spent it.
    expect((await redeem(w, ticket)).status).toBe(200);
  });

  it('works for a request-tier teammate and dies when they are revoked', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const ada = await invite(w, 'ada@x.io', 'request');
    const first = await ticketFor(w, ada.token, 'a.txt');
    expect(await (await redeem(w, first)).text()).toBe('a\n');

    const second = await ticketFor(w, ada.token, 'a.txt');
    const revoked = await call(
      w,
      w.app,
      'DELETE',
      `/api/team/tokens/${ada.handle}`
    );
    expect(revoked.status).toBeLessThan(300);
    const res = await redeem(w, second);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('download_ticket_revoked');
  });

  it('scopes a run’s ticket to its worktree and ends it with the run', async () => {
    const w = world();
    const run = await liveRun(w, w.app);
    const tree = worktreePath(w.root, run.runId);
    expect(existsSync(tree)).toBe(true);
    writeFileSync(join(tree, 'built.txt'), 'from the run\n');

    const ticket = await ticketFor(w, run.runToken, 'built.txt', run.runId);
    expect(await (await redeem(w, ticket)).text()).toBe('from the run\n');
    // The checkout itself has no such file.
    const checkout = await call(
      w,
      run.runToken,
      'POST',
      '/api/files/download-ticket',
      {
        path: 'built.txt',
      }
    );
    expect(checkout.status).toBe(404);

    const late = await ticketFor(w, run.runToken, 'built.txt', run.runId);
    await w.handle.orchestrator.cancel(run.runId);
    const res = await redeem(w, late);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('download_ticket_revoked');
  });

  it('never writes a ticket to the console or the watchdog’s labels', async () => {
    const w = world();
    writeFileSync(join(w.root, 'a.txt'), 'a\n');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => spyOn(console, level)
    );
    const mark = spyOn(EventLoopWatchdog.prototype, 'mark');
    try {
      const ticket = await ticketFor(w, w.app, 'a.txt');
      await (await redeem(w, ticket)).text();
      await (await redeem(w, ticket)).text();
      await (await redeem(w, ticket, '&path=README.md')).text();
      const written = [...spies, mark]
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map(String).join(' '));
      expect(mark.mock.calls.length).toBeGreaterThan(0);
      for (const line of written) expect(line).not.toContain(ticket);
    } finally {
      for (const spy of spies) spy.mockRestore();
      mark.mockRestore();
    }
  });
});

describe('DownloadTickets', () => {
  it('hands a grant back once', () => {
    const store = new DownloadTickets();
    const g = grant();
    const { ticket } = store.issue(g);
    expect(store.take(ticket)).toBe(g);
    expect(store.take(ticket)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('expires at the TTL and sweeps expired tickets on the next call', () => {
    let now = 1_000;
    const store = new DownloadTickets(() => now);
    const early = store.issue(grant('early'));
    expect(early.expiresAt).toBe(
      new Date(1_000 + DOWNLOAD_TICKET_TTL_MS).toISOString()
    );
    now += DOWNLOAD_TICKET_TTL_MS - 1;
    const late = store.issue(grant('late'));
    expect(store.size).toBe(2);
    now += 1;
    // The early one is swept by this issue; the late one still has a minute.
    store.issue(grant('third'));
    expect(store.size).toBe(2);
    expect(store.take(early.ticket)).toBeNull();
    expect(store.take(late.ticket)?.path).toBe('late');
  });

  it('keeps at most MAX_DOWNLOAD_TICKETS, dropping the oldest', () => {
    const store = new DownloadTickets();
    const first = store.issue(grant('first'));
    for (let i = 0; i < MAX_DOWNLOAD_TICKETS; i++) store.issue(grant(`${i}`));
    expect(store.size).toBe(MAX_DOWNLOAD_TICKETS);
    expect(store.take(first.ticket)).toBeNull();
  });

  it('mints distinct 32-byte base64url tickets', () => {
    const store = new DownloadTickets();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { ticket } = store.issue(grant());
      expect(Buffer.from(ticket, 'base64url').length).toBe(32);
      seen.add(ticket);
    }
    expect(seen.size).toBe(50);
  });
});

describe('attachmentDisposition', () => {
  it('names the file, with an ASCII-safe fallback and the exact name encoded', () => {
    expect(attachmentDisposition('/r/plain.txt')).toBe(
      `attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`
    );
    expect(attachmentDisposition('/r/résumé (1).pdf')).toBe(
      `attachment; filename="r_sum_ (1).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf`
    );
    // Nothing in the name can end the header or start another parameter.
    const hostile = attachmentDisposition('/r/a"\r\nx;b\\%.txt');
    expect(hostile).not.toMatch(/[\r\n]/);
    expect(hostile).toStartWith('attachment; filename="a___x_b__.txt"; ');
  });
});
