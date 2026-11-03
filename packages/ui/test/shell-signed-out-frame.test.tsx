import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import SignedOutFrame from '../src/shell/signed-out-frame';
import type { SignedOutFrameProps } from '../src/shell/types';

afterEach(cleanup);

// SignedOutFrame: the frame for signed-out pages and a desktop host's gate
// screens (first-run setup, team sign-in). One <main> the skip link
// targets, the brand link's name, the header row as window chrome
// (chromeAttributes, --shell-brand-inset) and the order of its controls.

const PROPS: SignedOutFrameProps = {
  appName: 'Dispatch',
  brandHref: '#/',
  label: 'Setup',
};

describe('SignedOutFrame', () => {
  test('one <main>, focusable by script, which the skip link targets', () => {
    render(
      <SignedOutFrame {...PROPS} mainId="gate-main">
        <h1>Set up Dispatch</h1>
      </SignedOutFrame>
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(main.id).toBe('gate-main');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(
      within(main).getByRole('heading', { name: 'Set up Dispatch' })
    ).toBeTruthy();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#gate-main');
  });

  test('mainId defaults to "main"', () => {
    render(<SignedOutFrame {...PROPS} />);
    expect(screen.getByRole('main').id).toBe('main');
    expect(
      screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')
    ).toBe('#main');
  });

  test('the brand link is named by the product and its quiet label', () => {
    render(<SignedOutFrame {...PROPS} />);
    const brand = screen.getByRole('link', { name: 'Dispatch Setup' });
    expect(brand.getAttribute('href')).toBe('#/');
    // The initials tile is decoration; the words carry the name.
    expect(brand.querySelector('[aria-hidden="true"]')?.textContent).toBe('D');
    cleanup();
    render(<SignedOutFrame {...PROPS} label={undefined} />);
    expect(screen.getByRole('link', { name: 'Dispatch' })).toBeTruthy();
  });

  test('chromeAttributes land on the header row, not on main', () => {
    render(
      <SignedOutFrame
        {...PROPS}
        chromeAttributes={{ 'data-tauri-drag-region': '' }}
      >
        <p>Checking your team token</p>
      </SignedOutFrame>
    );
    const header = screen.getByRole('banner');
    expect(header.getAttribute('data-tauri-drag-region')).toBe('');
    expect(
      screen.getByRole('main').hasAttribute('data-tauri-drag-region')
    ).toBe(false);
    expect(document.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(
      1
    );
  });

  test('actions render before the theme toggle', () => {
    render(
      <SignedOutFrame
        {...PROPS}
        themeStorageKey="theme"
        actions={
          <button type="button" data-testid="sign-out">
            Sign out
          </button>
        }
      />
    );
    const header = screen.getByRole('banner');
    const buttons = within(header).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Sign out',
      'Switch between light and dark',
    ]);
  });

  test('without footerLinks there is no footer landmark', () => {
    render(<SignedOutFrame {...PROPS} />);
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  test('the header row reads --shell-brand-inset as extra left padding', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'shell',
        'signed-out-frame.module.css'
      ),
      'utf8'
    );
    // Desktop and phone widths: the inset adds to the row's own padding
    // and is 0 unless a host sets it (a Tauri window's traffic lights).
    // On desktop the row spans the frame and its padding keeps the
    // contents in the 1440px column, so the left side is the larger of
    // the two.
    expect(css).toMatch(
      /\.bar \{[^}]*padding-left: max\(\s*calc\(24px \+ var\(--shell-brand-inset, 0px\)\),\s*calc\(\(100% - 1440px\) \/ 2 \+ 24px\)\s*\);/
    );
    expect(css).toMatch(
      /\.bar \{[^}]*padding: 8px 12px 8px calc\(16px \+ var\(--shell-brand-inset, 0px\)\);/
    );
  });

  test('the top row stays put over the scrolling content, full width', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'shell',
        'signed-out-frame.module.css'
      ),
      'utf8'
    );
    const bar = /\.bar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(bar).toContain('position: sticky;');
    expect(bar).toContain('top: 0;');
    // Over the content's raised layers (z-index 1 and 2), as the AppShell topbar.
    expect(bar).toContain('z-index: 30;');
    expect(bar).toContain('background: var(--bg);');
    // No max-width: a drag region on it reaches the window's corners.
    expect(bar).not.toContain('max-width');
    // The skip link's target keeps the browser's :focus-visible ring.
    expect(css).not.toMatch(/outline:\s*none/);
  });
});
