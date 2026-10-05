// The slice of RFC 8941 Structured Field Values that HTTP Message Signatures
// need: Dictionaries, Inner Lists, Items and Parameters, parsed strictly (a
// duplicate key or parameter is refused rather than "last wins").

export class SfError extends Error {
  constructor(message: string) {
    super(`structured field: ${message}`);
    this.name = 'SfError';
  }
}

export class SfToken {
  constructor(readonly value: string) {}
}

type BareItem = number | string | boolean | SfToken | Uint8Array;
export type Params = Map<string, BareItem>;
export interface Item {
  value: BareItem;
  params: Params;
}
export interface InnerList {
  items: Item[];
  params: Params;
}
export type Member = Item | InnerList;

export function isInnerList(m: Member): m is InnerList {
  return 'items' in m;
}

const KEY_FIRST = /[a-z*]/;
const KEY_REST = /[a-z0-9_\-.*]/;
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const DIGIT = /[0-9]/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  peek(): string {
    return this.s.charAt(this.i);
  }
  take(): string {
    return this.s.charAt(this.i++);
  }
  skip(re: RegExp): void {
    while (!this.done && re.test(this.peek())) this.i += 1;
  }
}

function parseKey(r: Reader): string {
  if (!KEY_FIRST.test(r.peek())) throw new SfError('bad key');
  let key = r.take();
  while (!r.done && KEY_REST.test(r.peek())) key += r.take();
  return key;
}

function parseNumber(r: Reader): number {
  let text = '';
  if (r.peek() === '-') text += r.take();
  if (!DIGIT.test(r.peek())) throw new SfError('bad number');
  let decimal = false;
  while (!r.done) {
    const c = r.peek();
    if (DIGIT.test(c)) text += r.take();
    else if (c === '.' && !decimal) {
      decimal = true;
      text += r.take();
    } else break;
  }
  const digits = text.replace('-', '');
  if (!decimal) {
    if (digits.length > 15) throw new SfError('integer too long');
    return Number(text);
  }
  const [whole, frac] = digits.split('.');
  if (whole.length > 12 || frac.length === 0 || frac.length > 3)
    throw new SfError('bad decimal');
  return Number(text);
}

function parseString(r: Reader): string {
  r.take(); // "
  let out = '';
  for (;;) {
    if (r.done) throw new SfError('unterminated string');
    const c = r.take();
    if (c === '\\') {
      const next = r.take();
      if (next !== '"' && next !== '\\') throw new SfError('bad escape');
      out += next;
    } else if (c === '"') {
      return out;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) throw new SfError('bad string character');
      out += c;
    }
  }
}

function parseToken(r: Reader): SfToken {
  let out = r.take();
  while (!r.done && TCHAR.test(r.peek())) out += r.take();
  return new SfToken(out);
}

function parseBytes(r: Reader): Uint8Array {
  r.take(); // :
  const end = r.s.indexOf(':', r.i);
  if (end === -1) throw new SfError('unterminated byte sequence');
  const text = r.s.slice(r.i, end);
  r.i = end + 1;
  if (!B64.test(text) || text.length % 4 !== 0)
    throw new SfError('bad byte sequence');
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function parseBareItem(r: Reader): BareItem {
  const c = r.peek();
  if (c === '-' || DIGIT.test(c)) return parseNumber(r);
  if (c === '"') return parseString(r);
  if (c === ':') return parseBytes(r);
  if (c === '?') {
    r.take();
    const v = r.take();
    if (v !== '0' && v !== '1') throw new SfError('bad boolean');
    return v === '1';
  }
  if (c === '*' || /[A-Za-z]/.test(c)) return parseToken(r);
  throw new SfError('bad item');
}

function parseParams(r: Reader): Params {
  const params: Params = new Map();
  while (r.peek() === ';') {
    r.take();
    r.skip(/ /);
    const key = parseKey(r);
    let value: BareItem = true;
    if (r.peek() === '=') {
      r.take();
      value = parseBareItem(r);
    }
    if (params.has(key)) throw new SfError(`duplicate parameter ${key}`);
    params.set(key, value);
  }
  return params;
}

function parseItem(r: Reader): Item {
  const value = parseBareItem(r);
  return { value, params: parseParams(r) };
}

function parseInnerList(r: Reader): InnerList {
  r.take(); // (
  const items: Item[] = [];
  for (;;) {
    r.skip(/ /);
    if (r.done) throw new SfError('unterminated inner list');
    if (r.peek() === ')') {
      r.take();
      return { items, params: parseParams(r) };
    }
    items.push(parseItem(r));
    const c = r.peek();
    if (c !== ' ' && c !== ')') throw new SfError('bad inner list');
  }
}

/** A Dictionary field value (RFC 8941 §4.2.2), keys unique. */
export function parseDictionary(text: string): Map<string, Member> {
  const r = new Reader(text);
  const out = new Map<string, Member>();
  r.skip(/ /);
  if (r.done) return out;
  for (;;) {
    const key = parseKey(r);
    let member: Member;
    if (r.peek() === '=') {
      r.take();
      member = r.peek() === '(' ? parseInnerList(r) : parseItem(r);
    } else {
      member = { value: true, params: parseParams(r) };
    }
    if (out.has(key)) throw new SfError(`duplicate key ${key}`);
    out.set(key, member);
    r.skip(/[ \t]/);
    if (r.done) return out;
    if (r.take() !== ',') throw new SfError('expected a comma');
    r.skip(/[ \t]/);
    if (r.done) throw new SfError('trailing comma');
  }
}

function serializeBare(v: BareItem): string {
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SfError('bad number');
    if (Number.isInteger(v)) return String(v);
    const fixed = v.toFixed(3).replace(/0+$/, '');
    return fixed.endsWith('.') ? `${fixed}0` : fixed;
  }
  if (v instanceof SfToken) return v.value;
  if (v instanceof Uint8Array) return `:${Buffer.from(v).toString('base64')}:`;
  if (!/^[\x20-\x7e]*$/.test(v)) throw new SfError('bad string character');
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function serializeParams(params: Params): string {
  let out = '';
  for (const [key, value] of params)
    out += value === true ? `;${key}` : `;${key}=${serializeBare(value)}`;
  return out;
}

export function serializeItem(item: Item): string {
  return serializeBare(item.value) + serializeParams(item.params);
}

export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(' ')})${serializeParams(list.params)}`;
}
