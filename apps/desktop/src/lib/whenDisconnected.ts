/**
 * Calls `onGone` once, as soon as `node` is no longer in its document, and
 * returns a function that stops watching.
 *
 * Why it exists: React runs a component's effect cleanups when a hidden
 * `<Activity>` hides it, with its DOM still in the document (only styled
 * away), and it runs no cleanup again if that hidden subtree is later
 * deleted. A cleanup that must tell "hidden" from "gone for good" (ending a
 * command, revoking an object URL) checks `isConnected`: false means a real
 * unmount, and true hands the rest to this watch, which fires on the commit
 * that removes the node. Stop the watch when the component shows again.
 *
 * One MutationObserver on the node's document, alive only while the watch
 * is; each batch of DOM changes costs one `isConnected` read.
 */
export function whenDisconnected(node: Node, onGone: () => void): () => void {
  if (!node.isConnected) {
    onGone();
    return () => {};
  }
  let done = false;
  const observer = new MutationObserver(() => {
    if (done || node.isConnected) return;
    done = true;
    observer.disconnect();
    onGone();
  });
  observer.observe(node.ownerDocument ?? document, {
    childList: true,
    subtree: true,
  });
  return () => {
    done = true;
    observer.disconnect();
  };
}
