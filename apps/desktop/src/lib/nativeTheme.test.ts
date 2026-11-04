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

// The app's own commands go through Tauri's `invoke`, which calls
// `window.__TAURI_INTERNALS__.invoke`: defining it plays the backend's
// remember_window_theme without mock.module (which bun hoists across every
// file in the run). Each remembered choice is recorded; `failRemember` makes
// the next write reject, as a full disk would. Removed after each test, so
// isTauri() is false again for every other file.
type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
  };
};
const remembered: unknown[] = [];
let failRemember = false;

const root = document.documentElement;
let stop: () => void = () => undefined;

beforeEach(() => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown) => {
      if (cmd !== 'remember_window_theme') {
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
      remembered.push((args as { choice: unknown }).choice);
      if (failRemember) {
        failRemember = false;
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(null);
    },
  };
});

afterEach(() => {
  stop();
  stop = () => undefined;
  sent.length = 0;
  remembered.length = 0;
  failNext = false;
  failRemember = false;
  holdCalls = false;
  delete root.dataset.theme;
  delete (window as TauriWindow).__TAURI_INTERNALS__;
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
    // A browser page: no Tauri internals at all.
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow();
    expect(sent).toEqual([]);
    expect(remembered).toEqual([]);
  });
});

// The window is built before the page runs, from the choice remembered
// natively, so every choice the window is sent is remembered too.
describe('remembering the choice for the next launch', () => {
  test('the shown choice is remembered at startup and on every change', async () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    root.dataset.theme = 'dark';
    await settle();
    root.dataset.theme = 'light';
    await settle();
    root.dataset.theme = 'system';
    await settle();
    expect(remembered).toEqual(['system', 'dark', 'light', 'system']);
  });

  test('an unchanged choice is not written again', async () => {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow(true);
    root.dataset.theme = 'dark';
    await settle();
    expect(remembered).toEqual(['dark']);
  });

  test('a failed write is logged, the window still follows, and later choices are remembered', async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      root.dataset.theme = 'light';
      failRemember = true;
      stop = followThemeInNativeWindow(true);
      await settle();
      expect(logged.map((args) => args[0])).toEqual([
        'theme: remembering the window appearance failed',
      ]);
      expect(sent).toEqual(['light']);
      root.dataset.theme = 'dark';
      await settle();
      expect(remembered).toEqual(['light', 'dark']);
      expect(sent).toEqual(['light', 'dark']);
    } finally {
      console.error = original;
    }
  });

  test('outside Tauri nothing is remembered', async () => {
    root.dataset.theme = 'dark';
    stop = followThemeInNativeWindow(false);
    root.dataset.theme = 'light';
    await settle();
    expect(remembered).toEqual([]);
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

  // Setup may have built the window pinned from the window-theme file while
  // the page's own stored choice is System (a dev build and the installed
  // app share the file, not localStorage), so the first hand-back at startup
  // is held too, until the media query changes.
  test('startup on System holds transitions until the scheme changes', async () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    expect(sent).toEqual([null]);
    expect(switching()).toBe(true);
    land();
    await settle();
    await frames(3);
    expect(switching()).toBe(true);
    for (const listener of [...schemeListeners]) listener();
    expect(schemeListeners.size).toBe(0);
    await frames(3);
    expect(switching()).toBe(false);
  });

  test('startup on System with no scheme change holds only briefly after the call lands', async () => {
    root.dataset.theme = 'system';
    stop = followThemeInNativeWindow(true);
    expect(switching()).toBe(true);
    land();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await frames(3);
    expect(switching()).toBe(false);
    expect(schemeListeners.size).toBe(0);
  });

  test('startup on Light and a swap between Light and Dark hold nothing', async () => {
    root.dataset.theme = 'light';
    stop = followThemeInNativeWindow(true);
    expect(switching()).toBe(false);
    land();
    root.dataset.theme = 'dark';
    await settle();
    land();
    root.dataset.theme = 'light';
    await settle();
    expect(sent).toEqual(['light', 'dark', 'light']);
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
