import { beforeEach, describe, expect, it } from 'bun:test';

import type { LinearDocsPort, LinearDocument } from '../../src/docs/linear.js';
import { LinearDocsAdapter } from '../../src/docs/linear.js';
import type { DocsService } from '../../src/docs/service.js';
import type { FakeDocsHost } from './fakeHost.js';
import { AGENT, DECIDER, makeService, OWNER, TEAMMATE } from './fakeHost.js';

// An in-memory Linear, recording writes and letting a test edit between reads.
// No test here talks to a real Linear workspace.
class FakeLinear implements LinearDocsPort {
  docs = new Map<string, LinearDocument>();
  writes: { id: string; content: string }[] = [];
  creates: {
    title: string;
    content: string;
    projectId?: string;
    issueId?: string;
  }[] = [];
  history = new Map<
    string,
    { contentDataSnapshotAt: string; actorIds: string[] }[]
  >();
  beforeUpdate: (() => void) | null = null;
  afterUpdate: (() => void) | null = null;
  clock = 1;
  stamp(): string {
    this.clock += 1;
    return `2026-09-26T10:${String(this.clock).padStart(2, '0')}:00.000Z`;
  }
  documentsUpdatedSince(): Promise<LinearDocument[]> {
    return Promise.resolve([...this.docs.values()]);
  }
  document(id: string): Promise<LinearDocument> {
    return Promise.resolve({ ...(this.docs.get(id) as LinearDocument) });
  }
  documentUpdate(id: string, content: string): Promise<void> {
    this.beforeUpdate?.();
    const d = this.docs.get(id) as LinearDocument;
    this.docs.set(id, {
      ...d,
      content,
      updatedAt: this.stamp(),
      updatedBy: 'lin-integration',
    });
    this.writes.push({ id, content });
    this.afterUpdate?.();
    return Promise.resolve();
  }
  documentCreate(input: {
    title: string;
    content: string;
    projectId?: string;
    issueId?: string;
  }): Promise<LinearDocument> {
    this.creates.push(input);
    const doc: LinearDocument = {
      id: `lin-${this.docs.size + 1}`,
      title: input.title,
      content: input.content,
      updatedAt: this.stamp(),
      updatedBy: 'lin-integration',
      parent:
        input.projectId !== undefined
          ? { kind: 'project', id: input.projectId }
          : input.issueId !== undefined
            ? { kind: 'issue', id: input.issueId }
            : null,
    };
    this.docs.set(doc.id, doc);
    return Promise.resolve(doc);
  }
  contentHistory(id: string) {
    return Promise.resolve(this.history.get(id) ?? []);
  }
  integrationUserId(): string {
    return 'lin-integration';
  }
}

let service: DocsService;
let host: FakeDocsHost;
let linear: FakeLinear;
let adapter: LinearDocsAdapter;
let problems: string[];
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);
const doc = (
  id: string,
  over: Partial<LinearDocument> = {}
): LinearDocument => ({
  id,
  title: 'Spec',
  content: 'a\nb\nc\n',
  updatedAt: linear.stamp(),
  updatedBy: 'lin-wyat',
  parent: null,
  ...over,
});
const edit = (id: string, content: string, updatedBy = 'lin-wyat') =>
  linear.docs.set(id, {
    ...(linear.docs.get(id) as LinearDocument),
    content,
    updatedAt: linear.stamp(),
    updatedBy,
  });

beforeEach(() => {
  ({ service, host } = makeService());
  host.operators.set('human:wyat', {
    human: 'human:wyat',
    identity: 'id-wyat',
  });
  linear = new FakeLinear();
  problems = [];
  adapter = new LinearDocsAdapter({
    service,
    port: linear,
    taskFor: (parent) =>
      parent?.kind === 'project'
        ? 'e-1'
        : parent?.kind === 'issue'
          ? 't-1'
          : null,
    containerFor: (taskId) =>
      taskId === 't-1'
        ? { issueId: 'iss-1' }
        : taskId === 'e-1'
          ? { projectId: 'p-1' }
          : null,
    personFor: (id) => (id === 'lin-wyat' ? 'human:wyat' : null),
    problem: (_doc, detail) => problems.push(detail),
  });
});

describe('pull', () => {
  it('turns a new Linear document into a linked, unreviewed team draft, and leaves a release parent unlinked', async () => {
    linear.docs.set(
      'lin-a',
      doc('lin-a', {
        title: 'Roadmap',
        content: '# Roadmap\n',
        parent: { kind: 'project', id: 'p-1' },
      })
    );
    linear.docs.set(
      'lin-b',
      doc('lin-b', {
        title: 'Release notes',
        content: 'x\n',
        updatedBy: null,
        parent: { kind: 'release', id: 'r-1' },
      })
    );
    expect((await adapter.pull(null)).created).toBe(2);
    const roadmap = service.read(as(OWNER), 'roadmap');
    expect(roadmap.doc).toMatchObject({
      origin: 'linear:lin-a',
      scope: 'team',
      status: 'draft',
      unreviewed: true,
    });
    // Linear authorship is not a Dispatch human's, mapped or not.
    expect(roadmap.rev.author).toBe('human:wyat');
    expect(roadmap.links.map((l) => [l.target.id, l.rel])).toEqual([
      ['e-1', 'context'],
    ]);
    const notes = service.read(as(OWNER), 'release-notes');
    expect(notes.links).toEqual([]);
    expect(notes.rev.author).toBe('agent:dispatch');
    expect(notes.doc.unreviewed).toBe(true);
    // A second pull of unchanged documents changes nothing.
    expect(await adapter.pull(null)).toMatchObject({
      created: 0,
      merged: 0,
      conflicted: 0,
      proposed: 0,
    });
  });

  it('merges a later Linear edit into a clean head, and proposes against an accepted doc', async () => {
    linear.docs.set('lin-a', doc('lin-a'));
    await adapter.pull(null);
    service.edit(as(OWNER), 'spec', {
      ops: [{ op: 'replace', find: 'a\n', text: 'A\n' }],
    });
    service.seal(as(OWNER), 'spec');
    edit('lin-a', 'a\nb\nC\n');
    expect((await adapter.pull(null)).merged).toBe(1);
    expect(service.read(as(OWNER), 'spec').text).toBe('A\nb\nC\n');
    expect(service.read(as(OWNER), 'spec').doc.unreviewed).toBe(true);
    service.markReviewed(as(DECIDER), 'spec');
    service.setStatus(as(DECIDER), 'spec', 'accepted');
    edit('lin-a', 'A\nb\nC\nd\n');
    expect((await adapter.pull(null)).proposed).toBe(1);
    // The accepted head waits for a decider; the change is a proposal.
    expect(service.read(as(OWNER), 'spec').text).toBe('A\nb\nC\n');
    const [proposal] = service.proposals(as(DECIDER), {});
    expect(proposal).toMatchObject({ origin: 'linear:lin-a', state: 'open' });
  });

  it('marks a real conflict: both sides changed one line, the head carries markers and is conflicted', async () => {
    linear.docs.set('lin-a', doc('lin-a'));
    await adapter.pull(null);
    service.edit(as(OWNER), 'spec', {
      ops: [{ op: 'replace', find: 'b\n', text: 'LOCAL\n' }],
    });
    service.seal(as(OWNER), 'spec');
    edit('lin-a', 'a\nLINEAR\nc\n');
    expect(await adapter.pull(null)).toMatchObject({
      merged: 0,
      conflicted: 1,
    });
    const read = service.read(as(OWNER), 'spec');
    expect(read.doc.conflicted).toBe(true);
    expect(read.text).toContain('<<<<<<< ');
    expect(read.text).toContain('LOCAL\n');
    expect(read.text).toContain('LINEAR\n');
    expect(
      service.list(as(OWNER), { conflicted: true }).docs.map((d) => d.handle)
    ).toEqual(['spec']);
    // A human's save of the resolution clears the flag.
    service.saveBody(as(OWNER), 'spec', {
      baseRev: read.rev.id,
      body: 'a\nboth\nc\n',
    });
    expect(service.read(as(OWNER), 'spec').doc.conflicted).toBe(false);
  });

  it('never touches a personal doc, whatever Linear sends', async () => {
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'private\n',
      scope: 'personal',
    });
    linear.docs.set('lin-a', doc('lin-a', { title: 'Mine', content: 'x\n' }));
    await adapter.pull(null);
    expect(service.read(as(OWNER), '~mine').text).toBe('private\n');
    expect(service.read(as(OWNER), 'mine').doc.scope).toBe('team');
  });
});

describe('push', () => {
  it('pushes only Linear-origin team docs, pulling first when Linear moved since the base', async () => {
    service.create(as(OWNER), { title: 'Local', body: 'x\n' });
    expect(await adapter.push(service.read(as(OWNER), 'local').doc.id)).toBe(
      'not-linear'
    );
    linear.docs.set('lin-a', doc('lin-a', { content: 'v1\n' }));
    await adapter.pull(null);
    const id = service.read(as(OWNER), 'spec').doc.id;
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'local' }] });
    service.seal(as(OWNER), 'spec');
    expect(await adapter.push(id)).toBe('pushed');
    expect(linear.writes.at(-1)?.content).toBe('v1\nlocal\n');
    edit('lin-a', 'v1\nlocal\nlinear\n');
    expect(await adapter.push(id)).toBe('pulled-first');
    expect(service.read(as(OWNER), 'spec').text).toBe('v1\nlocal\nlinear\n');
  });

  it('merges back an edit made right after the write, and raises a problem for one the write overwrote', async () => {
    linear.docs.set('lin-a', doc('lin-a', { content: 'v1\n' }));
    await adapter.pull(null);
    const id = service.read(as(OWNER), 'spec').doc.id;
    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'mine' }] });
    service.seal(as(OWNER), 'spec');
    linear.afterUpdate = () => {
      linear.afterUpdate = null;
      const d = linear.docs.get('lin-a') as LinearDocument;
      edit('lin-a', `${d.content}theirs\n`);
    };
    expect(await adapter.push(id)).toBe('merged-back');
    expect(service.read(as(OWNER), 'spec').text).toBe('v1\nmine\ntheirs\n');

    service.edit(as(OWNER), 'spec', { ops: [{ op: 'append', text: 'again' }] });
    service.seal(as(OWNER), 'spec');
    linear.beforeUpdate = () => {
      linear.beforeUpdate = null;
      linear.history.set('lin-a', [
        {
          contentDataSnapshotAt: '2099-01-01T00:00:00.000Z',
          actorIds: ['lin-wyat'],
        },
      ]);
    };
    expect(await adapter.push(id)).toBe('overwritten');
    expect(problems.at(-1)).toContain('lin-wyat');
    const listed = service
      .list(as(OWNER), { conflicted: true })
      .docs.find((d) => d.id === id);
    expect(listed?.problem).toContain(
      "was overwritten; see Linear's version history"
    );
    // A human's review clears it.
    service.markReviewed(as(OWNER), 'spec');
    expect(
      service.list(as(OWNER), { conflicted: true }).docs.map((d) => d.id)
    ).toEqual([]);
  });
});

describe('recordProblem', () => {
  it("lists the doc as needing a human until a human's save, never an agent's", () => {
    service.create(as(OWNER), { title: 'Spec', body: 'a\n' });
    const id = service.read(as(OWNER), 'spec').doc.id;
    service.recordProblem(id, 'a Linear edit was overwritten');
    const flagged = () =>
      service.list(as(OWNER), { conflicted: true }).docs.map((d) => d.problem);
    expect(flagged()).toEqual(['a Linear edit was overwritten']);
    service.edit(as(AGENT), 'spec', { ops: [{ op: 'append', text: 'agent' }] });
    expect(flagged()).toHaveLength(1);
    const read = service.read(as(OWNER), 'spec');
    service.saveBody(as(OWNER), 'spec', { baseRev: read.rev.id, body: 'b\n' });
    expect(flagged()).toEqual([]);
  });
});

describe('share', () => {
  it('creates a Linear document for a doc linked to a mapped issue, decide tier only, never a personal doc', async () => {
    service.create(as(OWNER), {
      title: 'Design',
      body: 'x\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    await expect(adapter.share(as(TEAMMATE), 'design')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(linear.docs.size).toBe(0);
    const id = await adapter.share(as(DECIDER), 'design');
    expect(linear.creates).toEqual([
      { title: 'Design', content: 'x\n', issueId: 'iss-1' },
    ]);
    expect(linear.docs.get(id)?.content).toBe('x\n');
    expect(service.read(as(OWNER), 'design').doc.origin).toBe(`linear:${id}`);

    service.create(as(OWNER), {
      title: 'Private',
      body: 'p\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'context' }],
    });
    await expect(adapter.share(as(OWNER), '~private')).rejects.toMatchObject({
      code: 'forbidden',
    });
    service.create(as(OWNER), { title: 'Loose', body: 'l\n' });
    await expect(adapter.share(as(DECIDER), 'loose')).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(linear.creates).toHaveLength(1);
  });
});
