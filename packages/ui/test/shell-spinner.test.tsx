import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';

import { Spinner } from '../src/index';

afterEach(cleanup);

// Spinner: the in-flight mark for agent or network work. A named status
// (or hidden beside a visible label), four sizes, an optional tone, and
// a still arc unless motion is welcome.

describe('Spinner', () => {
  test('is a status named "Loading" by default', () => {
    render(<Spinner />);
    const status = screen.getByRole('status', { name: 'Loading' });
    expect(status.dataset.size).toBe('sm');
    expect(status.hasAttribute('data-tone')).toBe(false);
    expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });

  test('takes a label, a size and a tone', () => {
    render(<Spinner label="Starting the daemon" size="lg" tone="info" />);
    const status = screen.getByRole('status', { name: 'Starting the daemon' });
    expect(status.dataset.size).toBe('lg');
    expect(status.dataset.tone).toBe('info');
  });

  test('label="" hides it from assistive tech', () => {
    const { container } = render(
      <p>
        <Spinner label="" size="xs" /> Cloning…
      </p>
    );
    expect(screen.queryByRole('status')).toBeNull();
    const mark = container.querySelector('[data-size="xs"]');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.hasAttribute('aria-label')).toBe(false);
  });

  test('renders to a string with no DOM-only state', () => {
    const html = renderToString(<Spinner label="Drafting" size="md" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Drafting"');
    expect(html).toContain('data-size="md"');
  });
});

describe('spinner.module.css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'shell', 'spinner.module.css'),
    'utf8'
  );

  test('12, 14, 16 and 20px, in currentColor or the tone', () => {
    expect(css).toMatch(/^\.xs \{\s*width: 12px;\s*height: 12px;/m);
    expect(css).toMatch(/^\.sm \{\s*width: 14px;\s*height: 14px;/m);
    expect(css).toMatch(/^\.md \{\s*width: 16px;\s*height: 16px;/m);
    expect(css).toMatch(/^\.lg \{\s*width: 20px;\s*height: 20px;/m);
    expect(css).toMatch(/stroke: currentcolor;/);
    expect(css).toMatch(/\.spinner\[data-tone\] \{\s*color: var\(--tone\);/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test('turns only under no-preference, and keeps its stroke in forced colours', () => {
    // Every animation sits inside the no-preference block: under reduced
    // motion the arc is still.
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/,
      ''
    );
    expect(outside).not.toMatch(/animation:/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\.svg \{\s*animation: spinner-turn/
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.track,\s*\.arc \{\s*stroke: CanvasText;/
    );
  });
});
