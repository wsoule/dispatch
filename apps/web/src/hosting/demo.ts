import { serializeTaskFile, serializeTeam, slugify } from '@dispatch-foo/core';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createShowcaseWorkspace } from '../planner/linear/showcase.js';
import { toDispatch } from '../planner/toDispatch.js';
import type { WorkspaceHost } from './host.js';

// The public demo (/w/demo/) on a real dispatchd: Better Tracker's showcase
// workspace, dated to today, laid down as a markdown board and re-laid every
// few hours. Visitors are anonymous and share it, so it is read-only: only
// GETs reach the daemon, under one visitor token minted per boot.

const DEMO_ID = 'demo';
const RESEED_MS = 6 * 3_600_000;
const VISITOR = {
  email: 'visitor@demo.dispatch.foo',
  displayName: 'Visitor',
  tier: 'decide',
};

/** Writes the showcase into a fresh project at `root`. */
function seedDemo(root: string, now: Date): void {
  const iso = now.toISOString();
  const model = toDispatch(createShowcaseWorkspace(iso.slice(0, 10)), iso);
  const dispatchDir = join(root, '.dispatch');
  const tasksDir = join(dispatchDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Dispatch');
  git('config', 'user.email', 'planner@dispatch.foo');
  git('commit', '-q', '--allow-empty', '-m', 'Demo planner');
  for (const doc of model.tasks)
    writeFileSync(
      join(tasksDir, `${doc.meta.id}-${slugify(doc.meta.title)}.md`),
      serializeTaskFile(doc)
    );
  writeFileSync(
    join(dispatchDir, 'team.yml'),
    serializeTeam(
      model.people.map((p) => ({
        handle: p.ref.slice('human:'.length),
        email: p.email ?? `${p.ref.slice('human:'.length)}@demo.dispatch.foo`,
        displayName: p.name,
        emails: [],
      }))
    )
  );
  // YAML takes JSON as it is.
  writeFileSync(
    join(dispatchDir, 'config.yml'),
    `${JSON.stringify({
      statuses: model.statusDefinitions,
      autoCommit: false,
      linear: { enabled: false },
    })}\n`
  );
}

export class HostedDemo {
  private visitor: string | null = null;
  private seededAt = 0;
  private reseeding: Promise<void> | null = null;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly now: () => number = Date.now
  ) {}

  /** A visitor's request: reads only, as the shared visitor. */
  async request(pathAndQuery: string, req: Request): Promise<Response> {
    if (req.method !== 'GET')
      return Response.json(
        { error: 'The demo is read-only. Install Dispatch to plan your own.' },
        { status: 403 }
      );
    await this.fresh();
    const send = async () =>
      this.host.request(
        DEMO_ID,
        pathAndQuery,
        { headers: { accept: req.headers.get('accept') ?? '*/*' } },
        await this.token()
      );
    let res = await send();
    if (res.status === 401) {
      this.visitor = null;
      res = await send();
    }
    const headers = new Headers();
    const type = res.headers.get('content-type');
    if (type !== null) headers.set('content-type', type);
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  }

  /** Seeds (if due) and starts the demo daemon, with its visitor ready. */
  async warm(): Promise<void> {
    await this.fresh();
    await this.token();
  }

  // Lays the showcase down again once it is a few hours old (or never was),
  // so it stays dated to today; one reseed at a time.
  private async fresh(): Promise<void> {
    if (this.now() - this.seededAt < RESEED_MS) return;
    this.reseeding ??= this.host
      .replace(DEMO_ID, (root) => seedDemo(root, new Date(this.now())))
      .then(() => {
        this.seededAt = this.now();
        this.visitor = null;
      })
      .finally(() => {
        this.reseeding = null;
      });
    await this.reseeding;
  }

  private async token(): Promise<string> {
    if (this.visitor !== null) return this.visitor;
    const res = await this.host.request(DEMO_ID, '/api/team/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VISITOR),
    });
    if (res.status !== 201)
      throw new Error(`mint the demo visitor (${String(res.status)})`);
    this.visitor = ((await res.json()) as { token: string }).token;
    return this.visitor;
  }
}
