import { LINE_BREAK } from './lines.js';
import type { RenderForms } from './types.js';

// Checks a rendered push against the forms the adapter declared, so Core can
// test injection-safe presentation without fixing a format (spec:594-602).
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
  const [first = '', ...rest] = text.split('\n');
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
