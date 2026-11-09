import type {
  LinkHttpRequest,
  LinkHttpResponse,
  LinkProject,
} from '@dispatch-foo/protocol';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { HubLinks } from './links.js';

// What the web (app.dispatch.foo) may reach on this machine: the projects
// linked to this hub, and their daemons' APIs, over the team link. One
// switch for the whole machine, on by default, kept beside the hub's other
// files (web.json). Only the person who signed this machine in reaches it:
// the team service checks that before it forwards anything.

const FORWARD_TIMEOUT_MS = 55_000;

/** A linked project's key on the web: stable for its root, opaque. */
export function projectKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

export class HubWeb {
  constructor(
    private readonly dir: string,
    private readonly links: HubLinks
  ) {}

  private get file(): string {
    return join(this.dir, 'web.json');
  }

  /** Whether the web may reach this machine's projects. */
  enabled(): boolean {
    if (!existsSync(this.file)) return true;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as {
        enabled?: unknown;
      };
      return saved.enabled !== false;
    } catch {
      return true;
    }
  }

  setEnabled(enabled: boolean): void {
    writeFileSync(this.file, `${JSON.stringify({ enabled })}\n`, {
      mode: 0o600,
    });
  }

  /** The linked projects, or none while the web is switched off. */
  projects(): LinkProject[] {
    if (!this.enabled()) return [];
    return this.links
      .all()
      .map((l) => ({ key: projectKey(l.root), name: basename(l.root) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Hands one web request to the linked project's daemon, which replays it
   * on its own API. Null when the web is switched off or no linked project
   * has that key.
   */
  async forward(req: LinkHttpRequest): Promise<LinkHttpResponse | null> {
    if (!this.enabled()) return null;
    const link = this.links
      .all()
      .find((l) => projectKey(l.root) === req.project);
    if (link === undefined) return null;
    const res = await fetch(
      `http://127.0.0.1:${String(link.port)}/api/hub-link/http`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${link.peerToken}`,
        },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      }
    );
    if (!res.ok) throw new Error(`the project answered ${String(res.status)}`);
    return (await res.json()) as LinkHttpResponse;
  }
}
