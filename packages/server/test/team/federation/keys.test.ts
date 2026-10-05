import { publicOfPrivate } from '@dispatch-foo/protocol/federation';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrCreateKeys } from '../../../src/team/federation/keys.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-keys-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

describe('replica keys on disk', () => {
  it('creates keys/ 0700 and replica.json 0600, and returns the same keys on reopen', () => {
    const keys = loadOrCreateKeys(dir, 'ada-0000000a');
    expect(mode(join(dir, 'keys'))).toBe(0o700);
    expect(mode(join(dir, 'keys', 'replica.json'))).toBe(0o600);
    expect(publicOfPrivate(keys.signPriv)).toBe(keys.signPub);
    expect(publicOfPrivate(keys.sealPriv)).toBe(keys.sealPub);
    expect(loadOrCreateKeys(dir, 'ada-0000000a')).toEqual(keys);
  });

  it('puts the modes back every time it opens them', () => {
    loadOrCreateKeys(dir, 'ada-0000000a');
    chmodSync(join(dir, 'keys'), 0o755);
    chmodSync(join(dir, 'keys', 'replica.json'), 0o644);
    loadOrCreateKeys(dir, 'ada-0000000a');
    expect(mode(join(dir, 'keys'))).toBe(0o700);
    expect(mode(join(dir, 'keys', 'replica.json'))).toBe(0o600);
  });

  it("retires another replica's keys, never deleting them, and makes new ones", () => {
    const old = loadOrCreateKeys(dir, 'ada-0000000a');
    const fresh = loadOrCreateKeys(dir, 'ada-1111111b');
    expect(fresh.signPub).not.toBe(old.signPub);
    expect(readdirSync(join(dir, 'keys')).sort()).toEqual([
      'replica-ada-0000000a.retired.json',
      'replica.json',
    ]);
    expect(
      existsSync(join(dir, 'keys', 'replica-ada-0000000a.retired.json'))
    ).toBe(true);
  });

  it('gives a returning replica its own retired keys, never new ones', () => {
    const first = loadOrCreateKeys(dir, 'ada-0000000a');
    const other = loadOrCreateKeys(dir, 'ada-1111111b');
    expect(loadOrCreateKeys(dir, 'ada-0000000a')).toEqual(first);
    expect(loadOrCreateKeys(dir, 'ada-1111111b')).toEqual(other);
    expect(readdirSync(join(dir, 'keys')).sort()).toEqual([
      'replica-ada-0000000a.retired.json',
      'replica.json',
    ]);
  });

  it('never retires a key file over an earlier retired one', () => {
    const keys = join(dir, 'keys');
    loadOrCreateKeys(dir, 'ada-0000000a');
    copyFileSync(
      join(keys, 'replica.json'),
      join(keys, 'replica-ada-0000000a.retired.json')
    );
    loadOrCreateKeys(dir, 'ada-1111111b');
    expect(readdirSync(keys).sort()).toEqual([
      'replica-ada-0000000a.retired-2.json',
      'replica-ada-0000000a.retired.json',
      'replica.json',
    ]);
  });

  it('refuses a key file whose private and public keys do not match', () => {
    const keys = loadOrCreateKeys(dir, 'ada-0000000a');
    const other = loadOrCreateKeys(join(dir, 'other'), 'ada-0000000a');
    const file = join(dir, 'keys', 'replica.json');
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        replica: 'ada-0000000a',
        ...keys,
        signPub: other.signPub,
      })
    );
    expect(() => loadOrCreateKeys(dir, 'ada-0000000a')).toThrow(
      'does not hold a matching key pair'
    );
  });

  it('refuses a key file that is not one, saying how to start over', () => {
    mkdirSync(join(dir, 'keys'), { recursive: true });
    writeFileSync(join(dir, 'keys', 'replica.json'), '{"v":2}');
    expect(() => loadOrCreateKeys(dir, 'ada-0000000a')).toThrow(
      'is not a replica key file; move it aside and join as a new replica'
    );
  });

  it('writes the key file whole, leaving no temporary file behind', () => {
    mkdirSync(join(dir, 'keys'), { recursive: true });
    writeFileSync(join(dir, 'keys', 'replica.json.tmp'), '{"v":1,"repl');
    const keys = loadOrCreateKeys(dir, 'ada-0000000a');
    expect(readdirSync(join(dir, 'keys'))).toEqual(['replica.json']);
    expect(loadOrCreateKeys(dir, 'ada-0000000a')).toEqual(keys);
  });
});
