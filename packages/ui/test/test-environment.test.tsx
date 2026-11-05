import { render } from '@testing-library/react';
import { describe, expect, jest, setSystemTime, test } from 'bun:test';

// What the shared test setup (test/setup.ts) promises every test file. Bun
// runs all of them in one document in an order that differs between machines
// (and under --randomize, between runs), so a test that leaves state behind
// breaks whichever test runs next; the setup's afterEach clears it. The first
// test below leaves each kind of state, and the second finds none of it, in
// whichever order the two run.
describe('the shared test document', () => {
  test('a test may leave state behind it', () => {
    render(<p>left mounted</p>);
    localStorage.setItem('leak', '1');
    sessionStorage.setItem('leak', '1');
    document.documentElement.setAttribute('data-theme', 'dark');
    document
      .getSelection()
      ?.selectAllChildren(document.body.querySelector('p') as HTMLElement);
    jest.useFakeTimers();
    setSystemTime(new Date('2001-01-01T00:00:00Z'));
    expect(document.body.textContent).toContain('left mounted');
  });

  test('the next test starts without it', () => {
    expect(document.body.textContent).not.toContain('left mounted');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0);
    expect(new Date().getFullYear()).toBeGreaterThan(2001);
    // Real timers: a zero-delay timer fires without the clock being advanced.
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});
