import type { GateData, Message } from '@dispatch/protocol';
import { gateOf } from '@dispatch/protocol';

export type GateHandler = (question: Message, answer: Message) => Promise<void>;

// Routes an answered gate question to whichever handler registered for its
// `data.type` — the daemon host's onAnswered hook fans out through this one
// map, so each gate type's effect lives in its own registered handler.
export class GateHandlers {
  private readonly handlers = new Map<GateData['type'], GateHandler>();

  register(type: GateData['type'], handler: GateHandler): void {
    this.handlers.set(type, handler);
  }

  // No-op for a gate type nothing registered (e.g. one this daemon build
  // doesn't yet act on) — the engine may call this again after a crash, so a
  // silently-ignored type must stay silently ignored on replay too.
  async handle(question: Message, answer: Message): Promise<void> {
    const gate = gateOf(question);
    if (gate === null) return;
    const handler = this.handlers.get(gate.type);
    if (handler === undefined) return;
    await handler(question, answer);
  }
}
