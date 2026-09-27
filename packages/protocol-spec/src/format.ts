import { isRecord, isStringArray, isText } from './guards.js';
import {
  CREATING_OPS,
  LEVELS,
  OPS,
  PROFILES,
  VECTOR_CLASSES,
} from './types.js';
import type { Op, Vector, VectorClass, VectorFile } from './types.js';

export class FormatError extends Error {}

const ID = /^[a-z0-9]+(\.[a-z0-9-]+){2}$/;
const SECTION = /^([0-9]+(\.[0-9]+)*|[A-F](\.[0-9]+)+)$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const AREA = /^[a-z0-9-]+$/;
const SYMBOL = /\$(s|gate|notice)([0-9]+)\b/g;
const CREATES: ReadonlySet<string> = new Set(CREATING_OPS);
const REQUIRED: Record<Op, readonly string[]> = {
  send: ['as', 'input'],
  reply: ['as', 'message', 'input'],
  close: ['question', 'reason'],
  markRead: ['message', 'recipient'],
  inbox: ['recipient'],
  thread: ['thread'],
  canRead: ['message', 'as'],
  openBlocking: [],
  join: ['channel', 'member'],
  leave: ['channel', 'member'],
  deliverHeld: ['session', 'workItem'],
  recover: [],
  parseAddress: ['input'],
  validate: ['as', 'input'],
  render: ['message'],
  'a2a.validate': ['extension', 'raw'],
  'a2a.project': ['facts'],
  'a2a.inbound': ['as', 'envelope', 'body'],
  world: ['change'],
};
const FILE_KEYS = ['kit', 'class', 'area', 'vectors'];
const VECTOR_KEYS = [
  'id',
  'title',
  'class',
  'level',
  'profile',
  'sections',
  'capability',
  'tags',
  'given',
  'when',
  'then',
];
const THEN_KEYS = [
  'steps',
  'messages',
  'noOtherMessages',
  'deliveries',
  'calls',
  'callsInclude',
  'gateEffects',
  'voided',
  'channels',
  'render',
];

type Fail = (why: string) => never;

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return (list as readonly unknown[]).includes(v);
}

function refuseUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  what: string,
  fail: Fail
): void {
  const extra = Object.keys(value).find((k) => !known.includes(k));
  if (extra !== undefined) fail(`${what} has unknown field ${extra}`);
}

// `$sN` must name an earlier step that created a message (spec:558-569).
function checkSymbols(v: Vector, fail: Fail): void {
  const bound = (n: number, before: number): boolean =>
    n >= 1 && n <= before && CREATES.has(v.when[n - 1]?.op ?? '');
  v.when.forEach((step, i) => {
    for (const m of JSON.stringify(step).matchAll(SYMBOL)) {
      if (m[1] === 's' && !bound(Number(m[2]), i))
        fail(`${m[0]} in step ${i + 1} names no earlier message`);
    }
  });
  for (const m of JSON.stringify(v.then).matchAll(SYMBOL)) {
    if (m[1] === 's' && !bound(Number(m[2]), v.when.length))
      fail(`${m[0]} in then names no message-creating step`);
  }
}

// Checks the steps of `when`: each an object with a known op and the fields
// that op needs.
function checkSteps(when: unknown, fail: Fail): void {
  if (!Array.isArray(when) || when.length === 0)
    fail('when must be a non-empty list of steps');
  (when as unknown[]).forEach((step, i) => {
    if (!isRecord(step)) fail(`step ${i + 1} is not an object`);
    const op = step['op'];
    if (!oneOf(OPS, op))
      fail(`step ${i + 1} has unknown op ${JSON.stringify(op)}`);
    for (const field of REQUIRED[op]) {
      if (step[field] === undefined)
        fail(`step ${i + 1} (${op}) needs ${JSON.stringify(field)}`);
    }
  });
}

// Checks `then` against the expectation vocabulary.
function checkThen(then: unknown, steps: number, fail: Fail): void {
  if (!isRecord(then)) fail('then must be an object');
  const t = then;
  refuseUnknownKeys(t, THEN_KEYS, 'then', fail);
  const expected = t['steps'];
  if (expected !== undefined) {
    if (!Array.isArray(expected)) fail('then.steps must be a list');
    const list = expected as unknown[];
    if (list.length > steps)
      fail(`then.steps lists ${list.length} results for ${steps} steps`);
    list.forEach((r, i) => {
      if (r !== null && !(isRecord(r) && typeof r['ok'] === 'boolean'))
        fail(`then.steps[${i}] must be null or { ok, … }`);
    });
  }
  for (const key of [
    'messages',
    'deliveries',
    'calls',
    'callsInclude',
    'channels',
    'render',
  ]) {
    const list = t[key];
    if (list !== undefined && !(Array.isArray(list) && list.every(isRecord)))
      fail(`then.${key} must be a list of objects`);
  }
  for (const key of ['gateEffects', 'voided']) {
    if (t[key] !== undefined && !isStringArray(t[key]))
      fail(`then.${key} must be a list of strings`);
  }
  if (
    t['noOtherMessages'] !== undefined &&
    typeof t['noOtherMessages'] !== 'boolean'
  )
    fail('then.noOtherMessages must be a boolean');
}

function parseVector(
  raw: unknown,
  index: number,
  fileClass: VectorClass,
  where: string
): Vector {
  const label =
    isRecord(raw) && typeof raw['id'] === 'string'
      ? raw['id']
      : `vectors[${index}]`;
  const fail: Fail = (why) => {
    throw new FormatError(`${where}: ${label}: ${why}`);
  };
  if (!isRecord(raw)) fail('is not an object');
  const v = raw;
  refuseUnknownKeys(v, VECTOR_KEYS, 'the vector', fail);
  if (typeof v['id'] !== 'string' || !ID.test(v['id']))
    fail(`id ${JSON.stringify(v['id'])} does not match ${String(ID)}`);
  if (!isText(v['title'])) fail('title must be a non-empty string');
  if (v['class'] !== fileClass)
    fail(
      `class ${JSON.stringify(v['class'])} differs from the file's class ${fileClass}`
    );
  if (!oneOf(LEVELS, v['level']))
    fail(`level must be one of ${LEVELS.join(', ')}`);
  const hasCapability = v['capability'] !== undefined;
  if (hasCapability && !isText(v['capability']))
    fail('capability must be a non-empty string');
  if (v['level'] === 'MAY' && !hasCapability)
    fail('a MAY vector names the capability it needs');
  if (v['level'] !== 'MAY' && hasCapability)
    fail('only a MAY vector names a capability');
  if (!oneOf(PROFILES, v['profile']))
    fail(`profile must be one of ${PROFILES.join(', ')}`);
  const sections = v['sections'];
  if (!isStringArray(sections) || sections.length === 0)
    fail('sections must be a non-empty list of section numbers');
  const badSection = sections.find((s) => !SECTION.test(s));
  if (badSection !== undefined)
    fail(`section ${JSON.stringify(badSection)} is not a section number`);
  if (v['tags'] !== undefined && !isStringArray(v['tags']))
    fail('tags must be a list of strings');
  if (!isRecord(v['given'])) fail('given must be an object');
  checkSteps(v['when'], fail);
  checkThen(v['then'], (v['when'] as unknown[]).length, fail);
  const vector = v as unknown as Vector;
  checkSymbols(vector, fail);
  return vector;
}

// Validates one vector file by hand (the kit has no runtime dependency), so
// the runner and the tests refuse a malformed vector before any adapter runs.
export function parseVectorFile(raw: unknown, where: string): VectorFile {
  const fail: Fail = (why) => {
    throw new FormatError(`${where}: ${why}`);
  };
  if (!isRecord(raw)) fail('is not an object');
  const file = raw;
  refuseUnknownKeys(file, FILE_KEYS, 'the file', fail);
  if (typeof file['kit'] !== 'string' || !SEMVER.test(file['kit']))
    fail('kit must be a semver version');
  if (!oneOf(VECTOR_CLASSES, file['class']))
    fail(`class must be one of ${VECTOR_CLASSES.join(', ')}`);
  if (typeof file['area'] !== 'string' || !AREA.test(file['area']))
    fail(`area must match ${String(AREA)}`);
  if (!Array.isArray(file['vectors'])) fail('vectors must be a list');
  const cls = file['class'];
  const vectors = (file['vectors'] as unknown[]).map((v, i) =>
    parseVector(v, i, cls, where)
  );
  return {
    kit: file['kit'],
    class: cls,
    area: file['area'],
    vectors,
  };
}
