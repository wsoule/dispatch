import { LoopbackLink } from '@dispatch-foo/protocol';
import type {
  DeliveryEngine,
  FederationHooks,
  LinkMail,
  LinkState,
  Message,
  Placement,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { OpClock } from '@dispatch-foo/protocol/federation';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';

// The hub's side of its links to project daemons: who each linked dispatchd
// is, where a session's run, task, milestone and human mail goes, and the hub's own
// replica id and clock, which every link shares.

/** One project daemon linked to this hub. */
export interface HubLink {
  root: string;
  replica: string;
  port: number;
  /** The token this hub presents to that daemon. */
  peerToken: string;
  /** The token that daemon presents to this hub. */
  token: string;
  link: LoopbackLink;
}

// The hub's replica id, kept beside its database so rows that name it stay
// valid across restarts. `@` keeps it apart from every team replica id.
function hubReplica(dir: string): string {
  const path = join(dir, 'replica');
  if (existsSync(path)) {
    const id = readFileSync(path, 'utf8').trim();
    if (id !== '') return id;
  }
  const id = `@hub-${randomBytes(4).toString('hex')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, id, { mode: 0o600 });
  return id;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Recipients a project's dispatchd homes: its runs, tasks and milestone channels. */
export function projectAddress(recipient: string): boolean {
  return (
    recipient.startsWith('run:') ||
    recipient.startsWith('task:') ||
    recipient.startsWith('channel:milestone/')
  );
}

export class HubLinks {
  readonly replica: string;
  private readonly clock: OpClock;
  private readonly clockPath: string;
  private readonly links = new Map<string, HubLink>();
  private engine: DeliveryEngine | null = null;

  constructor(
    dir: string,
    private readonly store: SqliteMessageStore
  ) {
    this.replica = hubReplica(dir);
    this.clockPath = join(dir, 'hlc');
    const last = existsSync(this.clockPath)
      ? readFileSync(this.clockPath, 'utf8').trim()
      : '';
    this.clock = new OpClock(this.replica, last === '' ? null : last);
  }

  // The team this machine is signed in to, when it is: agents it homes are
  // placed there.
  private team: { replica: string; homes(address: string): boolean } | null =
    null;

  setTeam(
    team: { replica: string; homes(address: string): boolean } | null
  ): void {
    this.team = team;
  }

  /** The engine the links carry mail for; set once it exists. */
  attach(engine: DeliveryEngine): void {
    this.engine = engine;
  }

  /** The federation hooks the hub's engine places mail with. */
  hooks(): FederationHooks {
    return {
      replica: this.replica,
      hlc: () => {
        const hlc = this.clock.tick();
        writeFileSync(this.clockPath, this.clock.last, { mode: 0o600 });
        return hlc;
      },
      placement: (target, message, replyTarget) =>
        this.placement(target.recipient, message, replyTarget),
      remoteRunTask: () => null,
      label: (replica) =>
        [...this.links.values()].find((l) => l.replica === replica)?.root ??
        replica,
      problem: (subject, text) =>
        console.error(`dispatch hub: ${subject}: ${text}`),
    };
  }

  /** Links (or re-links) a project's dispatchd; returns what it needs. */
  register(
    input: { root: string; replica: string; port: number; token: string },
    send: (
      link: HubLink,
      kind: 'mail' | 'state',
      body: LinkMail | LinkState
    ) => Promise<boolean>
  ): HubLink {
    if (this.engine === null) throw new Error('hub links used before attach');
    const root = real(input.root);
    this.links.get(root)?.link.stop();
    const token = randomBytes(32).toString('hex');
    const entry: HubLink = {
      root,
      replica: input.replica,
      port: input.port,
      peerToken: input.token,
      token,
      link: null as unknown as LoopbackLink,
    };
    entry.link = new LoopbackLink({
      engine: this.engine,
      store: this.store,
      me: this.replica,
      peer: input.replica,
      send: (kind, body) => send(entry, kind, body),
    });
    entry.link.start();
    this.links.set(root, entry);
    return entry;
  }

  byToken(token: string): HubLink | null {
    for (const l of this.links.values()) if (l.token === token) return l;
    return null;
  }

  all(): HubLink[] {
    return [...this.links.values()];
  }

  close(): void {
    for (const l of this.links.values()) l.link.stop();
    this.links.clear();
  }

  /** The daemon linked for the project `address` (a session) works in: the
   *  deepest linked root its reported cwd sits under. */
  forSender(address: string): HubLink | null {
    const cwd = this.store.getAgent(address)?.meta?.cwd;
    if (cwd === undefined) return null;
    const at = real(cwd);
    let best: HubLink | null = null;
    for (const l of this.links.values())
      if (
        (at === l.root || at.startsWith(l.root + sep)) &&
        (best === null || l.root.length > best.root.length)
      )
        best = l;
    return best;
  }

  private placement(
    recipient: string,
    message: Message,
    replyTarget: Message | null
  ): Placement {
    if (recipient.startsWith('agent:') && this.team?.homes(recipient) === true)
      return { kind: 'remote', homes: [this.team.replica], alsoLocal: false };
    if (recipient.startsWith('agent:') || recipient.startsWith('channel:repo/'))
      return { kind: 'local' };
    const fromReply =
      replyTarget?.origin === undefined
        ? null
        : (this.all().find((l) => l.replica === replyTarget.origin) ?? null);
    const link = fromReply ?? this.forSender(message.from);
    if (projectAddress(recipient))
      return link === null
        ? {
            kind: 'refuse',
            reason: `${recipient} lives in a project's Dispatch daemon, and none is running for this session's repo; open the project in Dispatch or run dispatch serve`,
          }
        : { kind: 'remote', homes: [link.replica], alsoLocal: false };
    if (recipient.startsWith('human:') && link !== null)
      return { kind: 'remote', homes: [link.replica], alsoLocal: false };
    return { kind: 'local' };
  }
}
