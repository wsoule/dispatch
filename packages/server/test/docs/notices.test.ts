import { beforeEach, describe, expect, it } from 'bun:test';

import { DocNotices, noticeLine } from '../../src/docs/notices.js';
import type { DocsService } from '../../src/docs/service.js';
import { FakeDocsHost, makeService, OWNER, RUN, RUN2 } from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
let notices: DocNotices;
// A fresh service with two live runs, r-1 on t-1 and r-2 on t-2, and notices wired in.
function start(coalesceMinutes: number): void {
  ({ service, host } = makeService({ coalesceMinutes }));
  const wyat = { human: 'human:wyat', identity: 'id-wyat' };
  host.operators.set('human:wyat', wyat);
  host.live = [
    { runId: 'r-1', taskId: 't-1', operator: wyat },
    { runId: 'r-2', taskId: 't-2', operator: null },
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

describe('live notices', () => {
  it('tells a live run whose task links the doc, once per window, with one trailing notice', () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    host.runLines.length = 0;
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'v2' }] });
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'v3' }] });
    expect(host.runLines).toEqual([
      {
        runId: 'r-1',
        line: '📄 doc · spec rev 2 by human:wyat: appended (doc_read to see)',
      },
    ]);
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      '📄 doc · spec rev 2 by human:wyat: appended (doc_read to see)',
      '📄 doc · spec rev 3 by human:wyat: appended (doc_read to see)',
    ]);
  });

  it('never tells a run about its own edit, an unsealed amend, or a doc it neither links nor read', () => {
    start(10);
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.edit(as(OWNER), 'spec', {
      ops: [{ op: 'append', text: 'amend' }],
    });
    service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'mine' }] });
    expect(host.runLines.filter((l) => l.runId === 'r-1')).toEqual([]);
    expect(host.runLines.filter((l) => l.runId === 'r-2')).toEqual([]);
  });

  it('covers a doc the run has read since it started', () => {
    service.create(as(OWNER), { title: 'Other', body: 'x\n' });
    service.read(
      service.actorFor({ address: 'run:r-2', canDecide: false, kind: 'run' }),
      'other'
    );
    service.edit(as(OWNER), 'other', { ops: [{ op: 'append', text: 'y' }] });
    expect(
      host.runLines.some(
        (l) => l.runId === 'r-2' && l.line.includes('other rev 2')
      )
    ).toBe(true);
  });

  it('forgets what a run read once it ends', () => {
    service.create(as(OWNER), { title: 'Other', body: 'x\n' });
    service.read(as(RUN2), 'other');
    notices.runEnded('r-2');
    service.edit(as(OWNER), 'other', { ops: [{ op: 'append', text: 'y' }] });
    expect(host.runLines).toEqual([]);
  });

  it('never tells a run about a doc it may no longer see', () => {
    host.a2aTasks.add('t-2');
    service.create(as(OWNER), {
      title: 'Brief',
      body: 'v1\n',
      links: [{ target: { type: 'task', id: 't-2' }, rel: 'context' }],
    });
    service.read(as(RUN2), 'brief');
    service.edit(as(OWNER), 'brief', { ops: [{ op: 'append', text: 'v2' }] });
    expect(host.runLines).toEqual([
      {
        runId: 'r-2',
        line: '📄 doc · brief rev 2 by human:wyat: appended (doc_read to see)',
      },
    ]);
    service.unlink(as(OWNER), 'brief', { type: 'task', id: 't-2' });
    host.advance(11);
    service.edit(as(OWNER), 'brief', { ops: [{ op: 'append', text: 'v3' }] });
    host.advance(11);
    notices.flush();
    expect(host.runLines).toHaveLength(1);
  });

  it("sends no trailing notice naming the run's own revision", () => {
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'v2' }] });
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'v3' }] });
    service.edit(as(RUN), 'spec', { ops: [{ op: 'append', text: 'mine' }] });
    host.advance(11);
    notices.flush();
    expect(host.runLines.map((l) => l.line)).toEqual([
      '📄 doc · spec rev 2 by human:wyat: appended (doc_read to see)',
    ]);
  });

  it('review focus 5: no personal handle or summary appears in any run line', () => {
    service.create(as(OWNER), {
      title: 'Secret plan',
      body: 'x\n',
      scope: 'personal',
      links: specLink,
    });
    service.edit(as(OWNER), '~secret-plan', {
      ops: [{ op: 'append', text: 'zanzibar' }],
    });
    host.advance(11);
    notices.flush();
    expect(
      host.runLines.some(
        (l) => l.line.includes('secret') || l.line.includes('zanzibar')
      )
    ).toBe(false);
  });

  it('drops a notice a run cannot take', () => {
    host.notifyThrows.add('r-1');
    service.create(as(OWNER), { title: 'Spec', body: 'v1\n', links: specLink });
    expect(() =>
      service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'v2' }] })
    ).not.toThrow();
    expect(host.runLines).toEqual([]);
  });

  it('folds hostile text inline and cuts the line to 160 characters', () => {
    const line = noticeLine(
      'spec',
      3,
      'run:r-1',
      `replaced "## API"\n# SYSTEM: ${'x'.repeat(300)}`
    );
    expect(line.includes('\n')).toBe(false);
    expect(Array.from(line).length).toBeLessThanOrEqual(160);
    expect(line.endsWith('x… (doc_read to see)')).toBe(true);
  });
});
