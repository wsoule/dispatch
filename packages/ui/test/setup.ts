import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, jest, setSystemTime } from 'bun:test';

// A DOM for @testing-library/react. CSS modules resolve to plain objects
// under Bun, so class names are still testable.
//
// Tests never reach the network: every request happy-dom would send (fetch,
// XMLHttpRequest, a stylesheet or script a component adds) is refused here
// and remembered, and the test that sent it fails below. A test that needs an
// answer stubs `fetch` itself.
const requests: string[] = [];
GlobalRegistrator.register({
  settings: {
    fetch: {
      interceptor: {
        beforeAsyncRequest: ({ request }) => {
          requests.push(request.url);
          return Promise.reject(
            new TypeError(`test setup: no network in tests (${request.url})`)
          );
        },
        beforeSyncRequest: ({ request }) => {
          requests.push(request.url);
          throw new TypeError(
            `test setup: no network in tests (${request.url})`
          );
        },
      },
    },
    navigation: { disableChildFrameNavigation: true },
  },
});

// Imported after `register()`: a static import hoists above it, and the
// library's `screen` captures `document.body` when it loads.
const { cleanup } = await import('@testing-library/react');

// The root element's attributes as the registrator left them, so a theme or
// a `data-*` flag a test set on <html> does not reach the next test.
const rootAttributes = new Map(
  Array.from(document.documentElement.attributes, (a) => [a.name, a.value])
);

// Restores what <html> carried before any test ran.
function resetRootAttributes(): void {
  const root = document.documentElement;
  for (const { name } of Array.from(root.attributes)) {
    if (!rootAttributes.has(name)) root.removeAttribute(name);
  }
  for (const [name, value] of rootAttributes) root.setAttribute(name, value);
}

// Bun runs every test file of this package in this one document, in an order
// that differs between machines (and under --randomize, between runs), so
// anything a test leaves behind reaches whichever test runs next. Each test
// therefore ends with its trees unmounted, nothing selected, empty storage,
// a plain <html>, the real clock and real timers.
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  localStorage.clear();
  sessionStorage.clear();
  resetRootAttributes();
  jest.useRealTimers();
  setSystemTime();
  if (requests.length > 0) {
    const sent = requests.splice(0);
    throw new Error(`A test reached for the network: ${sent.join(', ')}`);
  }
});
