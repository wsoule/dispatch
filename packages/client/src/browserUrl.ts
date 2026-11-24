// A loopback host (with an optional port), which a bare entry opens over http.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

/**
 * Turns what was typed in the browser pane's address field into a URL to
 * frame, or null when it is not an http(s) address. A bare port opens on
 * localhost, a loopback host over http, and any other bare host over https.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  let candidate: string;
  if (/^\d{2,5}$/.test(text)) candidate = `http://localhost:${text}`;
  else if (/^:\d{2,5}(\/.*)?$/.test(text))
    candidate = `http://localhost${text}`;
  else if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) candidate = text;
  else {
    const host = text.split(/[/?#]/, 1)[0];
    if (LOOPBACK.test(host)) candidate = `http://${text}`;
    else if (host.includes('.')) candidate = `https://${text}`;
    else return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}
