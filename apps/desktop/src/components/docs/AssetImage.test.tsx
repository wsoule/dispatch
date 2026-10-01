import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';

import { AssetImage } from './AssetImage';

const NAME = `${'a'.repeat(64)}.png`;
afterEach(cleanup);

test('resolves asset: through the docs API into a blob URL, revoked on unmount', async () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    created.push('blob:doc-image');
    return 'blob:doc-image';
  };
  URL.revokeObjectURL = (url: string) => revoked.push(url);
  try {
    const fetchDocAsset = mock((_doc: string, _name: string) =>
      Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    );
    const view = render(
      <AssetImage
        client={{ fetchDocAsset }}
        docId="doc-1"
        src={`asset:${NAME}`}
        alt="shot"
      />
    );
    const img = await screen.findByRole('img', { name: 'shot' });
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:doc-image'));
    expect(fetchDocAsset).toHaveBeenCalledWith('doc-1', NAME);
    view.unmount();
    expect(revoked).toEqual(created);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('never fetches a malformed asset name, and never loads a remote image', () => {
  const fetchDocAsset = mock(() => Promise.resolve(new Blob()));
  render(
    <AssetImage
      client={{ fetchDocAsset }}
      docId="doc-1"
      src="asset:../../docs.db"
      alt="bad"
    />
  );
  expect(screen.queryByRole('img', { name: 'bad' })).toBeNull();
  render(
    <AssetImage
      client={{ fetchDocAsset }}
      docId="doc-1"
      src="https://example.com/x.png"
      alt="remote"
    />
  );
  // A remote image is never loaded (no tracking pixels): a link stands in.
  expect(screen.queryByRole('img', { name: 'remote' })).toBeNull();
  expect(
    screen.getByRole('link', { name: /remote/ }).getAttribute('href')
  ).toBe('https://example.com/x.png');
  expect(fetchDocAsset).not.toHaveBeenCalled();
});

test('a new name drops the old image and its failure, and shows the new one', async () => {
  const other = `${'b'.repeat(64)}.png`;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let made = 0;
  URL.createObjectURL = () => `blob:image-${(made += 1)}`;
  URL.revokeObjectURL = () => undefined;
  try {
    const fetchDocAsset = (_doc: string, name: string) =>
      name === NAME
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(new Blob([new Uint8Array([1])]));
    const view = render(
      <AssetImage
        client={{ fetchDocAsset }}
        docId="doc-1"
        src={`asset:${NAME}`}
        alt="pic"
      />
    );
    expect(await screen.findByText(/could not load/)).toBeDefined();
    view.rerender(
      <AssetImage
        client={{ fetchDocAsset }}
        docId="doc-1"
        src={`asset:${other}`}
        alt="pic"
      />
    );
    const img = await screen.findByRole('img', { name: 'pic' });
    expect(img.getAttribute('src')).toBe('blob:image-1');
    expect(screen.queryByText(/could not load/)).toBeNull();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('links a remote image only over http or https, never another scheme', () => {
  const fetchDocAsset = mock(() => Promise.resolve(new Blob()));
  for (const [src, alt] of [
    ['javascript:alert(1)', 'js'],
    ['  JAVASCRIPT:alert(1)', 'upper'],
    ['data:image/png;base64,AAAA', 'inline'],
  ] as const) {
    render(
      <AssetImage
        client={{ fetchDocAsset }}
        docId="doc-1"
        src={src}
        alt={alt}
      />
    );
    expect(screen.getByText(`[image: ${alt}]`).closest('a')).toBeNull();
  }
  render(
    <AssetImage
      client={{ fetchDocAsset }}
      docId="doc-1"
      src="https://example.com/ok.png"
      alt="safe"
    />
  );
  expect(
    screen.getByRole('link', { name: '[image: safe]' }).getAttribute('href')
  ).toBe('https://example.com/ok.png');
  expect(fetchDocAsset).not.toHaveBeenCalled();
});
