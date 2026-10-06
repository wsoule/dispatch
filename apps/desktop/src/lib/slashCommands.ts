import type { OverseerCommand } from '@dispatch/client';

// How many suggestions the composer shows at once.
const SHOWN = 8;

/**
 * The commands a draft is typing, while it is still the first word: `/co`
 * suggests `/compact` and `/context`; a space or a non-slash start ends it.
 */
export function slashSuggestions(
  draft: string,
  commands: readonly OverseerCommand[]
): OverseerCommand[] {
  const match = /^\/([\w:.-]*)$/.exec(draft);
  if (match === null) return [];
  const typed = match[1].toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(typed))
    .slice(0, SHOWN);
}
