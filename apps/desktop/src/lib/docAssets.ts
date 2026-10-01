import { ASSET_NAME } from '@dispatch/core/browser';
import { defaultUrlTransform } from 'react-markdown';

// react-markdown empties any URL whose protocol it does not know; the docs
// preview keeps asset: and resolves it itself (AssetImage).
export function docUrlTransform(url: string): string {
  return url.startsWith('asset:') ? url : defaultUrlTransform(url);
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
