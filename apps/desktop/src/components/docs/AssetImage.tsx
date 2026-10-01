import type { ApiClient } from '@dispatch/client';
import { useEffect, useState } from 'react';

import { assetNameOf } from '../../lib/docAssets';

interface AssetImageProps {
  client: Pick<ApiClient, 'fetchDocAsset'>;
  docId: string;
  src: string | undefined;
  alt: string | undefined;
}

/** A doc preview's image: `asset:` names one of the doc's stored images, read
 *  through the docs API into a blob URL revoked on unmount; any other source
 *  becomes a link, never a loaded image. */
export function AssetImage({ client, docId, src, alt }: AssetImageProps) {
  const name = assetNameOf(src);
  const key = name === null ? null : `${docId}/${name}`;
  // What loaded, and for which image: a new doc or name never shows an old one.
  const [loaded, setLoaded] = useState<{
    key: string;
    url: string | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (name === null || key === null) return;
    let live = true;
    let made: string | null = null;
    client.fetchDocAsset(docId, name).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setLoaded({ key, url: made, failed: false });
      },
      () => {
        if (live) setLoaded({ key, url: null, failed: true });
      }
    );
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [client, docId, name, key]);
  const current = loaded !== null && loaded.key === key ? loaded : null;
  const url = current?.url ?? null;
  const failed = current?.failed ?? false;
  if (src?.startsWith('asset:') === true) {
    if (name === null) return null;
    if (failed)
      return (
        <span className="text-muted-foreground text-xs">{`[image ${alt ?? name} could not load]`}</span>
      );
    return url === null ? null : <img src={url} alt={alt ?? ''} />;
  }
  // A remote image would load from someone else's server on every view (a
  // tracking pixel), so it is shown as a link, never fetched.
  if (src === undefined || src === '') return null;
  const label = `[image: ${alt !== undefined && alt !== '' ? alt : src}]`;
  // Linked only over http(s); any other scheme (javascript:, data:) is text.
  return isWebUrl(src) ? (
    <a href={src} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

// Whether `src` parses as an absolute http: or https: URL.
function isWebUrl(src: string): boolean {
  try {
    const { protocol } = new URL(src);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
