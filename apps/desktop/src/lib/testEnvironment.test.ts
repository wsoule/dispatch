import { describe, expect, jest, test } from 'bun:test';

// What the shared test setup (test-setup.ts) promises every test file. Bun
// runs all of them in one document in an order that differs between machines,
// so a test that leaves state behind breaks whichever test runs next; the
// setup's afterEach clears it. The first test below leaves each kind of state,
// and the second finds none of it, in whichever order the two run.
describe('the shared test document', () => {
  test('a test may leave state behind it', () => {
    localStorage.setItem('leak', '1');
    sessionStorage.setItem('leak', '1');
    document.documentElement.setAttribute('data-theme', 'dark');
    const kept = document.createElement('p');
    kept.textContent = 'left in the body';
    document.body.append(kept);
    document.getSelection()?.selectAllChildren(kept);
    (
      window as unknown as { happyDOM: { setURL(url: string): void } }
    ).happyDOM.setURL('http://localhost:5173/?task=t-1');
    (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    jest.useFakeTimers();
    expect(localStorage.getItem('leak')).toBe('1');
  });

  test('the next test starts without it', () => {
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.body.childNodes).toHaveLength(0);
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0);
    expect(window.location.search).toBe('');
    expect('__TAURI_INTERNALS__' in window).toBe(false);
    // Real timers: a zero-delay timer fires without the clock being advanced.
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  // The app's page has a doctype; KaTeX reads quirks mode as a reason to warn
  // and refuse `render`.
  test('is a standards-mode document', async () => {
    expect(document.doctype?.name).toBe('html');
    expect(document.compatMode).toBe('CSS1Compat');
    const katex = (await import('katex')).default;
    const target = document.createElement('span');
    katex.render('x^2', target);
    expect(target.querySelector('.katex')).not.toBeNull();
  });

  // An iframe's `src` is kept for the test to read, and nothing is loaded: a
  // request for it would fail this test in the setup's afterEach.
  test('an iframe loads nothing', () => {
    const frame = document.createElement('iframe');
    frame.src = 'http://127.0.0.1:4771/preview/r-1/';
    document.body.append(frame);
    expect(frame.getAttribute('src')).toBe(
      'http://127.0.0.1:4771/preview/r-1/'
    );
  });
});
