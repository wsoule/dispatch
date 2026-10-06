import type { BrowserInfo, PickedElement } from '@dispatch/client';
import { Copy, Crosshair, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { BackToTasks } from '../components/tasks/BackToTasks';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  designHandoffText,
  designHandoffTitle,
  interestingStyles,
} from '../lib/designHandoff';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

/**
 * Design Mode: open your app in a browser the daemon drives, click the thing
 * that is wrong, and hand it to an agent.
 *
 * The browser is a real window rather than a frame in this app, because the
 * whole interaction is pointing at your own running app — hovering it,
 * scrolling it, clicking through to the state where the problem shows. A
 * screenshot streamed into a panel can be looked at but not used.
 */

// How often to ask whether the user has clicked yet. Fast enough to feel
// immediate, slow enough not to hammer the daemon while someone navigates
// around looking for the right element.
const PICK_POLL_MS = 300;

interface DesignViewProps {
  data: DispatchProjectData;
  /** Two views: starts the header with "‹ tasks"; Classic leaves it out. */
  onBack?: () => void;
}

export function DesignView({ data, onBack }: DesignViewProps) {
  const { client } = data;
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [url, setUrl] = useState('http://localhost:5173');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (client === null) return;
    try {
      const open = await client.listBrowsers();
      setBrowsers(open);
      setActiveId((current) =>
        current !== null && open.some((b) => b.id === current)
          ? current
          : (open[0]?.id ?? null)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not list browsers');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(async () => {
    if (client === null) return;
    try {
      const info = await client.launchBrowser({ url });
      setBrowsers((prev) => [...prev, info]);
      setActiveId(info.id);
      setError(null);
    } catch (err) {
      // The common failure is no Chromium installed, and the daemon's message
      // already names the remedy — so it is shown as-is rather than replaced.
      setError(err instanceof Error ? err.message : 'could not open a browser');
    }
  }, [client, url]);

  const close = useCallback(
    async (id: string) => {
      if (client === null) return;
      try {
        await client.closeBrowser(id);
      } catch {
        // Already gone; the refresh reconciles.
      }
      void refresh();
    },
    [client, refresh]
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPicking(false);
  }, []);

  const startPick = useCallback(async () => {
    if (client === null || activeId === null) return;
    try {
      await client.browserStartPick(activeId);
      setPicked(null);
      setShot(null);
      setPicking(true);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'could not start Design Mode'
      );
      return;
    }

    pollRef.current = setInterval(() => {
      void client
        .browserPickResult(activeId)
        .then((outcome) => {
          if (outcome.state === 'waiting') return;
          stopPolling();
          if (outcome.state === 'picked') {
            setPicked(outcome.element);
            setShot(outcome.screenshot);
          }
        })
        .catch(() => {
          // The browser was closed underneath us; stop rather than poll a
          // session that no longer exists.
          stopPolling();
        });
    }, PICK_POLL_MS);
  }, [client, activeId, stopPolling]);

  // A poll must never outlive the view.
  useEffect(() => stopPolling, [stopPolling]);

  const handoff = picked === null ? '' : designHandoffText(picked, note);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(handoff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [handoff]);

  if (client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        {onBack && <BackToTasks onBack={onBack} />}
        <Globe className="size-4" />
        <h1 className="text-sm font-medium">Design</h1>
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://localhost:5173"
          className="h-7 max-w-sm text-xs"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void open();
          }}
        />
        <Button size="sm" variant="outline" onClick={() => void open()}>
          <Plus className="mr-1 size-3" />
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refresh()}
          title="Refresh"
        >
          <RefreshCw className="size-3" />
        </Button>
      </header>

      {error !== null && (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-destructive)]">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1 border-r border-[var(--color-border)] p-2">
          {browsers.length === 0 && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              No browsers open.
            </p>
          )}
          {browsers.map((info) => (
            <div
              key={info.id}
              className={`flex items-center gap-1 rounded px-1 py-1 text-xs ${
                info.id === activeId ? 'bg-[var(--color-accent)]' : ''
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => setActiveId(info.id)}
                title={info.url}
              >
                {info.url}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                title="Close"
                onClick={() => void close(info.id)}
              >
                <X className="size-3" />
              </Button>
            </div>
          ))}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={picking ? 'default' : 'outline'}
              disabled={activeId === null}
              onClick={() => (picking ? stopPolling() : void startPick())}
            >
              <Crosshair className="mr-1 size-3" />
              {picking ? 'Waiting for a click…' : 'Pick an element'}
            </Button>
            {picking && (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                Click anything in the browser window. Esc cancels.
              </span>
            )}
          </div>

          {picked === null ? (
            <div className="flex flex-1 items-center justify-center text-xs text-[var(--color-muted-foreground)]">
              <p>Open your app, then pick the element you want changed.</p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="truncate text-xs font-medium">
                  {designHandoffTitle(picked)}
                </p>
                {shot !== null && (
                  <img
                    src={`data:image/png;base64,${shot}`}
                    alt={picked.selector}
                    className="max-h-48 self-start rounded border border-[var(--color-border)] object-contain"
                  />
                )}
                <code className="truncate rounded bg-[var(--color-muted)] px-1 py-0.5 text-[11px]">
                  {picked.selector}
                </code>
                <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--color-border)] p-2">
                  <pre className="text-[11px] whitespace-pre-wrap">
                    {picked.outerHTML}
                  </pre>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 text-[11px]">
                    {Object.entries(interestingStyles(picked.styles)).map(
                      ([prop, value]) => (
                        <div key={prop} className="contents">
                          <dt className="text-[var(--color-muted-foreground)]">
                            {prop}
                          </dt>
                          <dd className="truncate">{value}</dd>
                        </div>
                      )
                    )}
                  </dl>
                </div>
              </div>

              <div className="flex w-80 shrink-0 flex-col gap-2">
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="What should change about this?"
                  className="h-24 text-xs"
                />
                <Button size="sm" onClick={copy}>
                  <Copy className="mr-1 size-3" />
                  {copied ? 'Copied' : 'Copy for an agent'}
                </Button>
                <pre className="min-h-0 flex-1 overflow-auto rounded border border-[var(--color-border)] p-2 text-[10px] whitespace-pre-wrap">
                  {handoff}
                </pre>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
