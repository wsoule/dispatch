import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { StrictMode } from 'react';

// The plugin's JS invokes the webview; stubbed with a controllable pair so the
// Tauri branch can be driven here. The hook imports it lazily and only in that
// branch, so the browser tests below never see the stub.
let current: string[] | null = null;
let openHandler: ((urls: string[]) => void) | null = null;
let unlistened = 0;
void mock.module('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: () => Promise.resolve(current),
  onOpenUrl: (handler: (urls: string[]) => void) => {
    openHandler = handler;
    return Promise.resolve(() => {
      unlistened += 1;
    });
  },
}));
const { useDeepLinks } = await import('./useDeepLinks');

// happy-dom has no `__TAURI_INTERNALS__`; the Tauri tests define it for their
// duration. The registrator's document starts at `about:blank`, where
// `replaceState` refuses a URL, so happy-dom's own `setURL` gives it an origin.
function setSearch(search: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(`http://localhost:5173/${search}`);
}

function enterTauri() {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ =
    {};
}

// Unmounts first and lets the plugin's unlisten promise settle: a test that
// leaves its hook mounted would otherwise unlisten during the next test (the
// shared setup unmounts after this hook runs) and count against its total.
afterEach(async () => {
  cleanup();
  await act(async () => {});
  setSearch('');
  delete (window as unknown as { __TAURI_INTERNALS__?: object })
    .__TAURI_INTERNALS__;
  current = null;
  openHandler = null;
  unlistened = 0;
});

describe('useDeepLinks (browser harness)', () => {
  test('a ?task= beside ?root= yields exactly one link in the app form', () => {
    setSearch(
      `?root=${encodeURIComponent('/Users/me/repo')}&port=4100&token=secret&task=t-1a2b3c`
    );
    const seen: string[] = [];
    const { rerender } = renderHook(() =>
      useDeepLinks((url) => seen.push(url))
    );
    rerender();
    expect(seen).toEqual([
      `dispatch://task/t-1a2b3c?project=${encodeURIComponent('/Users/me/repo')}`,
    ]);
  });

  test('no params yields nothing', () => {
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)));
    expect(seen).toEqual([]);
  });

  test('a task without a root yields nothing', () => {
    setSearch('?task=t-1a2b3c');
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)));
    expect(seen).toEqual([]);
  });

  test('a rerender does not resubscribe', () => {
    setSearch(`?root=${encodeURIComponent('/repo')}&task=t-1a2b3c`);
    const first: string[] = [];
    const second: string[] = [];
    const { rerender } = renderHook(
      ({ sink }: { sink: string[] }) => useDeepLinks((url) => sink.push(url)),
      { initialProps: { sink: first } }
    );
    rerender({ sink: second });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("StrictMode's second mount effect does not deliver the link again", () => {
    setSearch(`?root=${encodeURIComponent('/repo')}&task=t-1a2b3c`);
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)), {
      wrapper: StrictMode,
    });
    expect(seen).toHaveLength(1);
  });
});

describe('useDeepLinks (Tauri)', () => {
  const COLD = `dispatch://task/t-1a2b3c?project=${encodeURIComponent('/repo')}`;
  const WARM = `dispatch://task/t-ffffff?project=${encodeURIComponent('/repo')}`;

  test('delivers the cold-start link, then live opens to the latest handler', async () => {
    enterTauri();
    current = [COLD];
    const first: string[] = [];
    const second: string[] = [];
    const { rerender, unmount } = renderHook(
      ({ sink }: { sink: string[] }) => useDeepLinks((url) => sink.push(url)),
      { initialProps: { sink: first } }
    );
    await act(async () => {});
    expect(first).toEqual([COLD]);
    expect(openHandler).not.toBeNull();

    rerender({ sink: second });
    act(() => openHandler?.([WARM]));
    expect(first).toEqual([COLD]);
    expect(second).toEqual([WARM]);

    unmount();
    await act(async () => {});
    expect(unlistened).toBe(1);
  });

  test('a null getCurrent delivers nothing', async () => {
    enterTauri();
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)));
    await act(async () => {});
    expect(seen).toEqual([]);
  });

  test('the same link opened twice on purpose is delivered twice', async () => {
    enterTauri();
    current = [COLD];
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)));
    await act(async () => {});
    act(() => openHandler?.([COLD]));
    expect(seen).toEqual([COLD, COLD]);
  });

  test("StrictMode's replayed getCurrent does not deliver the cold link again", async () => {
    enterTauri();
    current = [COLD];
    const seen: string[] = [];
    renderHook(() => useDeepLinks((url) => seen.push(url)), {
      wrapper: StrictMode,
    });
    await act(async () => {});
    expect(seen).toEqual([COLD]);
  });
});
