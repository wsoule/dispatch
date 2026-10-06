import { MessagingError } from '@dispatch-foo/protocol';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LookupAll = (hostname: string) => Promise<string[]>;

// IPv4 ranges never fetched on a client's behalf (RFC 6890 special-purpose
// blocks, cloud metadata included: 169.254/16, 100.100/16, 192.0.0.192).
const V4_BLOCKS: readonly [base: string, bits: number, reason: string][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function v4ToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

function v4Reason(ip: string): string | null {
  const value = v4ToInt(ip);
  for (const [base, bits, reason] of V4_BLOCKS) {
    const mask = (~0 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return reason;
  }
  return null;
}

// Eight 16-bit groups, with `::` filled, a zone dropped and a dotted IPv4 tail folded in.
function v6Groups(ip: string): number[] {
  let text = ip.split('%')[0];
  const tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    tail.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
    text = text.slice(0, text.length - dotted[1].length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const split = text.includes('::') ? text.split('::') : [text];
  const parse = (s: string) =>
    s === '' ? [] : s.split(':').map((h) => parseInt(h, 16));
  const left = parse(split[0]);
  const right = split.length === 2 ? parse(split[1]) : [];
  const fill =
    split.length === 2 ? 8 - tail.length - left.length - right.length : 0;
  return [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
}

const v4Of = (hi: number, lo: number): string =>
  `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
const zero = (groups: number[]): boolean => groups.every((x) => x === 0);

// IPv6: anything outside global unicast (2000::/3) is refused, as are the
// special blocks inside it; forms that embed an IPv4 address are judged by it.
function v6Reason(g: number[]): string | null {
  if (zero(g)) return 'unspecified';
  if (zero(g.slice(0, 7)) && g[7] === 1) return 'loopback';
  const embedded = v4Of(g[6], g[7]);
  // ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (translated), ::a.b.c.d (compatible).
  if (zero(g.slice(0, 5)) && g[5] === 0xffff) return v4Reason(embedded);
  if (zero(g.slice(0, 4)) && g[4] === 0xffff && g[5] === 0)
    return v4Reason(embedded) ?? 'reserved';
  if (zero(g.slice(0, 6))) return v4Reason(embedded) ?? 'reserved';
  // NAT64: the well-known prefix translates to the embedded address.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(g.slice(2, 6)))
    return v4Reason(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'private';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if ((g[0] & 0xe000) !== 0x2000) return 'reserved';
  // 2001::/23 (Teredo, ORCHID and other protocol blocks) and 2001:db8::/32, 3fff::/20.
  if (g[0] === 0x2001 && g[1] < 0x200) return 'reserved';
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'reserved';
  if (g[0] === 0x3fff && g[1] < 0x1000) return 'reserved';
  // 6to4 carries its IPv4 address in the second and third groups.
  if (g[0] === 0x2002) return v4Reason(v4Of(g[1], g[2]));
  return null;
}

// Why a resolved address must not be fetched on a client's behalf, or null (spec:1771-1775).
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return v4Reason(ip);
  if (family === 6 || (ip.includes('%') && isIP(ip.split('%')[0]) === 6))
    return v6Reason(v6Groups(ip));
  return 'unspecified';
}

const defaultLookup: LookupAll = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(
    (r) => r.address
  );

/** The name did not resolve (offline, DNS down): a network failure to retry,
 *  unlike a refused address, which is final. */
export class UnresolvedHostError extends MessagingError {
  constructor(message: string, field: string) {
    super('invalid', message, field);
    this.name = 'UnresolvedHostError';
  }
}

/** A peer URL the guard refused at fetch time (a blocked address): final,
 *  and a sign the peer should be disabled. */
export class AddressRefusedError extends MessagingError {
  constructor(message: string, field: string) {
    super('invalid', message, field);
    this.name = 'AddressRefusedError';
  }
}

export interface GuardOptions {
  lookup?: LookupAll;
  field?: string;
}

// A URL a client or a decide-tier human supplied, checked before every fetch:
// https, a name (no IP literal, no userinfo), and every resolved address public.
// Returns the checked addresses, in the order the caller should try them.
export async function pinPublicUrl(
  raw: string,
  opts: GuardOptions = {}
): Promise<{ url: URL; address: string; addresses: string[] }> {
  const field = opts.field ?? 'cardUrl';
  const refuse = (why: string): never => {
    throw new MessagingError('invalid', `${field}: ${why}`, field);
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('not a URL');
  }
  if (url.protocol !== 'https:') refuse('must be https');
  if (url.username !== '' || url.password !== '')
    refuse('must not carry a user or password');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) !== 0 || host.includes(':'))
    refuse('name a host, not an IP address');
  const addresses = await (opts.lookup ?? defaultLookup)(host).catch(
    () => [] as string[]
  );
  if (addresses.length === 0)
    throw new UnresolvedHostError(`${field}: ${host} does not resolve`, field);
  for (const address of addresses) {
    const why = blockedAddressReason(address);
    if (why !== null)
      refuse(`${host} resolves to a ${why} address (${address})`);
  }
  return { url, address: addresses[0], addresses: [...addresses] };
}

/** `pinPublicUrl` for callers that only need the verdict. */
export async function guardPublicUrl(
  raw: string,
  opts: GuardOptions = {}
): Promise<URL> {
  return (await pinPublicUrl(raw, opts)).url;
}
