import type { z } from 'zod';

import type { WardenAction } from './wardenTools.js';

/**
 * The seam between the warden's conversation bookkeeping (WardenManager) and
 * whatever actually talks to a model (ClaudeWarden in production, FakeWarden in
 * tests) — the tool-calling counterpart of planner.ts's `Planner`.
 *
 * The split that matters: a backend never touches the tool registry. It is
 * handed a `WardenToolset` for the turn, advertises those tools to the model,
 * and routes every call back through `toolset.call`. WardenManager is what
 * decides that a status call runs immediately and a mutating call only ever
 * queues a WardenAction — so a backend cannot bypass human confirmation even
 * by accident, and a test can drive the whole flow through FakeWarden.
 */

/** One tool a backend advertises to the model for a turn. */
export interface WardenToolDescriptor {
  name: string;
  description: string;
  /**
   * The tool's zod input schema — always an object schema, and the same
   * instance the registry validates the call against. A backend uses it to
   * describe the tool's parameters to the model; the authoritative parse still
   * happens inside the registry, so a backend that advertises a looser shape
   * (or none) can't smuggle unvalidated input through.
   */
  inputSchema: z.ZodType<unknown>;
  /**
   * True for the mutating tools. Calling one NEVER performs its effect: it
   * queues a WardenAction for a human to confirm. Exposed so a backend can say
   * so in the tool's description rather than the model having to infer it from
   * the result it gets back.
   */
  mutating: boolean;
}

/** The outcome of one tool call, as a backend hands it back to the model. */
export interface WardenToolResult {
  /** JSON-serializable payload for the model to read. */
  content: unknown;
  /**
   * True when the call failed (unknown tool, input that failed its schema, a
   * target that doesn't exist). The turn continues — `content` carries a
   * one-line message the model is expected to read and self-correct from,
   * exactly like WardenToolError's own contract.
   */
  isError: boolean;
  /** Set when the call queued a mutating action instead of doing anything. */
  action?: WardenAction;
}

/** Everything a backend needs to run one tool-calling turn. */
export interface WardenToolset {
  tools: readonly WardenToolDescriptor[];
  /**
   * Runs one tool call. Resolves for tool-level failures rather than
   * rejecting (see WardenToolResult.isError) — a mistyped argument should cost
   * the model one turn of self-correction, not fail the whole conversation.
   */
  call(name: string, input: unknown): Promise<WardenToolResult>;
}

/** One settled assistant turn: the text reply, and the handle to resume from. */
export interface WardenTurn {
  reply: string;
  /**
   * The backend's opaque resume handle (the Agent SDK session id for
   * ClaudeWarden), threaded into the next `sendMessage` so follow-ups keep the
   * prior turns — including the tool calls they made — in context.
   */
  sessionId?: string;
}

export interface WardenBackend {
  start(
    prompt: string,
    toolset: WardenToolset,
    model?: string
  ): Promise<WardenTurn>;
  sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: WardenToolset,
    model?: string
  ): Promise<WardenTurn>;
}
