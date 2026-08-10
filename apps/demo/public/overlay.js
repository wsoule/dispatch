// Injected into every served session page (see src/inject.ts). Polls the
// session's own liveness route and, once the sandbox is gone, covers the stale
// UI with an offer of a fresh one — the app itself has no concept of expiry.
(function () {
  var config = window.__DISPATCH_DEMO__;
  if (!config || typeof config.baseUrl !== 'string') return;

  var POLL_MS = 30000;
  var shown = false;
  var timer = null;

  function show() {
    if (shown) return;
    shown = true;
    // An expiry is final, so stop polling a sandbox that is already gone.
    if (timer !== null) clearInterval(timer);
    var overlay = document.createElement('div');
    overlay.id = 'demo-expired';
    overlay.setAttribute('role', 'alertdialog');
    overlay.innerHTML =
      '<div><h2>This sandbox expired.</h2>' +
      '<p>Sandboxes reset after 30 minutes of inactivity. Nothing in this one was saved.</p>' +
      '<a href="/">Start a fresh demo</a></div>';
    var style = document.createElement('style');
    style.textContent =
      '#demo-expired{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;' +
      'background:rgba(14,15,17,.92);backdrop-filter:blur(4px);color:#f7f8f8;' +
      'font:16px/1.55 system-ui,sans-serif;text-align:center;padding:24px}' +
      '#demo-expired h2{margin:0 0 8px;font-size:22px}' +
      '#demo-expired p{margin:0 0 20px;color:#858991;max-width:34em}' +
      '#demo-expired a{display:inline-block;padding:10px 20px;border-radius:8px;' +
      'background:#7c86e8;color:#10111a;font-weight:600;text-decoration:none}';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }

  function poll() {
    fetch(config.baseUrl + '/alive', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) show();
      })
      // A network blip is not an expiry; only a real answer from the server
      // that the session is gone puts the overlay up.
      .catch(function () {});
  }

  timer = setInterval(poll, POLL_MS);
})();
