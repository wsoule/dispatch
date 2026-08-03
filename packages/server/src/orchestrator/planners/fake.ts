import type {
  Planner,
  PlannerQuestion,
  PlannerTurn,
  PlanProposal,
} from '../planner.js';

// One scripted assistant turn — `proposal` may be `null` for a questions-only
// turn; `reply` defaults to a canned stand-in when omitted.
export interface FakePlannerTurn {
  reply?: string;
  proposal: PlanProposal | null;
  questions?: PlannerQuestion[];
}

// A scriptable stand-in for ClaudePlanner (mirrors executors/fake.ts's
// FakeExecutor): CI never calls the real ClaudePlanner — every planner test in
// this package goes through FakePlanner instead. Three shapes:
//   - `{ ok: true, proposal }`  — every turn (start and every sendMessage)
//     returns this one fixed proposal; the simple one-shot-style stand-in.
//   - `{ ok: true, turns }`     — a scripted *sequence* of turns consumed in
//     order, so a test can drive a refine-then-confirm conversation
//     deterministically.
//   - `{ ok: false, error }`    — every turn rejects with this message.
export type FakePlannerScript =
  | {
      ok: true;
      proposal: PlanProposal | null;
      reply?: string;
      questions?: PlannerQuestion[];
    }
  | { ok: true; turns: FakePlannerTurn[] }
  | { ok: false; error: string };

// Used when a script omits an explicit `reply` — tests that care assert on the
// proposal, not this text.
const DEFAULT_REPLY = '(fake planner turn)';

/**
 * A deterministic conversational planner for tests. It holds NO per-plan
 * mutable state: the conversation's position is encoded in the `sessionId` it
 * hands back and PlanManager threads into the next `sendMessage` call. That
 * mirrors how ClaudePlanner is itself stateless (the real conversation lives
 * in the resumed Agent SDK session, not the planner object), and — crucially —
 * lets one FakePlanner instance be shared safely across every plan in the
 * registry without their turns interfering.
 *
 * The `sessionId` is just the count of turns consumed so far, as a string:
 * `start()` consumes turn 0 and returns `'1'`; `sendMessage('1', …)` consumes
 * turn 1 and returns `'2'`; and so on.
 */
export class FakePlanner implements Planner {
  constructor(private readonly script: FakePlannerScript) {}

  async start(
    _prompt: string,
    _model?: string,
    _mode?: 'plan' | 'draft'
  ): Promise<PlannerTurn> {
    return this.turnAt(0);
  }

  async sendMessage(
    sessionId: string | undefined,
    _message: string,
    _model?: string,
    _mode?: 'plan' | 'draft'
  ): Promise<PlannerTurn> {
    const consumed =
      sessionId === undefined ? 0 : Number.parseInt(sessionId, 10);
    return this.turnAt(Number.isFinite(consumed) ? consumed : 0);
  }

  // Resolves the turn at `index` (the number of turns already consumed) from
  // whichever script shape this planner was built with, and stamps the next
  // sessionId so the following turn advances by one.
  private turnAt(index: number): PlannerTurn {
    if (!this.script.ok) {
      throw new Error(this.script.error);
    }
    const nextSessionId = String(index + 1);
    if ('turns' in this.script) {
      const turn = this.script.turns[index];
      if (turn === undefined) {
        throw new Error(`FakePlanner: no scripted turn at index ${index}`);
      }
      return {
        reply: turn.reply ?? DEFAULT_REPLY,
        proposal: turn.proposal,
        questions: turn.questions ?? [],
        sessionId: nextSessionId,
      };
    }
    return {
      reply: this.script.reply ?? DEFAULT_REPLY,
      proposal: this.script.proposal,
      questions: this.script.questions ?? [],
      sessionId: nextSessionId,
    };
  }
}
