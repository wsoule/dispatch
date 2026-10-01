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

test('never fetches a malformed asset name, and shows other images as they are', () => {
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
  expect(screen.getByRole('img', { name: 'remote' }).getAttribute('src')).toBe(
    'https://example.com/x.png'
  );
  expect(fetchDocAsset).not.toHaveBeenCalled();
});
