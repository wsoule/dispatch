import { ensureProjectGitignore } from '@dispatch-foo/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One dismissal: which condition the human waved off, and when. */
export interface DecisionAck {
  /** The item's fingerprint when it was dismissed. The ack hides the item
   *  only while the item still carries this exact fingerprint. */
  fingerprint: string;
  dismissedAt: string;
}

/** The slice of the ack store DecisionFeed reads and writes. */
export interface DecisionAckPort {
  get(id: string): DecisionAck | undefined;
  set(id: string, ack: DecisionAck): void;
  delete(id: string): boolean;
}

/** Hard cap on stored acks, so a long-lived machine's file cannot grow
 *  without bound. Oldest dismissals go first. */
const MAX_ACKS = 500;

/**
 * Dismissals of derived decision-feed items, persisted per machine at
 * `.dispatch/decision-acks.json`.
 *
 * The feed is recomputed from live state on every read, so "dismissed" cannot
 * live on the item: it would be gone on the next recompute. This keeps the
 * human's acknowledgement beside the feed instead, keyed on the item id plus a
 * fingerprint of the condition behind it, so a dismissed item stays hidden
 * until that condition changes and then comes back on its own. Per machine
 * (gitignored) because what one operator has already looked at on this
 * daemon says nothing about a teammate's clone.
 */
export class DecisionAckStore implements DecisionAckPort {
  private readonly file: string;
  private readonly acks: Map<string, DecisionAck>;

  constructor(private readonly rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'decision-acks.json');
    this.acks = this.read();
  }

  // A missing or mangled file degrades to "nothing dismissed": the worst case
  // is a row the human already waved off showing up again, never a crash.
  private read(): Map<string, DecisionAck> {
    if (!existsSync(this.file)) return new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return new Map();
      const out = new Map<string, DecisionAck>();
      for (const [id, value] of Object.entries(parsed)) {
        const ack = value as Partial<DecisionAck> | null;
        if (
          typeof ack?.fingerprint === 'string' &&
          typeof ack.dismissedAt === 'string'
        ) {
          out.set(id, {
            fingerprint: ack.fingerprint,
            dismissedAt: ack.dismissedAt,
          });
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }

  private write(): void {
    // Tops up `.dispatch/.gitignore` (and creates the directory) first, so a
    // project initialised before this file existed never commits it.
    ensureProjectGitignore(this.rootDir, 'files');
    writeFileSync(
      this.file,
      `${JSON.stringify(Object.fromEntries(this.acks), null, 2)}\n`
    );
  }

  get(id: string): DecisionAck | undefined {
    return this.acks.get(id);
  }

  set(id: string, ack: DecisionAck): void {
    // Delete first so a re-dismissal moves to the back of the pruning order.
    this.acks.delete(id);
    this.acks.set(id, ack);
    for (const key of this.acks.keys()) {
      if (this.acks.size <= MAX_ACKS) break;
      this.acks.delete(key);
    }
    this.write();
  }

  delete(id: string): boolean {
    if (!this.acks.delete(id)) return false;
    this.write();
    return true;
  }
}
