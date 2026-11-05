import { isApplePlatform } from '@dispatch/ui';

/**
 * The words for the action that shows a saved file in the system's file manager: Finder
 * is the Mac's name for it, so macOS says "Reveal in Finder" and every other platform
 * "Show in folder". `apple` defaults to the library's one platform test
 * (`isApplePlatform`, the same one the ⌘ labels read), so the two never disagree.
 */
export function revealActionLabel(apple: boolean = isApplePlatform()): string {
  return apple ? 'Reveal in Finder' : 'Show in folder';
}
