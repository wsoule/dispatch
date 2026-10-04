/** A markdown image that is never fetched: a remote image would load from
 *  someone else's server on every view (a tracking pixel), so it shows as a
 *  link over http(s) and as plain text for any other scheme. */
export function LinkedImage({ src, alt }: { src?: string; alt?: string }) {
  if (src === undefined || src === '') return null;
  const label = `[image: ${alt !== undefined && alt !== '' ? alt : src}]`;
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
