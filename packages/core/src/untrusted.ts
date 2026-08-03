// Agent-written text lands in another agent's context, where it can forge
// prompt structure; anything rendering it uses one of the three helpers here.
// Task-file escaping in `taskfile.ts` is a different job.

// Line breaks in every form a value could use to escape its line.
const LINE_BREAKS = /[\r\n\v\f\u0085\u2028\u2029]+/g;

// Lines that read as prompt structure rather than content: a markdown heading
// at any level, or a tilde run long enough to be a quoting fence.
const STRUCTURAL_LINE = /^\s*(?:#{1,6}[ \t]|~{4,})/;
const FENCE_RUN = /~{4,}/;

// The fence `untrustedFenced` starts from; widened as needed so the content
// it wraps can never contain its own delimiter.
const FENCE_BAR = '~~~~~~~~';

// An untrusted value sitting inside a line of prompt text (a title, a command,
// a summary), folded so it cannot start a line of its own.
export function untrustedInline(text: string): string {
  return text.replace(LINE_BREAKS, ' ').trim();
}

// An untrusted multi-line value, with every line that would otherwise pose as
// a heading or a fence neutralised.
export function untrustedBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (STRUCTURAL_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
}

// An untrusted block between labelled fences, its own fence-like lines escaped
// and the delimiter widened until the content cannot contain it.
export function untrustedFenced(label: string, text: string): string {
  const body = text
    .split('\n')
    .map((line) => (FENCE_RUN.test(line) ? `\\${line}` : line))
    .join('\n');
  let bar = FENCE_BAR;
  let fence = `${bar} ${label} ${bar}`;
  while (body.includes(fence)) {
    bar += '~';
    fence = `${bar} ${label} ${bar}`;
  }
  return [fence, body, fence].join('\n');
}
