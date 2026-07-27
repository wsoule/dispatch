/**
 * Counts the items a capture draft will become, for the composer's live hint.
 *
 * The authoritative split lives server-side in packages/server/src/inbox.ts (`splitCapture`), so
 * that every client — this composer, the MCP tool, anything later — produces identical items.
 * This is deliberately only a *preview*: it exists so the hint can say "6 lines" before the round
 * trip, and it must stay in step with the server's rule. If the two ever disagree the hint is
 * wrong by one, which is a cosmetic bug; if this were used to actually create items, it would be
 * a correctness one.
 */
export function splitCaptureLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((line) => line.length > 0);
}
