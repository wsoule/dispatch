// The clipboard write, the confirmation window and the select-by-hand
// fallback every copy control in the package shares (MermaidSource's
// "Copy Mermaid", CopyValue, CodeBlock).

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

/**
 * Selects the text of `node`, so a copy the clipboard refused can still be
 * done by hand with Ctrl/Cmd + C (CopyValue's value, CodeBlock's code).
 * Does nothing on a server render, without a node or without a selection.
 */
export function selectContents(node: HTMLElement | null): void {
  if (node === null || typeof window === 'undefined') return;
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}
