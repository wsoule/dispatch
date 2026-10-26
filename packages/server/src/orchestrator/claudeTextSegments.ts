// The fields of a Messages API stream event (a `stream_event` message, sent
// with `includePartialMessages`) that live text reads: which API message and
// block the stream is in, and each text delta.
export interface ClaudeStreamEvent {
  type: string;
  index?: number;
  message?: { id?: unknown };
  content_block?: { type?: unknown };
  delta?: { type?: unknown; text?: unknown };
}

/**
 * Names the text blocks of one Agent SDK session's top-level messages, so the
 * text streamed for a block and the finished block can be told to belong
 * together: a ClaudeExecutor run and an Overseer turn both key live text this
 * way. Each text block is a *segment*, `<API message id>:<block index>` when
 * it streamed.
 *
 * The SDK delivers each finished block as its own `assistant` message (same
 * API message id, content = that one block) before the block's
 * `content_block_stop`, so a finished text block claims the oldest segment
 * its API message streamed. Without partial messages (live text off, or a CLI
 * that sends none) the n-th text block of a message is `<id>:<n>` instead.
 *
 * A segment no finished block claims by the time its API message stops (or
 * the next one starts) was abandoned: the stream broke off mid-block, and
 * the CLI sends the text again under a new API message. It is reported to
 * `onAbandon`, so its text can leave the live view rather than stay there
 * half-written for the rest of the session.
 *
 * Feed it top-level messages only: a sub-agent's messages share the session
 * and would interleave with the agent's own.
 */
export class ClaudeTextSegments {
  constructor(
    private readonly onAbandon: (segmentId: string) => void = () => {}
  ) {}

  // The API message being streamed, and the segment of each of its text blocks.
  private messageId: string | undefined;
  private readonly open = new Map<number, string>();
  // Per API message: segments opened by the stream and not claimed by a
  // finished block yet, and how many blocks arrived with none to claim.
  private readonly unclaimed = new Map<string, string[]>();
  private readonly withoutStream = new Map<string, number>();

  /** Follows one stream event; returns the text it adds to a segment, if any. */
  event(event: ClaudeStreamEvent): { segmentId: string; text: string } | null {
    if (event.type === 'message_start' || event.type === 'message_stop') {
      this.abandonUnclaimed();
      this.open.clear();
      const id = event.message?.id;
      this.messageId =
        event.type === 'message_start' && typeof id === 'string'
          ? id
          : undefined;
      return null;
    }
    if (event.index === undefined || this.messageId === undefined) return null;
    if (event.type === 'content_block_start') {
      if (event.content_block?.type !== 'text') return null;
      const segment = `${this.messageId}:${event.index}`;
      this.open.set(event.index, segment);
      const queue = this.unclaimed.get(this.messageId) ?? [];
      queue.push(segment);
      this.unclaimed.set(this.messageId, queue);
      return null;
    }
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string' &&
      event.delta.text !== ''
    ) {
      const segment = this.open.get(event.index);
      if (segment !== undefined) {
        return { segmentId: segment, text: event.delta.text };
      }
    }
    return null;
  }

  // Every block finished before its message stopped claims its segment
  // first, so what the current message left unclaimed will never be.
  private abandonUnclaimed(): void {
    if (this.messageId === undefined) return;
    const left = this.unclaimed.get(this.messageId) ?? [];
    this.unclaimed.delete(this.messageId);
    for (const segment of left) this.onAbandon(segment);
  }

  /**
   * The segment a finished text block of API message `apiId` is: the oldest
   * one that message streamed and no block has claimed. Call it once per
   * text block, in order.
   */
  claim(apiId: string): string {
    const streamed = this.unclaimed.get(apiId)?.shift();
    if (streamed !== undefined) return streamed;
    const n = this.withoutStream.get(apiId) ?? 0;
    this.withoutStream.set(apiId, n + 1);
    return `${apiId}:${n}`;
  }
}

/** The API message id of an `assistant` message's `message`, for `claim`. */
export function apiMessageId(message: { id?: unknown }): string {
  return typeof message.id === 'string' ? message.id : 'message';
}
