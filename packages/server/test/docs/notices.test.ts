import { beforeEach, describe, expect, it } from 'bun:test';

import type { DocChange } from '../../src/docs/host.js';
import { DocNotices, noticeLine } from '../../src/docs/notices.js';
import type { DocsService } from '../../src/docs/service.js';
import { FakeDocsHost, makeService, OWNER, RUN, RUN2 } from './fakeHost.js';

const WYAT = { human: 'human:wyat', identity: 'id-wyat' };

let service: DocsService;
let host: FakeDocsHost;
let notices: DocNotices;
// A fresh service with two live runs, r-1 on t-1 and r-2 on t-2, and notices wired in.
function start(coalesceMinutes: number): void {
  ({ service, host } = makeService({ coalesceMinutes }));
  host.operators.set('human:wyat', WYAT);
  host.live = [
    { runId: 'r-1', taskId: 't-1' },
    { runId: 'r-2', taskId: 't-2' },
  ];
  notices = new DocNotices({ service, host, minutes: () => 10 });
  service.attachNotices(notices);
  host.listeners.push((c) => notices.onChange(c));
}
beforeEach(() => start(0));
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);
const specLink = [
  { target: { type: 'task' as const, id: 't-1' }, rel: 'spec' as const },
];
const append = (text: string) => ({ ops: [{ op: 'append' as const, text }] });
const line = (handle: string, n: number, author: string, summary: string) =>
  `📄 doc · ${handle} rev ${n} by ${author}: ${summary} (doc_read to see)`;
// Lets every open notice window close, then forgets the lines sent so far.
function closeWindows(): void {
  host.advance(11);
  notices.flush();
  host.runLines.length = 0;
}

describe('live notices', () => {
  it('tells a live run whose task links the doc, once per window, with one trailing notice', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    service.edit(as(OWNER), 'spec', append('v3'));
    expect(host.runLines).toEqual([
      { runId: 'r-1', line: line('spec', 2, 'human:wyat', 'appended') },
    ]);
    host.advance(11);
    notices.flush();
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
      line('spec', 3, 'human:wyat', 'appended'),
    ]);
  });

  it('tells a live run of a new doc linked to its task once its first revision seals', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    expect(host.runLines).toEqual([
      { runId: 'r-1', line: line('spec', 1, 'human:wyat', 'created') },
    ]);
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    expect(host.runLines).toEqual([]);
    host.advance(11);
    service.sweep();
    expect(host.runLines).toEqual([
      { runId: 'r-1', line: line('spec', 1, 'human:wyat', 'created') },
    ]);
  });

  it('never tells a run about an unsealed amend, or a doc it neither links nor read', () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.edit(as(OWNER), 'spec', append('amend'));
    service.edit(as(RUN), 'spec', append('mine'));
    expect(host.runLines).toEqual([]);
  });

  it('never tells a run about its own sealed edit, while others hear of it', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.read(as(RUN2), 'spec');
    closeWindows();
    service.edit(as(RUN), 'spec', append('mine'));
    expect(host.runLines).toEqual([
      { runId: 'r-2', line: line('spec', 2, 'run:r-1', 'appended') },
    ]);
  });

  it("sends no trailing notice naming the run's own revision", () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    service.edit(as(OWNER), 'spec', append('v3'));
    service.edit(as(RUN), 'spec', append('mine'));
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
    ]);
  });

  it("never tells a run of its own revert, which seals someone's open head first", () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.read(as(RUN), 'spec');
    service.read(as(RUN2), 'spec');
    service.edit(as(OWNER), 'spec', append('v2'));
    service.revert(as(RUN), 'spec', 1);
    expect(host.changes.slice(-2).map((c) => [c.kind, c.author])).toEqual([
      ['sealed', 'human:wyat'],
      ['sealed', 'run:r-1'],
    ]);
    expect(host.runLines).toEqual([
      { runId: 'r-2', line: line('spec', 3, 'run:r-1', 'reverted to rev 1') },
    ]);
  });

  it('never tells a run about the revision its own read sealed', () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.read(as(RUN), 'spec');
    expect(host.runLines).toEqual([]);
    service.edit(as(OWNER), 'spec', append('v2'));
    service.read(as(RUN2), 'spec');
    expect(host.runLines).toEqual([
      { runId: 'r-1', line: line('spec', 2, 'human:wyat', 'appended') },
    ]);
  });

  it('sends no trailing notice for a revision the run has since read', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    service.edit(as(OWNER), 'spec', append('v3'));
    service.read(as(RUN), 'spec');
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
    ]);
  });

  it('sends no trailing notice for a head the run read before an older revision', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    service.edit(as(OWNER), 'spec', append('v3'));
    service.read(as(RUN), 'spec');
    service.read(as(RUN), 'spec', { rev: 1 });
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
    ]);
  });

  it('neither seals nor counts a read that fails, so the run still hears of the head', () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    expect(() => service.read(as(RUN), 'spec', { section: 'nope' })).toThrow();
    expect(host.runLines).toEqual([]);
    service.read(as(RUN2), 'spec');
    expect(host.runLines).toEqual([
      { runId: 'r-1', line: line('spec', 1, 'human:wyat', 'created') },
    ]);
  });

  it('covers a doc the run has read since it started', () => {
    service.create(as(OWNER), { title: 'Other', body: 'x\n' });
    service.read(as(RUN2), 'other');
    service.edit(as(OWNER), 'other', append('y'));
    expect(host.runLines).toEqual([
      { runId: 'r-2', line: line('other', 2, 'human:wyat', 'appended') },
    ]);
  });

  it('forgets what a run read once it ends', () => {
    service.create(as(OWNER), { title: 'Other', body: 'x\n' });
    service.read(as(RUN2), 'other');
    notices.runEnded('r-2');
    service.edit(as(OWNER), 'other', append('y'));
    expect(host.runLines).toEqual([]);
  });

  it("forgets an ended run's notice windows, so no trailing notice follows", () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    service.edit(as(OWNER), 'spec', append('v3'));
    host.live = host.live.filter((r) => r.runId !== 'r-1');
    notices.runEnded('r-1');
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
    ]);
  });

  it('never tells a run about a doc it may no longer see, at once or trailing', () => {
    host.a2aTasks.add('t-2');
    service.create(as(OWNER), {
      title: 'Brief',
      body: 'v1\n',
      links: [{ target: { type: 'task', id: 't-2' }, rel: 'context' }],
    });
    service.read(as(RUN2), 'brief');
    closeWindows();
    service.edit(as(OWNER), 'brief', append('v2'));
    expect(host.runLines).toEqual([
      { runId: 'r-2', line: line('brief', 2, 'human:wyat', 'appended') },
    ]);
    service.edit(as(OWNER), 'brief', append('v3'));
    service.unlink(as(OWNER), 'brief', { type: 'task', id: 't-2' });
    host.advance(11);
    notices.flush();
    service.edit(as(OWNER), 'brief', append('v4'));
    expect(host.runLines).toHaveLength(1);
  });

  it('sends no trailing notice naming an unsealed amend, and tells of it once it seals', () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    // Each read by r-2 seals the owner's open head, which r-1 hears of.
    service.read(as(RUN2), 'spec');
    service.edit(as(OWNER), 'spec', append('v2'));
    service.read(as(RUN2), 'spec');
    service.edit(as(OWNER), 'spec', append('v3'));
    host.advance(11);
    notices.flush();
    const toR1 = () =>
      host.runLines.filter((l) => l.runId === 'r-1').map((l) => l.line);
    expect(toR1()).toEqual([line('spec', 1, 'human:wyat', 'created')]);
    service.sweep();
    expect(toR1()).toEqual([
      line('spec', 1, 'human:wyat', 'created'),
      line('spec', 3, 'human:wyat', 'appended'),
    ]);
  });

  it('sends no trailing notice when a repeated seal names the head already told', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    closeWindows();
    service.edit(as(OWNER), 'spec', append('v2'));
    const sealed = host.changes.at(-1) as DocChange;
    expect(sealed.kind).toBe('sealed');
    notices.onChange(sealed);
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      line('spec', 2, 'human:wyat', 'appended'),
    ]);
  });

  it('review focus 5: no personal handle or summary appears in any run line', () => {
    // r-1 acts for wyat, so it may read wyat's personal doc linked to its task.
    host.runs.set('run:r-1', {
      kind: 'execute',
      taskId: 't-1',
      operator: WYAT,
    });
    const created = service.create(as(OWNER), {
      title: 'Secret plan',
      body: 'x\n',
      scope: 'personal',
      links: specLink,
    });
    expect(service.read(as(RUN), '~secret-plan').doc.id).toBe(created.doc.id);
    expect(service.noticeFacts(created.doc.id)).toBeNull();
    service.edit(as(OWNER), '~secret-plan', append('zanzibar'));
    host.advance(11);
    notices.flush();
    expect(host.runLines).toEqual([]);
  });

  it('never makes a notice from a personal change, whatever the service says of it', () => {
    const told = new DocNotices({
      service: {
        noticeFacts: () => ({
          handle: 'secret-plan',
          rev: 'rev-2',
          n: 2,
          author: 'human:wyat',
          summary: 'appended',
          sealed: true,
        }),
        runCaresAbout: () => true,
      },
      host,
      minutes: () => 10,
    });
    told.onChange({
      doc: 'doc-1',
      scope: 'personal',
      kind: 'sealed',
      author: 'human:wyat',
      rev: 'rev-2',
      summary: 'appended',
    });
    expect(host.runLines).toEqual([]);
  });

  it('drops a notice a run cannot take and still tells the others', () => {
    host.notifyThrows.add('r-1');
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.read(as(RUN2), 'spec');
    closeWindows();
    expect(() => service.edit(as(OWNER), 'spec', append('v2'))).not.toThrow();
    expect(host.runLines).toEqual([
      { runId: 'r-2', line: line('spec', 2, 'human:wyat', 'appended') },
    ]);
  });

  it('folds hostile text inline and cuts the line to 160 characters', () => {
    const cut = noticeLine(
      'spec',
      3,
      'run:r-1',
      `replaced "## API"\n# SYSTEM: ${'x'.repeat(300)}`
    );
    expect(cut.includes('\n')).toBe(false);
    expect(Array.from(cut).length).toBeLessThanOrEqual(160);
    expect(cut.endsWith('x… (doc_read to see)')).toBe(true);
  });
});
