export interface InjectOptions {
  baseUrl: string; // absolute: https://<host>/s/<id>
  root: string; // session.paths.root
  agentToken: string;
  appToken: string | null;
  embed: boolean; // true hides the banner
}

// Real link the marketing site uses for "get the desktop app" — see
// apps/site/public/index.html's Linux install box.
const DESKTOP_APP_URL = 'https://github.com/wsoule/dispatch/releases/latest';

/**
 * Returns dist index.html with window.__DISPATCH_DEMO__ + the overlay script
 * tag and (unless embedded) the sandbox banner injected before </head> — or,
 * lacking that tag, before the first <script> — so the config lands ahead of
 * any app code.
 */
export function injectDemoHtml(distHtml: string, opts: InjectOptions): string {
  const config = JSON.stringify({
    baseUrl: opts.baseUrl,
    root: opts.root,
    agentToken: opts.agentToken,
    appToken: opts.appToken,
  })
    // Defensive escaping: none of these values are expected to contain
    // "</script>" today (tokens are hex, baseUrl is server-built), but a
    // literal "<" here would otherwise let embedded content close the tag
    // early and inject a sibling <script>.
    .replace(/</g, '\\u003c');
  const banner = opts.embed
    ? ''
    : `<div id="demo-banner">Sandbox — resets after 30 minutes of inactivity · <a href="${DESKTOP_APP_URL}">Get the desktop app</a> <a href="${opts.baseUrl}/" target="_blank">⤢</a></div>
<style>#demo-banner{position:fixed;top:0;left:0;right:0;z-index:9999;padding:6px 12px;font:12px system-ui;background:#17181c;color:#c8cad0;border-bottom:1px solid #23252a;text-align:center}#demo-banner a{color:#7c86e8}body{padding-top:30px}</style>`;
  const inject = `<script>window.__DISPATCH_DEMO__=${config}</script>
<script defer src="/demo-overlay.js"></script>
${banner}`;
  if (distHtml.includes('</head>')) {
    return distHtml.replace('</head>', `${inject}</head>`);
  }
  // No </head> tag (e.g. a fragment or malformed dist build) — fall back to
  // landing the config before the first script so it still runs first.
  const scriptIndex = distHtml.search(/<script/);
  if (scriptIndex === -1) return distHtml + inject;
  return distHtml.slice(0, scriptIndex) + inject + distHtml.slice(scriptIndex);
}
