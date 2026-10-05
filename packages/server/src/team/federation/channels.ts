import { isFederationLocalAddress } from '@dispatch/protocol';
import type { Address, DeliveryEngine, MessageStore } from '@dispatch/protocol';
import type { ChannelBody, FederatedOp } from '@dispatch/protocol/federation';

import type { RosterService } from './roster.js';
import type { Collector, OpHandler } from './service.js';
import type { FedStore } from './store.js';
import { channelBody, dropNote } from './validate.js';

interface MemberRow {
  channel: string;
  member: string;
  joined: number;
  hlc: string;
}

// A member that never federates: a run, or an overseer or A2A identity.
const excluded = (member: string): boolean =>
  member.startsWith('run:') || isFederationLocalAddress(member);

const key = (channel: string, member: string) => `${channel}\n${member}`;

// Channel memberships across daemons, last writer wins per (channel, member)
// on the hlc. fed_members holds the winner of every pair this machine has
// sent or seen; the local store follows it, merging, never replacing.
export class ChannelSync implements Collector, OpHandler {
  readonly order = 2;
  readonly type = 'channel';
  // Engine membership changes not yet published, in order.
  private readonly pending: {
    channel: string;
    member: Address;
    joined: boolean;
  }[] = [];
  private seeded = false;

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      messages: MessageStore;
      engine: DeliveryEngine;
      /** A channel's implicit members (an epic's tasks); never removed. */
      implicit: (channel: string) => Address[];
    }
  ) {
    deps.engine.subscribe((e) => {
      if (e.type !== 'membership' || excluded(e.member)) return;
      this.pending.push({
        channel: e.channel,
        member: e.member,
        joined: e.joined,
      });
    });
  }

  /** Publishes membership changes since the last pass; the first pass after
   *  admission also publishes every local membership the team has never
   *  heard of, so channels that predate the founding carry over. */
  collect(): void {
    const { fed, roster, messages } = this.deps;
    // FW-R31(4): nothing goes to a team this machine is not firmly in.
    if (fed.head() === null || !roster.mailReady()) return;
    if (!this.seeded) {
      this.seeded = true;
      for (const { name } of messages.channels())
        for (const member of messages.members(name))
          if (!excluded(member) && this.row(name, member) === null)
            this.publish(name, member, true);
    }
    for (const change of this.pending.splice(0))
      this.publish(change.channel, change.member, change.joined);
  }

  stage(op: FederatedOp): 'applied' | 'parked' | 'dropped' {
    const { fed } = this.deps;
    // FW-R32(3), M1: a channel name and member of the grammar, or nothing.
    const body = channelBody(op.body);
    if (body === null) {
      dropNote(
        fed,
        'malformed',
        op.replica,
        `${this.deps.roster.label(op.replica)}'s channel op at seq ${op.seq} is not a valid membership; it was dropped`
      );
      return 'dropped';
    }
    const { channel, member } = body;
    if (excluded(member)) {
      fed.problem(
        `channel:${channel}`,
        `${op.replica} put ${member} in ${channel}, which never leaves its machine; it was dropped`
      );
      return 'dropped';
    }
    const held = this.row(channel, member);
    if (held !== null && held.hlc >= op.hlc) return 'applied';
    this.upsert(channel, member, body.joined, op.hlc);
    return 'applied';
  }

  /** After a pass: the local store follows fed_members. A local row the team
   *  never heard of stays; an implicit member is never removed. */
  passComplete(): void {
    const { fed, messages } = this.deps;
    const waiting = new Set(this.pending.map((c) => key(c.channel, c.member)));
    for (const row of fed.db
      .query<MemberRow, []>('SELECT * FROM fed_members')
      .all()) {
      if (waiting.has(key(row.channel, row.member))) continue;
      const here = messages.members(row.channel).includes(row.member);
      if (row.joined === 1 && !here) {
        messages.ensureChannel(row.channel, new Date().toISOString(), false);
        messages.addMember(row.channel, row.member, new Date().toISOString());
      } else if (
        row.joined === 0 &&
        here &&
        !this.deps.implicit(row.channel).includes(row.member)
      )
        messages.removeMember(row.channel, row.member);
    }
  }

  private publish(channel: string, member: Address, joined: boolean): void {
    const body: ChannelBody = { channel, member, joined };
    this.deps.fed.append({
      type: 'channel',
      body: { ...body },
      onStamp: (stamp) => {
        this.upsert(channel, member, joined, stamp.hlc);
      },
    });
  }

  private upsert(
    channel: string,
    member: string,
    joined: boolean,
    hlc: string
  ): void {
    this.deps.fed.db
      .query(
        'INSERT OR REPLACE INTO fed_members (channel, member, joined, hlc) VALUES (?, ?, ?, ?)'
      )
      .run(channel, member, joined ? 1 : 0, hlc);
  }

  private row(channel: string, member: string): MemberRow | null {
    return this.deps.fed.db
      .query<MemberRow, [string, string]>(
        'SELECT * FROM fed_members WHERE channel = ? AND member = ?'
      )
      .get(channel, member);
  }
}
