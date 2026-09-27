import { VECTOR_CLASSES } from './types.js';
import type { Report, VectorResult } from './types.js';

// Drops the C0 control characters XML 1.0 cannot carry (all but tab, LF
// and CR), one UTF-16 unit at a time so surrogate pairs pass untouched.
function xmlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)
      out += text.charAt(i);
  }
  return out;
}

// Escapes text for an XML attribute, keeping newlines as character refs.
function attr(text: string): string {
  return xmlChars(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;');
}

// A MUST that did not pass fails the case; a SHOULD failure and every other
// non-pass is skipped with its outcome and reasons.
function testcase(r: VectorResult): string {
  const open = `    <testcase classname="${attr(r.class)}" name="${attr(r.id)}"`;
  if (r.outcome === 'pass') return `${open}/>`;
  const reasons = r.reasons.join('; ');
  let body: string;
  if (r.level === 'MUST' && r.outcome !== 'not-applicable')
    body = `<failure message="${attr(`${r.outcome}: ${reasons}`)}"/>`;
  else if (r.level === 'SHOULD' && r.outcome === 'fail')
    body = `<skipped message="${attr(`SHOULD not met: ${reasons}`)}"/>`;
  else body = `<skipped message="${attr(`${r.outcome}: ${reasons}`)}"/>`;
  return `${open}>\n      ${body}\n    </testcase>`;
}

// The report as JUnit XML: one testsuite per class, one testcase per vector.
export function toJUnit(report: Report): string {
  const suites: string[] = [];
  let tests = 0;
  let failures = 0;
  for (const cls of VECTOR_CLASSES) {
    const cases = report.vectors.filter((v) => v.class === cls);
    if (cases.length === 0) continue;
    const failed = cases.filter(
      (r) =>
        r.level === 'MUST' &&
        r.outcome !== 'pass' &&
        r.outcome !== 'not-applicable'
    ).length;
    const skipped = cases.filter((r) => r.outcome !== 'pass').length - failed;
    tests += cases.length;
    failures += failed;
    suites.push(
      [
        `  <testsuite name="${cls}" tests="${cases.length}" failures="${failed}" errors="0" skipped="${skipped}">`,
        ...cases.map(testcase),
        '  </testsuite>',
      ].join('\n')
    );
  }
  const name = attr(
    `${report.implementation.name} ${report.implementation.version}`
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${name}" tests="${tests}" failures="${failures}">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}
