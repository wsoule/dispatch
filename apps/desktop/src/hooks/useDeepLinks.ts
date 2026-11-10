import { useEffect, useRef } from 'react';

import { formatIssueLink, formatTaskLink } from '../lib/deepLink';
import { isTauri } from '../lib/tauri';

/**
 * Delivers every deep link the window receives to `onLink`, always in the
 * `dispatch://` form so the router (`useDeepLinkRouter`) parses one shape.
 * In the Tauri webview that is the deep-link plugin: `getCurrent()` once for
 * a cold start (`open 'dispatch://…'` delivers the URL before the webview has
 * subscribed) then `onOpenUrl` for links opened while the app runs. In the
 * browser-dev harness there is no plugin, so a `?task=<id>` on the harness URL
 * (beside its `root`) is read once on mount instead — the form
 * `formatTaskLink(…, 'browser')` writes. A `?issue=<IDENTIFIER>` needs no
 * root: it becomes `dispatch://issue/<IDENTIFIER>`, resolved in the open
 * project, which is how the hosted planner (app.dispatch.foo, whose root is
 * injected rather than on the URL) opens a link the desktop app wrote with
 * `formatWebIssueLink`. `onLink` lives in a ref so the subscription happens
 * exactly once per mount.
 *
 * The cold-start sources replay: the plugin never clears `current` after
 * `getCurrent`, and StrictMode runs the mount effect twice, so a URL those
 * two hand over is delivered once per hook instance. `onOpenUrl` deliveries
 * are never filtered — opening the same link twice on purpose opens it twice.
 */
export function useDeepLinks(onLink: (url: string) => void): void {
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const delivered = useRef(new Set<string>());

  useEffect(() => {
    const deliver = (url: string) => {
      delivered.current.add(url);
      onLinkRef.current(url);
    };
    const deliverOnce = (url: string) => {
      if (!delivered.current.has(url)) deliver(url);
    };

    if (!isTauri()) {
      const params = new URLSearchParams(window.location.search);
      const task = params.get('task');
      const root = params.get('root');
      if (task !== null && root !== null) {
        deliverOnce(formatTaskLink({ taskId: task, project: root }, 'app'));
      }
      const issue = params.get('issue');
      if (issue !== null) deliverOnce(formatIssueLink(issue));
      return;
    }

    // Loaded lazily so the plugin's `invoke` never runs outside the webview. A
    // failed plugin call is logged, not thrown: a link that does not arrive is
    // not worth an error boundary.
    const plugin = import('@tauri-apps/plugin-deep-link');
    void plugin
      .then(({ getCurrent }) => getCurrent())
      .then((urls) => urls?.forEach(deliverOnce))
      .catch((err: unknown) =>
        console.error('deep-link: getCurrent failed', err)
      );
    const unlisten = plugin.then(({ onOpenUrl }) =>
      onOpenUrl((urls) => urls.forEach(deliver))
    );
    unlisten.catch((err: unknown) =>
      console.error('deep-link: onOpenUrl failed', err)
    );

    return () => {
      // The rejection above is already logged; nothing to unlisten then.
      void unlisten.then(
        (fn) => fn(),
        () => {}
      );
    };
  }, []);
}
