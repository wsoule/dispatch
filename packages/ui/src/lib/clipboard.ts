// The clipboard write and the confirmation window every copy control in
// the package shares (MermaidSource's "Copy Mermaid", CopyValue).

/** How long a copy control says Copied (or why it could not) before it
    returns to idle: 1600ms. */
export const COPIED_MS = 1600;

/**
 * Puts `text` on the clipboard. Resolves false, never throws, when the
 * API is missing (an insecure origin, an old webview, a server render)
 * or the browser refuses (a denied permission), so the caller can say so
 * and leave the text on screen to select by hand.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined') return false;
    // Older webviews (and insecure origins) have no clipboard at all.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
