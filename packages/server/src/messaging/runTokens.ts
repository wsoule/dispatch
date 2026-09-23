import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RunTokens {
  mint(runId: string): string;
  /** The run id a token was minted for, or null when it is not ours. */
  verify(token: string): string | null;
}

// Stateless run credentials: `<runId>.<hmac>`, keyed by a per-boot secret,
// so a token dies with the daemon that minted it and needs no table.
export function createRunTokens(secret: Buffer): RunTokens {
  const sign = (runId: string) =>
    createHmac('sha256', secret).update(`run:${runId}`).digest('hex');
  return {
    mint: (runId) => `${runId}.${sign(runId)}`,
    verify(token) {
      const dot = token.lastIndexOf('.');
      if (dot <= 0) return null;
      const runId = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1), 'hex');
      const want = Buffer.from(sign(runId), 'hex');
      return given.length === want.length && timingSafeEqual(given, want)
        ? runId
        : null;
    },
  };
}
