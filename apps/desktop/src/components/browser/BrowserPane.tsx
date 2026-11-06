import { Button, EmptyState, Notice, TextField, Tooltip } from '@dispatch/ui';
import { ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { browserRefusal, normalizeBrowserUrl } from '../../lib/browserPane';
import styles from './BrowserPane.module.css';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/**
 * The pane's sandbox. `allow-same-origin` lets a dev server keep its cookies,
 * storage and HMR socket; that is safe only because `browserRefusal` keeps
 * the frame off the app's own origin and the daemon's.
 */
const BROWSER_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-same-origin allow-modals';

export interface BrowserPaneProps {
  /** The page shown, or null before the first one. */
  url: string | null;
  onNavigate: (url: string) => void;
  onClose: () => void;
  /** The daemon's base URL, which the pane refuses to frame. */
  daemonBaseUrl: string | null | undefined;
  /** Opens the page in the default browser, for a site that refuses frames. */
  onOpenExternal: (url: string) => void;
}

/**
 * A browser beside the Overseer conversation: an address field and the page
 * in a frame, so a dev server (or a page the agent pointed at) can be watched
 * without leaving the app. Sites that forbid framing show blank; Open in
 * browser is the way out for those.
 */
export function BrowserPane({
  url,
  onNavigate,
  onClose,
  daemonBaseUrl,
  onOpenExternal,
}: BrowserPaneProps) {
  const [draft, setDraft] = useState(url ?? '');
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  // A page opened from elsewhere (an agent's door) replaces what was typed.
  useEffect(() => {
    setDraft(url ?? '');
    setError(null);
  }, [url]);
  // Nothing to show yet: the address field is the next thing to use.
  useEffect(() => {
    if (url === null) field.current?.focus();
  }, [url]);

  const refusal =
    url === null
      ? null
      : browserRefusal(url, {
          app: window.location.origin,
          daemon: daemonBaseUrl,
        });

  function go(event: FormEvent) {
    event.preventDefault();
    const next = normalizeBrowserUrl(draft);
    if (next === null) {
      setError('Enter a web address, like localhost:5173.');
      return;
    }
    setError(null);
    if (next === url) setReloads((n) => n + 1);
    else onNavigate(next);
  }

  return (
    <section
      aria-label="Browser"
      data-testid="browser-pane"
      className={styles.pane}
    >
      <form className={styles.bar} onSubmit={go}>
        <TextField
          ref={field}
          size="sm"
          className={styles.address}
          aria-label="Address"
          placeholder="localhost:5173"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft}
          invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Tooltip content="Reload">
          <Button
            size="sm"
            variant="quiet"
            aria-label="Reload page"
            disabled={url === null || refusal !== null}
            onClick={() => setReloads((n) => n + 1)}
            icon={<RotateCw {...ICON} />}
          />
        </Tooltip>
        <Tooltip content="Open in browser">
          <Button
            size="sm"
            variant="quiet"
            aria-label="Open in browser"
            disabled={url === null}
            onClick={() => {
              if (url !== null) onOpenExternal(url);
            }}
            icon={<ExternalLink {...ICON} />}
          />
        </Tooltip>
        <Tooltip content="Close browser">
          <Button
            size="sm"
            variant="quiet"
            aria-label="Close browser"
            onClick={onClose}
            icon={<X {...ICON} />}
          />
        </Tooltip>
      </form>
      {error !== null && (
        <div className={styles.error}>
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        </div>
      )}
      {url === null ? (
        <div className={styles.center}>
          <EmptyState label="Open a page" icon={<Globe size={22} />}>
            Type an address above, like your dev server at{' '}
            <span className="mono">localhost:5173</span>.
          </EmptyState>
        </div>
      ) : refusal !== null ? (
        <div className={styles.center}>
          <EmptyState label="Not opened here">{refusal}</EmptyState>
        </div>
      ) : (
        <iframe
          // Keyed on the page and on Reload, so pressing it reloads.
          key={`${url}#${reloads}`}
          title="Browser page"
          src={url}
          sandbox={BROWSER_SANDBOX}
          className={styles.frame}
        />
      )}
    </section>
  );
}
