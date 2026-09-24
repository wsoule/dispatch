import type { GateData, Message } from '@dispatch/protocol';
import { gateOf } from '@dispatch/protocol';

export type GateHandler = (question: Message, answer: Message) => Promise<void>;

// Routes an answered gate question to the handler registered for its
// `data.type`; the daemon host's onAnswered hook fans out through it.
export class GateHandlers {
  private readonly handlers = new Map<GateData['type'], GateHandler>();

  register(type: GateData['type'], handler: GateHandler): void {
    this.handlers.set(type, handler);
  }

  // A gate type with no registered handler is ignored, including when the
  // engine replays it after a crash.
  async handle(question: Message, answer: Message): Promise<void> {
    const gate = gateOf(question);
    if (gate === null) return;
    const handler = this.handlers.get(gate.type);
    if (handler === undefined) return;
    await handler(question, answer);
  }
}
