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
 *  through the docs API into a blob URL revoked on unmount; other sources pass through. */
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
  return <img src={src} alt={alt ?? ''} />;
}
