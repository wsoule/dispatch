// Registers happy-dom's globals so `bun test` can render React; unmounts between
// tests. @testing-library/react is imported dynamically because a static import
// hoists above `register()`, and its `screen` singleton captures `document.body`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, jest, setSystemTime } from 'bun:test';

// Tests never reach the network. happy-dom would otherwise send a real request
// for every fetch, XMLHttpRequest and iframe `src` (a daemon port nothing
// listens on prints ECONNREFUSED, and one something does listen on answers).
// Each request is refused and remembered, and the test that sent it fails in
// the afterEach below; a test that needs an answer stubs `fetch` or the client.
const requests: string[] = [];

// The error a refused request rejects with, naming what was asked for.
function refused(url: string): TypeError {
  return new TypeError(`test setup: no network in tests (${url})`);
}

GlobalRegistrator.register({
  settings: {
    fetch: {
      interceptor: {
        beforeAsyncRequest: ({ request }) => {
          requests.push(request.url);
          return Promise.reject(refused(request.url));
        },
        beforeSyncRequest: ({ request }) => {
          requests.push(request.url);
          throw refused(request.url);
        },
      },
    },
    // An iframe keeps its `src` attribute but loads nothing.
    navigation: { disableChildFrameNavigation: true },
  },
});

// The app's index.html starts with `<!doctype html>`, so the document is in
// standards mode. happy-dom's has no doctype and no `compatMode`, which KaTeX
// reads as quirks mode when it loads (it warns, and disables `katex.render`).
document.insertBefore(
  document.implementation.createDocumentType('html', '', ''),
  document.documentElement
);
Object.defineProperty(document, 'compatMode', {
  configurable: true,
  get: () => (document.doctype === null ? 'BackCompat' : 'CSS1Compat'),
});

const { act, cleanup } = await import('@testing-library/react');
const { notifyManager } = await import('@tanstack/react-query');

// TanStack Query tells its observers about a settled read on a timer tick of
// its own, which can fall outside any act a test is awaiting (bun even runs
// one between a test's end and its afterEach hooks), so the re-render it
// causes, and the effects that render runs, would warn. Each notification
// runs inside act instead, as the library's testing guide recommends.
notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

// What the window and <html> looked like before any test ran.
const startUrl = window.location.href;
const rootAttributes = new Map(
  Array.from(document.documentElement.attributes, (a) => [a.name, a.value])
);

// Restores <html>'s attributes (a theme, a `data-*` flag) to the start.
function resetRootAttributes(): void {
  const root = document.documentElement;
  for (const { name } of Array.from(root.attributes)) {
    if (!rootAttributes.has(name)) root.removeAttribute(name);
  }
  for (const [name, value] of rootAttributes) root.setAttribute(name, value);
}

// Every test file shares this one document, so state a test leaves on it
// leaks into whichever file bun runs next, and file order differs between
// machines. A text selection is such state: IssuesView's bare Cmd+C copies a
// row's id only when nothing is selected, and DraftView's prompt-menu tests
// select prompt text, so in CI's order the copy test saw their selection.
// So each test ends with its trees unmounted, nothing selected, an empty body
// and storage, <html> and the URL as they started, outside Tauri, and on the
// real clock and timers; and fails if it reached for the network.
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetRootAttributes();
  if (window.location.href !== startUrl) {
    (
      window as unknown as { happyDOM: { setURL(url: string): void } }
    ).happyDOM.setURL(startUrl);
  }
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  jest.useRealTimers();
  setSystemTime();
  if (requests.length > 0) {
    const sent = requests.splice(0);
    throw new Error(`A test reached for the network: ${sent.join(', ')}`);
  }
});
