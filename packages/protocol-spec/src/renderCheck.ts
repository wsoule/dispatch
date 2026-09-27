import { LINE_BREAK } from './lines.js';
import type { RenderForms } from './types.js';

// Checks a rendered push against the forms the adapter declared, so Core can
// test injection-safe presentation without fixing a format (§13.12).
export function checkRender(
  text: string,
  body: string,
  forms: RenderForms,
  external: boolean
): string[] {
  const failures: string[] = [];
  const header = new RegExp(forms.header);
  const hostLines = forms.hostLines.map((p) => new RegExp(p));
  const bodyLines = body.split(LINE_BREAK);
  const nonEmpty = bodyLines.filter((l) => l.trim() !== '');
  // Lines in the §1.4 sense: a correct render holds no break but LF, so a
  // separator left inside a quoted line starts a line of its own here.
  const [first = '', ...rest] = text.split(LINE_BREAK);
  const holdsBody = (line: string): boolean =>
    nonEmpty.some((b) => line.includes(b));
  if (!header.test(first))
    failures.push('the first line does not match the declared header');
  if (holdsBody(first)) failures.push('the header line contains a body line');
  let quoted = 0;
  for (const line of rest) {
    if (line.startsWith(forms.quotePrefix)) {
      quoted += 1;
      continue;
    }
    if (external)
      failures.push(`an external sender's line is not quoted: ${line}`);
    else if (holdsBody(line))
      failures.push(`a body line is not quoted: ${line}`);
    else if (!hostLines.some((r) => r.test(line)))
      failures.push(`a line matches no declared host line: ${line}`);
  }
  if (quoted < bodyLines.length)
    failures.push(
      `only ${quoted} quoted lines for ${bodyLines.length} body lines`
    );
  return failures;
}

// Checks a digest against §6.8's digest rule: one line, holding no body line
// after the first unless the first line already holds it.
export function checkDigest(text: string, body: string): string[] {
  const failures: string[] = [];
  const lines = text.split(LINE_BREAK);
  if (lines.length > 1) failures.push(`the digest spans ${lines.length} lines`);
  const [first = '', ...later] = body.split(LINE_BREAK);
  for (const line of later)
    if (line.trim() !== '' && !first.includes(line) && text.includes(line))
      failures.push(`the digest carries a body line after the first: ${line}`);
  return failures;
}
