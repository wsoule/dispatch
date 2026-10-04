import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
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

// Sweeps twice a day for `days`, as a running daemon would (far more often).
function sweepEvery12h(svc: DocsService, h: FakeDocsHost, days: number): void {
  for (let i = 0; i < days * 2; i++) {
    h.advance(12 * 60);
    svc.sweep();
  }
}

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

  it('refuses to read through a symlinked docs-assets or doc directory', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const { name } = service.putAsset(as(OWNER), 'img', PNG);
    const real = join(dir, 'docs-assets');
    const moved = join(dir, 'moved-assets');
    renameSync(real, moved);
    symlinkSync(moved, real);
    expect(() => service.assetBytes(as(OWNER), 'img', name)).toThrow('symlink');
    rmSync(real);
    renameSync(moved, real);
    const docDir = join(real, made.doc.id);
    const movedDoc = join(dir, 'moved-doc');
    renameSync(docDir, movedDoc);
    symlinkSync(movedDoc, docDir);
    expect(() => service.assetBytes(as(OWNER), 'img', name)).toThrow('symlink');
  });

  it('refuses an asset file with another hard link to it', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const { name } = service.putAsset(as(OWNER), 'img', PNG);
    linkSync(
      join(dir, 'docs-assets', made.doc.id, name),
      join(dir, 'elsewhere-link.png')
    );
    expect(() => service.assetBytes(as(OWNER), 'img', name)).toThrow('link');
  });

  it('refuses to serve an asset file whose bytes no longer match its name', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const { name } = service.putAsset(as(OWNER), 'img', PNG);
    writeFileSync(join(dir, 'docs-assets', made.doc.id, name), 'tampered');
    expect(() => service.assetBytes(as(OWNER), 'img', name)).toThrow(
      'does not match'
    );
  });

  it('rewrites an existing asset file whose bytes no longer match its name', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const { name } = service.putAsset(as(OWNER), 'img', PNG);
    const file = join(dir, 'docs-assets', made.doc.id, name);
    writeFileSync(file, 'tampered');
    service.putAsset(as(OWNER), 'img', PNG);
    expect(new Uint8Array(readFileSync(file))).toEqual(PNG);
    expect(service.assetBytes(as(OWNER), 'img', name).bytes).toEqual(PNG);
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

  it('promotes a personal doc with its images, so the team copy shows them', () => {
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    const shot = service.putAsset(as(OWNER), '~mine', PNG);
    service.putAsset(as(OWNER), '~mine', JPEG);
    service.saveBody(as(OWNER), '~mine', {
      baseRev: service.read(as(OWNER), '~mine').rev.id,
      body: `x\n${shot.markdown}\n`,
    });
    const promoted = service.promote(as(OWNER), '~mine');
    const read = service.asset(as(TEAMMATE), promoted.doc.id, shot.name);
    expect(new Uint8Array(readFileSync(read.path))).toEqual(PNG);
    // Only the images the head links travel.
    expect(() =>
      service.asset(as(TEAMMATE), promoted.doc.id, `${'0'.repeat(64)}.jpg`)
    ).toThrow('not found');
  });

  it('removes a deleted doc’s images', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    service.putAsset(as(OWNER), 'img', PNG);
    service.remove(as(OWNER), 'img');
    expect(existsSync(join(dir, 'docs-assets', made.doc.id))).toBe(false);
  });

  it("caps a doc's images by count and total bytes, from its rows", () => {
    const capped = makeService({
      assetsDir: join(dir, 'capped'),
      assetLimits: { files: 2, bytes: 40, projectBytes: 1000 },
    });
    const owner = capped.service.actorFor(OWNER);
    capped.service.create(owner, { title: 'Img', body: 'x\n' });
    const png = (tail: number) => {
      const b = new Uint8Array(PNG.length + 1);
      b.set(PNG);
      b[PNG.length] = tail;
      return b;
    };
    capped.service.putAsset(owner, 'img', png(1));
    // The same bytes again are the same asset, so they do not count twice.
    capped.service.putAsset(owner, 'img', png(1));
    capped.service.putAsset(owner, 'img', png(2));
    expect(() => capped.service.putAsset(owner, 'img', png(3))).toThrow(
      'at most 2 images'
    );
    expect(() => capped.service.assetUploadAllowed(owner, 'img')).toThrow(
      'at most 2 images'
    );
    const bytesCapped = makeService({
      assetsDir: join(dir, 'bytes'),
      assetLimits: { files: 10, bytes: 20, projectBytes: 1000 },
    });
    const o2 = bytesCapped.service.actorFor(OWNER);
    bytesCapped.service.create(o2, { title: 'Img', body: 'x\n' });
    bytesCapped.service.putAsset(o2, 'img', png(1));
    expect(() => bytesCapped.service.putAsset(o2, 'img', png(2))).toThrow(
      'at most 20 bytes of images'
    );
  });

  it("caps the project's images in all, across docs", () => {
    const capped = makeService({
      assetsDir: join(dir, 'project-cap'),
      assetLimits: { files: 10, bytes: 1000, projectBytes: 25 },
    });
    const owner = capped.service.actorFor(OWNER);
    capped.service.create(owner, { title: 'One', body: 'x\n' });
    capped.service.create(owner, { title: 'Two', body: 'x\n' });
    capped.service.putAsset(owner, 'one', PNG);
    expect(() => capped.service.putAsset(owner, 'two', JPEG)).not.toThrow();
    expect(() => capped.service.putAsset(owner, 'two', GIF)).toThrow(
      'project stores at most 25 bytes of images'
    );
  });

  it('re-uploads the same bytes at the file cap', () => {
    const capped = makeService({
      assetsDir: join(dir, 'same'),
      assetLimits: { files: 1, bytes: 1000, projectBytes: 1000 },
    });
    const owner = capped.service.actorFor(OWNER);
    capped.service.create(owner, { title: 'Img', body: 'x\n' });
    const first = capped.service.putAsset(owner, 'img', PNG);
    expect(capped.service.putAsset(owner, 'img', PNG).name).toBe(first.name);
    expect(() => capped.service.putAsset(owner, 'img', JPEG)).toThrow(
      'at most 1 images'
    );
  });

  it('checks the caller may write before the body is read', () => {
    service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    service.setStatus(as(OWNER), 'img', 'archived');
    expect(() => service.assetUploadAllowed(as(OWNER), 'img')).toThrow(
      'archived'
    );
    expect(() => service.assetUploadAllowed(as(REVIEW_RUN), 'img')).toThrow();
  });

  it('sweeps images no revision or proposal references, once they are 30 days old', () => {
    const made = service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    const kept = service.putAsset(as(OWNER), 'img', PNG);
    const dropped = service.putAsset(as(OWNER), 'img', JPEG);
    service.saveBody(as(OWNER), 'img', {
      baseRev: service.read(as(OWNER), 'img').rev.id,
      body: `x\n${kept.markdown}\n`,
    });
    service.sweep();
    expect(service.asset(as(OWNER), 'img', dropped.name).mime).toBe(
      'image/jpeg'
    );
    host.advance(31 * 24 * 60);
    // A month since the last sweep reads as a clock jump: nothing goes until
    // a full 30 days of clock have passed since it, sweep after sweep.
    service.sweep();
    sweepEvery12h(service, host, 29);
    expect(service.asset(as(OWNER), 'img', dropped.name).mime).toBe(
      'image/jpeg'
    );
    sweepEvery12h(service, host, 1.5);
    expect(() => service.asset(as(OWNER), 'img', dropped.name)).toThrow(
      'not found'
    );
    expect(
      existsSync(join(dir, 'docs-assets', made.doc.id, dropped.name))
    ).toBe(false);
    expect(service.asset(as(OWNER), 'img', kept.name).mime).toBe('image/png');
  });

  it('deletes no image while an image stamp is in the future', () => {
    service.create(as(OWNER), { title: 'Img', body: 'x\n' });
    service.sweep();
    const dropped = service.putAsset(as(OWNER), 'img', JPEG);
    // An upload stamped by a clock that ran 40 days fast, then came back.
    host.advance(40 * 24 * 60);
    service.putAsset(as(OWNER), 'img', PNG);
    host.advance(-40 * 24 * 60);
    for (let i = 0; i < 64; i++) {
      host.advance(12 * 60);
      service.sweep();
    }
    expect(service.asset(as(OWNER), 'img', dropped.name).mime).toBe(
      'image/jpeg'
    );
  });

  it('rescans a referenced image only once its last check is 30 days old', () => {
    const {
      service: svc,
      host: h,
      store,
    } = makeService({
      assetsDir: join(dir, 'rescan'),
    });
    const owner = svc.actorFor(OWNER);
    svc.create(owner, { title: 'Img', body: 'x\n' });
    const kept = svc.putAsset(owner, 'img', PNG);
    svc.saveBody(owner, 'img', {
      baseRev: svc.read(owner, 'img').rev.id,
      body: `x\n${kept.markdown}\n`,
    });
    h.advance(31 * 24 * 60);
    let scans = 0;
    const original = store.assetReferenced.bind(store);
    store.assetReferenced = (doc: string, name: string) => {
      scans += 1;
      return original(doc, name);
    };
    svc.sweep();
    svc.sweep();
    expect(scans).toBe(1);
    h.advance(31 * 24 * 60);
    // The month-long gap reads as a clock jump: no rescan for 30 days.
    svc.sweep();
    sweepEvery12h(svc, h, 29);
    expect(scans).toBe(1);
    sweepEvery12h(svc, h, 1.5);
    expect(scans).toBe(2);
  });

  it('leaves no team doc behind when promote cannot copy an image', () => {
    const made = service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    const shot = service.putAsset(as(OWNER), '~mine', PNG);
    service.saveBody(as(OWNER), '~mine', {
      baseRev: service.read(as(OWNER), '~mine').rev.id,
      body: `x\n${shot.markdown}\n`,
    });
    rmSync(join(dir, 'docs-assets', made.doc.id, shot.name));
    expect(() => service.promote(as(OWNER), '~mine')).toThrow();
    expect(
      service.list(as(OWNER), {}).docs.filter((d) => d.scope === 'team')
    ).toEqual([]);
    // Fixed, it promotes.
    service.putAsset(as(OWNER), '~mine', PNG);
    expect(service.promote(as(OWNER), '~mine').doc.scope).toBe('team');
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
