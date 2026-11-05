import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

import {
  isLinearSignInUrl,
  LINEAR_SIGN_IN_TAB_BLOCKED,
  LINEAR_SIGN_IN_URL_REFUSED,
  openLinearSignIn,
  releaseLinearSignIn,
  reserveLinearSignIn,
} from './linearSignIn';

const LINEAR_URL =
  'https://linear.app/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A47823%2Flinear%2Fcallback&response_type=code&scope=read%2Cwrite&state=s&code_challenge=c&code_challenge_method=S256';
const FAKE_URL = 'http://127.0.0.1:61234/oauth/authorize?client_id=abc&state=s';

// The system browser the app hands a URL to (Tauri's open_url). Passed in:
// bun hoists every `mock.module('../lib/tauri')` in the run, so neither
// `openUrl` nor `isTauri()` is ours to play here.
function systemBrowser() {
  return mock((_url: string) => Promise.resolve());
}

// A tab the browser UI opened: records where it was sent and whether it closed.
function fakeTab() {
  const replace = mock((_url: string) => undefined);
  const close = mock(() => undefined);
  const tab = {
    opener: window as Window | null,
    location: { replace },
    close,
  };
  return { tab: tab as unknown as Window, raw: tab, replace, close };
}

// What an awaited call threw, or null when it resolved.
async function thrown(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'not an Error';
  }
}

const realOpen = window.open;
beforeEach(() => {
  window.open = realOpen;
});
afterEach(() => {
  window.open = realOpen;
});

test('accepts only Linear’s own consent page in the app', () => {
  expect(isLinearSignInUrl(LINEAR_URL, 'app')).toBe(true);
  for (const url of [
    'http://linear.app/oauth/authorize?client_id=abc',
    'https://linear.app.evil.example/oauth/authorize?client_id=abc',
    'https://evil.example/?https://linear.app/oauth/authorize?',
    'https://user@linear.app/oauth/authorize?client_id=abc',
    'https://linear.app/oauth/token?client_id=abc',
    'https://linear.app/oauth/authorize',
    'https://linear.app/oauth/authorize?client_id=a b',
    'https://linear.app/oauth/authorize?client_id=a\nb',
    'javascript:alert(1)//https://linear.app/oauth/authorize?',
    'file:///etc/passwd',
    'not a url',
    FAKE_URL,
  ]) {
    expect({ url, ok: isLinearSignInUrl(url, 'app') }).toEqual({
      url,
      ok: false,
    });
  }
});

test('the browser UI also accepts the authorize path on a 127.0.0.1 origin', () => {
  expect(isLinearSignInUrl(LINEAR_URL, 'browser')).toBe(true);
  expect(isLinearSignInUrl(FAKE_URL, 'browser')).toBe(true);
  for (const url of [
    'http://localhost:61234/oauth/authorize?client_id=abc',
    'http://127.0.0.1:61234/oauth/token?client_id=abc',
    'http://127.0.0.1:61234/linear/callback?code=x',
    'https://127.0.0.1:61234/oauth/authorize?client_id=abc',
    'http://user@127.0.0.1:61234/oauth/authorize?client_id=abc',
    'http://10.0.0.2:61234/oauth/authorize?client_id=abc',
  ]) {
    expect({ url, ok: isLinearSignInUrl(url, 'browser') }).toEqual({
      url,
      ok: false,
    });
  }
});

test('in the app the consent page opens in the system browser through open_url', async () => {
  const open = systemBrowser();
  window.open = mock(() => null) as unknown as typeof window.open;
  const target = reserveLinearSignIn(true);
  expect(target).toEqual({ kind: 'app' });
  expect(window.open).not.toHaveBeenCalled();
  await openLinearSignIn(LINEAR_URL, target, open);
  expect(open.mock.calls).toEqual([[LINEAR_URL]]);
});

test('in the app a URL that is not Linear’s opens nothing', async () => {
  const open = systemBrowser();
  const target = reserveLinearSignIn(true);
  expect(await thrown(openLinearSignIn(FAKE_URL, target, open))).toBe(
    LINEAR_SIGN_IN_URL_REFUSED
  );
  expect(
    await thrown(
      openLinearSignIn('https://evil.example/oauth/authorize?x=1', target, open)
    )
  ).toBe(LINEAR_SIGN_IN_URL_REFUSED);
  expect(open).not.toHaveBeenCalled();
});

test('the browser UI opens a tab inside the click and points it at the page later', async () => {
  const { tab, raw, replace, close } = fakeTab();
  const open = mock((_url?: string, _target?: string) => tab);
  window.open = open as unknown as typeof window.open;
  const target = reserveLinearSignIn(false);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]).toEqual(['', '_blank']);
  await openLinearSignIn(FAKE_URL, target);
  // The page it shows cannot reach back into this window.
  expect(raw.opener).toBeNull();
  expect(replace.mock.calls).toEqual([[FAKE_URL]]);
  expect(close).not.toHaveBeenCalled();
});

test('the browser UI closes the reserved tab when the URL is refused', async () => {
  const { tab, replace, close } = fakeTab();
  window.open = mock(() => tab) as unknown as typeof window.open;
  const target = reserveLinearSignIn(false);
  expect(
    await thrown(
      openLinearSignIn('https://evil.example/oauth/authorize?x=1', target)
    )
  ).toBe(LINEAR_SIGN_IN_URL_REFUSED);
  expect(replace).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test('a blocked tab reads as blocked and opens nothing', async () => {
  window.open = mock(() => null) as unknown as typeof window.open;
  const target = reserveLinearSignIn(false);
  expect(target).toEqual({ kind: 'blocked' });
  expect(await thrown(openLinearSignIn(LINEAR_URL, target))).toBe(
    LINEAR_SIGN_IN_TAB_BLOCKED
  );
});

test('releasing closes a reserved tab and is a no-op otherwise', () => {
  const { tab, close } = fakeTab();
  releaseLinearSignIn({ kind: 'tab', tab });
  releaseLinearSignIn({ kind: 'app' });
  releaseLinearSignIn({ kind: 'blocked' });
  expect(close).toHaveBeenCalledTimes(1);
});
