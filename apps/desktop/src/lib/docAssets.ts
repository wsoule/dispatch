import { ASSET_NAME } from '@dispatch-foo/core/browser';
import { defaultUrlTransform } from 'react-markdown';

// react-markdown empties any URL whose protocol it does not know; the docs
// preview keeps asset: as an image's source only (AssetImage resolves it),
// never as a link a click would follow.
export function docUrlTransform(url: string, key: string): string {
  return key === 'src' && url.startsWith('asset:')
    ? url
    : defaultUrlTransform(url);
}

/** The stored image an `asset:` URL names, or null for any other source. */
export function assetNameOf(src: string | undefined): string | null {
  if (src === undefined || !src.startsWith('asset:')) return null;
  const name = src.slice('asset:'.length);
  return ASSET_NAME.test(name) ? name : null;
}

/** The image files a paste or drop carried; the daemon types them by their bytes. */
export function imageFiles(files: ArrayLike<File> | null): File[] {
  return files === null
    ? []
    : Array.from(files).filter((f) => f.type.startsWith('image/'));
}
