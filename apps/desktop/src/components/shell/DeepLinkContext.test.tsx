import { act, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  DeepLinkProvider,
  useCopyTaskLink,
  useDeepLinkActions,
  useWebLinkActions,
} from './DeepLinkContext';
import { ToastProvider } from './Toasts';

// The harness URL a copied link is derived from: neither token may survive.
function setHarnessUrl(search: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(`http://localhost:5173/${search}`);
}

function stubClipboard(written: string[], fail?: Error) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (fail) return Promise.reject(fail);
        written.push(text);
        return Promise.resolve();
      },
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

afterEach(() => {
  setHarnessUrl('');
});

describe('useDeepLinkActions', () => {
  test('is null outside the provider', () => {
    const { result } = renderHook(() => useDeepLinkActions());
    expect(result.current).toBeNull();
  });

  test('hands back the provided actions', () => {
    const actions = { copyTaskLink: () => {} };
    const { result } = renderHook(() => useDeepLinkActions(), {
      wrapper: ({ children }) => (
        <DeepLinkProvider value={actions}>{children}</DeepLinkProvider>
      ),
    });
    expect(result.current).toBe(actions);
  });
});

describe('useCopyTaskLink (browser harness)', () => {
  test('writes the ?task= form without either token and toasts Copied link', async () => {
    setHarnessUrl(
      `?root=${encodeURIComponent('/repo/a')}&port=4100&token=secret&appToken=app-secret`
    );
    const written: string[] = [];
    stubClipboard(written);
    const { result } = renderHook(() => useCopyTaskLink('/repo/a'), {
      wrapper,
    });
    act(() => {
      result.current('t-1a2b3c');
    });
    expect(written).toHaveLength(1);
    const url = new URL(written[0] ?? '');
    expect(url.searchParams.get('task')).toBe('t-1a2b3c');
    expect(url.searchParams.get('root')).toBe('/repo/a');
    expect(url.searchParams.get('port')).toBe('4100');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('appToken')).toBe(false);
    expect(await screen.findByText('Copied link')).toBeTruthy();
  });

  test('in the app it writes the dispatch:// form instead', async () => {
    setHarnessUrl(`?root=${encodeURIComponent('/repo/a')}&token=secret`);
    const written: string[] = [];
    stubClipboard(written);
    // Named rather than read off `window.__TAURI_INTERNALS__`: bun hoists every
    // `mock.module('../lib/tauri')` in the run, so `isTauri()` is not ours to set here.
    const { result } = renderHook(
      () => useCopyTaskLink('/repo/a', () => 'app'),
      { wrapper }
    );
    act(() => {
      result.current('t-1a2b3c');
    });
    expect(written).toEqual([
      `dispatch://task/t-1a2b3c?project=${encodeURIComponent('/repo/a')}`,
    ]);
    expect(await screen.findByText('Copied link')).toBeTruthy();
  });

  test('a denied clipboard toasts Copy failed with the reason', async () => {
    setHarnessUrl(`?root=${encodeURIComponent('/repo/a')}`);
    stubClipboard([], new Error('denied'));
    const { result } = renderHook(() => useCopyTaskLink('/repo/a'), {
      wrapper,
    });
    act(() => {
      result.current('t-1a2b3c');
    });
    expect(await screen.findByText('Copy failed')).toBeTruthy();
    expect(await screen.findByText('denied')).toBeTruthy();
  });

  test('no active project toasts Copy failed and writes nothing', async () => {
    const written: string[] = [];
    stubClipboard(written);
    const { result } = renderHook(() => useCopyTaskLink(null), { wrapper });
    act(() => {
      result.current('t-1a2b3c');
    });
    expect(written).toEqual([]);
    expect(await screen.findByText('Copy failed')).toBeTruthy();
    expect(await screen.findByText('No project is open')).toBeTruthy();
  });
});

describe('useWebLinkActions', () => {
  test('the hosted planner only opens the desktop app', () => {
    const { result } = renderHook(() => useWebLinkActions(true), { wrapper });
    expect(result.current.openIssueInDesktop).toBeDefined();
    expect(result.current.openWebLink).toBeUndefined();
    expect(result.current.copyWebLink).toBeUndefined();
  });

  test('the desktop copies the web link and toasts Copied web link', async () => {
    const written: string[] = [];
    stubClipboard(written);
    const { result } = renderHook(() => useWebLinkActions(false), { wrapper });
    expect(result.current.openIssueInDesktop).toBeUndefined();
    act(() => {
      result.current.copyWebLink?.(
        'https://app.dispatch.foo/w/acme/?issue=DIS-66'
      );
    });
    expect(written).toEqual(['https://app.dispatch.foo/w/acme/?issue=DIS-66']);
    expect(await screen.findByText('Copied web link')).toBeTruthy();
  });
});
