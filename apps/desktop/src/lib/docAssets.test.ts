import { describe, expect, it } from 'bun:test';

import { assetNameOf, docUrlTransform, imageFiles } from './docAssets';

const NAME = `${'a'.repeat(64)}.png`;

describe('docUrlTransform', () => {
  it('keeps asset: only as an image source and defers to react-markdown otherwise', () => {
    expect(docUrlTransform(`asset:${NAME}`, 'src')).toBe(`asset:${NAME}`);
    expect(docUrlTransform(`asset:${NAME}`, 'href')).toBe('');
    expect(docUrlTransform('https://example.com/x.png', 'src')).toBe(
      'https://example.com/x.png'
    );
    expect(docUrlTransform('javascript:alert(1)', 'href')).toBe('');
  });
});

describe('assetNameOf', () => {
  it('reads a well-formed asset name and nothing else', () => {
    expect(assetNameOf(`asset:${NAME}`)).toBe(NAME);
    for (const src of [
      `asset:../${NAME}`,
      'asset:x.png',
      `asset:${'a'.repeat(64)}.svg`,
      `https://e.com/${NAME}`,
      undefined,
    ]) {
      expect(assetNameOf(src)).toBeNull();
    }
  });
});

describe('imageFiles', () => {
  it('keeps only image files from a paste or drop', () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(imageFiles([png, text])).toEqual([png]);
    expect(imageFiles(null)).toEqual([]);
  });
});
