/**
 * Grows a textarea to its content (where CSS field-sizing cannot), for
 * InlineTextField's editor and TextArea's auto-grow. The height is reset
 * to auto first, so a `rows` floor still holds and the box can shrink.
 * scrollHeight is content + padding, but the box is border-box, so the
 * borders are added back: without them the editor came out 2px shorter
 * than the text it replaces and everything below moved up on open.
 */
export function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const borders = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + borders}px`;
}
