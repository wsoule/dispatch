import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// The Tauri window module, stubbed: getCurrentWindow() reads Tauri's IPC
// globals, which a test has none of. Each setTheme call is recorded, and
// `failNext` makes the next one reject as a denied permission would.
// With `holdCalls`, a call stays in flight until the test runs `land()`
// (or `refuse()`), as the native round trip does.
const sent: (string | null | undefined)[] = [];
let failNext = false;
let holdCalls = false;
let land: () => void = () => undefined;
let refuse: () => void = () => undefined;
const realWindow = await import('@tauri-apps/api/window');
void mock.module('@tauri-apps/api/window', () => ({
  ...realWindow,
  getCurrentWindow: () => ({
    setTheme: (theme?: string | null) => {
      sent.push(theme);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('window.set_theme not allowed'));
      }
      if (holdCalls) {
        return new Promise<void>((resolve, reject) => {
          land = resolve;
          refuse = () => reject(new Error('window.set_theme not allowed'));
        });
      }
      return Promise.resolve();
    },
  }),
}));

const { followThemeInNativeWindow, nativeThemeFor } =
  await import('./nativeTheme');

const root = document.documentElement;
let stop: () => void = () => undefined;

afterEach(() => {
  stop();
  stop = () => undefined;
  sent.length = 0;
  failNext = false;
  holdCalls = false;
  delete root.dataset.theme;
});

// MutationObserver reports on a microtask; a rejected setTheme settles on
// a later one. A macrotask turn covers both.
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('nativeThemeFor', () => {
  test('Light and Dark pin the window; System hands it to the OS', () => {
    expect(nativeThemeFor('light')).toBe('light');
    expect(nativeThemeFor('dark')).toBe('dark');
    expect(nativeThemeFor('system')).toBeNull();
  });
});

describe('followThemeInNativeWindow', () => {
  test('in Tauri it applies the shown theme at once', () => {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow(true);
    expect(sent).toEqual(['dark']);
  });

  test('a page following the OS sends null, so the window follows it too', () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    expect(sent).toEqual([null]);
  });

  // The footer toggle, Settings, the palette and other windows all write
  // html[data-theme]; each change reaches the window.
  test('it follows every change of html[data-theme]', async () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    root.dataset.theme = 'dark';
    await settle();
    root.dataset.theme = 'light';
    await settle();
    root.dataset.theme = 'system';
    await settle();
    expect(sent).toEqual([null, 'dark', 'light', null]);
  });

  test('an unchanged theme is not sent again', async () => {
    root.dataset.theme = 'light';
    stop = followThemeInNativeWindow(true);
    root.dataset.theme = 'light';
    await settle();
    expect(sent).toEqual(['light']);
  });

  test('stopping disconnects it', async () => {
    root.dataset.theme = 'light';
    stop = followThemeInNativeWindow(true);
    stop();
    root.dataset.theme = 'dark';
    await settle();
    expect(sent).toEqual(['light']);
  });

  test('a refused call is logged, not thrown, and later changes still go', async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      root.dataset.theme = 'light';
      failNext = true;
      stop = followThemeInNativeWindow(true);
      await settle();
      expect(logged).toHaveLength(1);
      root.dataset.theme = 'dark';
      await settle();
      expect(sent).toEqual(['light', 'dark']);
    } finally {
      console.error = original;
    }
  });

  // A browser build has no native window: nothing is called or observed.
  test('outside Tauri it never calls the window API', async () => {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow(false);
    root.dataset.theme = 'light';
    await settle();
    expect(sent).toEqual([]);
  });

  test('by default it asks isTauri, which a test page is not', () => {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow();
    expect(sent).toEqual([]);
  });
});

// System after a pinned Light or Dark: the webview's prefers-color-scheme
// follows the pinned window until the null call lands and the OS pushes its
// appearance, so the swap holds transitions off until the scheme settles.
describe('handing a pinned window back to the OS', () => {
  const schemeListeners = new Set<() => void>();
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    holdCalls = true;
    schemeListeners.clear();
    window.matchMedia = (() => ({
      matches: true,
      addEventListener: (_type: string, listener: () => void) => {
        schemeListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        schemeListeners.delete(listener);
      },
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(async () => {
    window.matchMedia = originalMatchMedia;
    await frames(3);
    root.removeAttribute('data-theme-switching');
  });

  const switching = () => root.hasAttribute('data-theme-switching');

  function frames(count: number): Promise<void> {
    return count === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          requestAnimationFrame(() => resolve(frames(count - 1)));
        });
  }

  // Pins Dark, lets that call land, then picks System.
  async function darkThenSystem(): Promise<void> {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow(true);
    land();
    await settle();
    expect(switching()).toBe(false);
    root.dataset.theme = 'system';
    await settle();
    expect(sent).toEqual(['dark', null]);
  }

  test('transitions stay off while the call is in flight, and until the scheme changes', async () => {
    await darkThenSystem();
    expect(switching()).toBe(true);
    land();
    await settle();
    await frames(3);
    expect(switching()).toBe(true);
    // The OS pushed its appearance: the media query changed.
    for (const listener of [...schemeListeners]) listener();
    expect(schemeListeners.size).toBe(0);
    await frames(3);
    expect(switching()).toBe(false);
  });

  test('with no scheme change (the OS already matched), they come back shortly after the call lands', async () => {
    await darkThenSystem();
    land();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await frames(3);
    expect(switching()).toBe(false);
    expect(schemeListeners.size).toBe(0);
  });

  test('a refused call gives them back at once', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      await darkThenSystem();
      refuse();
      await settle();
      await frames(3);
      expect(switching()).toBe(false);
    } finally {
      console.error = original;
    }
  });

  test('startup on System and a swap between Light and Dark hold nothing', async () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    expect(switching()).toBe(false);
    land();
    root.dataset.theme = 'light';
    await settle();
    land();
    root.dataset.theme = 'dark';
    await settle();
    expect(sent).toEqual([null, 'light', 'dark']);
    expect(switching()).toBe(false);
    expect(schemeListeners.size).toBe(0);
  });

  test('stopping releases a hold still waiting', async () => {
    await darkThenSystem();
    stop();
    stop = () => undefined;
    await frames(3);
    expect(switching()).toBe(false);
    expect(schemeListeners.size).toBe(0);
  });
});
