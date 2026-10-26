import type {
  OverseerBackend,
  OverseerToolResult,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from '../overseerBackend.js';

/** One tool call a scripted turn makes, in the order the script lists them. */
interface FakeOverseerCall {
  tool: string;
  /**
   * The call's input. A function receives the results of this turn's *earlier*
   * calls, so a scripted turn can read state with one tool and target it with
   * the next (list the ready tasks, dispatch the first) instead of hard-coding
   * an id the test fixture would have to promise forever — the input-side
   * counterpart of FakeOverseerTurn's reply-as-function.
   */
  input?:
    | Record<string, unknown>
    | ((prior: OverseerToolResult[]) => Record<string, unknown>);
  /** Prose the model writes before this call: reported as narration, after
   *  streaming it when the turn streams. */
  narration?: string;
}

/**
 * How a scripted turn's text arrives through `onTextDelta`: `chunk`
 * characters at a time (8 by default), `delayMs` apart (none by default), so a
 * test can watch the text arrive before the reply lands. A turn without it
 * streams nothing, like a backend that cannot.
 */
interface FakeOverseerStream {
  chunk?: number;
  delayMs?: number;
}

/** One scripted assistant turn: the calls it makes, then the text it replies with. */
export interface FakeOverseerTurn {
  calls?: FakeOverseerCall[];
  /**
   * The turn's reply. A function receives the results of this turn's own calls
   * — the same payloads a real model would have seen — so a test can assert
   * the assistant answered from them rather than from a canned string.
   */
  reply?: string | ((results: OverseerToolResult[]) => string);
  /** Streams the turn's narration and reply; absent, none of it streams. */
  stream?: FakeOverseerStream;
}

// A scriptable stand-in for ClaudeOverseer (mirrors planners/fake.ts's
// FakePlanner). Three shapes:
//   - `{ ok: true, calls, reply }` — every turn makes the same calls and gives
//     the same reply; the simple one-shot stand-in.
//   - `{ ok: true, turns }`        — a scripted *sequence* of turns consumed in
//     order, so a test can drive ask -> queue -> confirm -> follow-up.
//   - `{ ok: false, error }`       — every turn rejects with this message.
export type FakeOverseerScript =
  | {
      ok: true;
      calls?: FakeOverseerCall[];
      reply?: string;
      stream?: FakeOverseerStream;
    }
  | { ok: true; turns: FakeOverseerTurn[] }
  | { ok: false; error: string };

// Used when a script omits an explicit `reply`.
const DEFAULT_REPLY = '(fake overseer turn)';

/** One call this backend made, with what the manager handed back. */
export interface FakeOverseerObservation {
  tool: string;
  input: unknown;
  result: OverseerToolResult;
}

/**
 * A deterministic tool-calling overseer backend for tests.
 *
 * It holds no *conversational* state: the position in the script is encoded in
 * the `sessionId` it hands back and OverseerManager threads into the next
 * `sendMessage` — `start()` consumes turn 0 and returns `'1'`, and so on. That
 * mirrors ClaudeOverseer's own statelessness (the real conversation lives in the
 * resumed Agent SDK session) and lets one instance be shared across every
 * conversation in the registry without their turns interfering.
 *
 * `observations` and `advertised` are pure test instrumentation: they record
 * what the "model" was told, which is how a test asserts that a mutating call
 * came back queued rather than done.
 */
export class FakeOverseer implements OverseerBackend {
  /** Every call made, oldest first, across every conversation. */
  readonly observations: FakeOverseerObservation[] = [];
  /** Tool names offered on the most recent turn, in the order advertised. */
  advertised: string[] = [];
  /** Prompts received, oldest first — the text the model would have read. */
  readonly prompts: string[] = [];

  constructor(private readonly script: FakeOverseerScript) {}

  async start(
    prompt: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(0, prompt, toolset, options);
  }

  async sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    const consumed =
      sessionId === undefined ? 0 : Number.parseInt(sessionId, 10);
    return this.runTurn(
      Number.isFinite(consumed) ? consumed : 0,
      message,
      toolset,
      options
    );
  }

  // Plays the turn at `index` (the number of turns already consumed): every
  // scripted call in order, each after its narration, then the reply. Each
  // piece of text is one segment, `fake-<turn>-<n>`.
  private async runTurn(
    index: number,
    prompt: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    if (!this.script.ok) {
      throw new Error(this.script.error);
    }
    this.prompts.push(prompt);
    this.advertised = toolset.tools.map((tool) => tool.name);

    const turn = this.turnAt(index);
    const results: OverseerToolResult[] = [];
    let segments = 0;
    for (const call of turn.calls ?? []) {
      if (call.narration !== undefined) {
        const segmentId = `fake-${index}-${segments++}`;
        await streamText(segmentId, call.narration, turn.stream, options);
        options.onNarration?.(segmentId, call.narration);
      }
      const input =
        typeof call.input === 'function' ? call.input(results) : call.input;
      const result = await toolset.call(call.tool, input ?? {});
      this.observations.push({
        tool: call.tool,
        input: input ?? {},
        result,
      });
      results.push(result);
    }
    const scripted = turn.reply ?? DEFAULT_REPLY;
    const reply = typeof scripted === 'function' ? scripted(results) : scripted;
    const streamId = `fake-${index}-${segments}`;
    const streamed = await streamText(streamId, reply, turn.stream, options);
    return {
      reply,
      ...(streamed ? { streamId } : {}),
      sessionId: String(index + 1),
    };
  }

  private turnAt(index: number): FakeOverseerTurn {
    if (!this.script.ok) throw new Error(this.script.error);
    if (!('turns' in this.script)) {
      const { calls, reply, stream } = this.script;
      return { calls, reply, stream };
    }
    const turn = this.script.turns[index];
    if (turn === undefined) {
      throw new Error(`FakeOverseer: no scripted turn at index ${index}`);
    }
    return turn;
  }
}

// Hands `text` to `onTextDelta` in the script's pieces, and says whether it
// streamed at all. Stops early once the turn is stopped, as a real model's
// stream would.
async function streamText(
  segmentId: string,
  text: string,
  stream: FakeOverseerStream | undefined,
  options: OverseerTurnOptions
): Promise<boolean> {
  const { onTextDelta, abortController } = options;
  if (stream === undefined || onTextDelta === undefined) return false;
  const chunk = Math.max(1, stream.chunk ?? 8);
  const delayMs = stream.delayMs ?? 0;
  for (let at = 0; at < text.length; at += chunk) {
    if (abortController?.signal.aborted === true) break;
    if (at > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    onTextDelta(segmentId, text.slice(at, at + chunk));
  }
  return true;
}
