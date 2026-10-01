import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sniffImage } from '../../src/docs/assets.js';
import type { DocsService } from '../../src/docs/service.js';
import type { FakeDocsHost } from './fakeHost.js';
import {
  AGENT,
  makeService,
  OWNER,
  REVIEW_RUN,
  RUN,
  TEAMMATE,
} from './fakeHost.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode('GIF89a......');
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

describe('sniffImage', () => {
  it('types an image by its bytes alone', () => {
    expect(sniffImage(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(GIF)).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(sniffImage(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('refuses SVG and anything unknown, whatever it claims to be', () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(
      sniffImage(new TextEncoder().encode('\u0089PNG pretend'))
    ).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('the asset store', () => {
  let service: DocsService;
  let host: FakeDocsHost;
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-assets-')));
    ({ service, host } = makeService({ assetsDir: join(dir, 'docs-assets') }));
    host.operators.set('human:wyat', {
      human: 'human:wyat',
      identity: 'id-wyat',
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);

  it('stores an upload under a name from its hash and sniffed type, 0600 in a 0700 directory', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const up = service.putAsset(as(OWNER), 'img', PNG);
    expect(up.name).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(up.markdown).toBe(`![](asset:${up.name})`);
    const read = service.asset(as(TEAMMATE), 'img', up.name);
    expect(read.mime).toBe('image/png');
    expect(new Uint8Array(readFileSync(read.path))).toEqual(PNG);
    expect(statSync(read.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'docs-assets', made.doc.id)).mode & 0o777).toBe(
      0o700
    );
    // The same bytes again are the same asset.
    expect(service.putAsset(as(OWNER), 'img', PNG).name).toBe(up.name);
  });

  it('refuses SVG, empty and oversize uploads, and non-writers', () => {
    service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    expect(() => service.putAsset(as(OWNER), 'img', SVG)).toThrow(
      'png, jpeg, gif or webp'
    );
    expect(() =>
      service.putAsset(as(OWNER), 'img', new Uint8Array())
    ).toThrow();
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(() => service.putAsset(as(OWNER), 'img', big)).toThrow('25 MiB');
    expect(() => service.putAsset(as(REVIEW_RUN), 'img', PNG)).toThrow();
    expect(() =>
      service.putAsset(service.overseerActor(), 'img', PNG)
    ).toThrow();
  });

  it('reads only a well-formed name with a row for that doc', () => {
    service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    service.create(as(OWNER), { title: 'Other', body: 'y\n' });
    const { name } = service.putAsset(as(RUN), 'img', PNG);
    for (const bad of [
      '../../docs.db',
      '../docs.db',
      `${name}\u0000.png`,
      'docs.db',
      `${name.slice(0, 60)}.svg`,
    ]) {
      expect(() => service.asset(as(OWNER), 'img', bad)).toThrow(
        'not an asset name'
      );
    }
    expect(() =>
      service.asset(as(OWNER), 'img', `${'b'.repeat(64)}.png`)
    ).toThrow('not found');
    expect(() => service.asset(as(OWNER), 'other', name)).toThrow('not found');
  });

  it('refuses to read or write through a symlink in the asset store', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const { name } = service.putAsset(as(OWNER), 'img', PNG);
    const file = join(dir, 'docs-assets', made.doc.id, name);
    rmSync(file);
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, file);
    expect(() => service.asset(as(OWNER), 'img', name)).toThrow('symlink');

    const other = service.create(as(OWNER), { title: 'Two', body: 'x\n' });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'docs-assets', other.doc.id));
    expect(() => service.putAsset(as(OWNER), 'two', JPEG)).toThrow('symlink');
    expect(existsSync(join(elsewhere, `${'0'.repeat(64)}.jpg`))).toBe(false);
  });

  it("hides a personal doc's asset from anyone else, and an agent may not read it", () => {
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    const { name } = service.putAsset(as(OWNER), '~mine', PNG);
    expect(service.asset(as(OWNER), '~mine', name).mime).toBe('image/png');
    for (const who of [TEAMMATE, AGENT]) {
      expect(() => service.asset(as(who), '~mine', name)).toThrow();
    }
  });

  it('removes a deleted doc’s images', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    service.putAsset(as(OWNER), 'img', PNG);
    service.remove(as(OWNER), 'img');
    expect(existsSync(join(dir, 'docs-assets', made.doc.id))).toBe(false);
  });

  it('answers unavailable with no asset store', () => {
    const plain = makeService();
    plain.service.create(plain.service.actorFor(OWNER), {
      title: 'Img',
      body: 'x\n',
    });
    expect(() =>
      plain.service.putAsset(plain.service.actorFor(OWNER), 'img', PNG)
    ).toThrow('images');
  });
});
