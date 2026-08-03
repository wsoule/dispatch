import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const POLYFILL_SOURCE = readFileSync(
  join(import.meta.dir, 'legacyWebkitPolyfills.js'),
  'utf8'
);

// The polyfills patch global prototypes, and the runtime this suite executes in
// already has every one of them — so asserting against the real globals would
// only ever test Bun's built-ins. Each case instead gets a fresh `vm` context
// (its own Array/String/Object realm), deletes the APIs a pre-16.4 WebKit lacks,
// and runs the polyfill text there, which is as close to old Safari as this
// machine can get.
type Evaluated = string | number | boolean | undefined;

function evaluateOnStrippedRealm(expression: string): Evaluated {
  const context = createContext({});
  runInContext(
    `delete Array.prototype.at;
     delete String.prototype.at;
     delete Array.prototype.findLast;
     delete Array.prototype.findLastIndex;
     delete Array.prototype.toSorted;
     delete Object.hasOwn;`,
    context
  );
  runInContext(POLYFILL_SOURCE, context);
  return runInContext(expression, context) as Evaluated;
}

describe('legacyWebkitPolyfills', () => {
  test('the stripped realm really is missing the APIs before the polyfill runs', () => {
    const context = createContext({});
    runInContext('delete Array.prototype.at; delete Object.hasOwn;', context);
    expect(runInContext('typeof [].at', context)).toBe('undefined');
    expect(runInContext('typeof Object.hasOwn', context)).toBe('undefined');
  });

  test('Array.prototype.at indexes from both ends', () => {
    expect(evaluateOnStrippedRealm('[10, 20, 30].at(0)')).toBe(10);
    expect(evaluateOnStrippedRealm('[10, 20, 30].at(-1)')).toBe(30);
    expect(evaluateOnStrippedRealm('[10, 20, 30].at(-3)')).toBe(10);
  });

  test('Array.prototype.at returns undefined out of range', () => {
    expect(evaluateOnStrippedRealm('[1, 2].at(5)')).toBeUndefined();
    expect(evaluateOnStrippedRealm('[1, 2].at(-5)')).toBeUndefined();
    expect(evaluateOnStrippedRealm('[].at(0)')).toBeUndefined();
  });

  test('String.prototype.at indexes from both ends', () => {
    expect(evaluateOnStrippedRealm('"abc".at(-1)')).toBe('c');
    expect(evaluateOnStrippedRealm('"abc".at(1)')).toBe('b');
    expect(evaluateOnStrippedRealm('"abc".at(9)')).toBeUndefined();
  });

  test('findLast/findLastIndex scan from the end', () => {
    expect(
      evaluateOnStrippedRealm('[1, 2, 3, 4].findLast(n => n % 2 === 1)')
    ).toBe(3);
    expect(
      evaluateOnStrippedRealm('[1, 2, 3, 4].findLastIndex(n => n % 2 === 1)')
    ).toBe(2);
  });

  test('findLast reports no match as undefined, findLastIndex as -1', () => {
    expect(
      evaluateOnStrippedRealm('[1, 3].findLast(n => n > 10)')
    ).toBeUndefined();
    expect(evaluateOnStrippedRealm('[1, 3].findLastIndex(n => n > 10)')).toBe(
      -1
    );
  });

  test('Object.hasOwn ignores inherited keys', () => {
    expect(evaluateOnStrippedRealm('Object.hasOwn({ a: 1 }, "a")')).toBe(true);
    expect(evaluateOnStrippedRealm('Object.hasOwn({ a: 1 }, "b")')).toBe(false);
    // The whole reason callers reach for hasOwn over `in`.
    expect(evaluateOnStrippedRealm('Object.hasOwn({}, "toString")')).toBe(
      false
    );
    expect(evaluateOnStrippedRealm('"toString" in {}')).toBe(true);
  });

  test('toSorted sorts a copy and leaves the receiver alone', () => {
    expect(
      evaluateOnStrippedRealm(
        'JSON.stringify((() => { const a = [3, 1, 2]; const b = a.toSorted((x, y) => x - y); return [a, b]; })())'
      )
    ).toBe('[[3,1,2],[1,2,3]]');
  });

  test('the shims are non-enumerable, so for...in over an array stays clean', () => {
    expect(
      evaluateOnStrippedRealm(
        '(() => { const keys = []; for (const k in ["x"]) keys.push(k); return keys.join(","); })()'
      )
    ).toBe('0');
  });

  test('a real implementation is never overwritten', () => {
    const context = createContext({});
    runInContext(
      'Array.prototype.toSorted = function () { return "native-marker"; };',
      context
    );
    runInContext(POLYFILL_SOURCE, context);
    expect(runInContext('[2, 1].toSorted()', context)).toBe('native-marker');
  });
});
