/**
 * Joins class names, dropping empty and missing ones. CSS-module lookups
 * can be undefined (a variant without a rule, or Bun's test runner, which
 * resolves modules to {}), and "undefined" must never reach the DOM.
 */
export function cx(...names: (string | false | null | undefined)[]): string {
  let out = '';
  for (const name of names) {
    if (name === undefined || name === null || name === false || name === '') {
      continue;
    }
    out = out === '' ? name : `${out} ${name}`;
  }
  return out;
}
