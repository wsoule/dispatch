import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

// True inside a rendered markdown link, where another <a> would be invalid.
const InsideLink = createContext(false);

/** A markdown link that tells the images inside it they are already linked. */
export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      <InsideLink.Provider value={true}>{children}</InsideLink.Provider>
    </a>
  );
}

/** A markdown image that is never fetched: a remote image would load from
 *  someone else's server on every view (a tracking pixel), so it shows as a
 *  link over http(s) and as plain text for any other scheme. */
export function LinkedImage({ src, alt }: { src?: string; alt?: string }) {
  const linked = useContext(InsideLink);
  if (src === undefined || src === '') return null;
  const label = `[image: ${alt !== undefined && alt !== '' ? alt : src}]`;
  // Inside a link the label is plain text: an <a> may not hold another.
  return isWebUrl(src) && !linked ? (
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
