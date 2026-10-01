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
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (name === null) return;
    let live = true;
    let made: string | null = null;
    client.fetchDocAsset(docId, name).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => {
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [client, docId, name]);
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
