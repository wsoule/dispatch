import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// Server rendering of the controls family without a DOM, in a child
// process (the test process has happy-dom registered).

interface SsrResult {
  hasWindow: boolean;
  hasDocument: boolean;
  html: string;
}

function serverRender(): SsrResult {
  const entry = path.join(import.meta.dir, 'controls-ssr-entry.tsx');
  const child = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: path.join(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (child.exitCode !== 0) {
    throw new Error(`server render failed:\n${child.stderr.toString()}`);
  }
  return JSON.parse(child.stdout.toString()) as SsrResult;
}

describe('controls family server render', () => {
  const result = serverRender();

  test('renders with no window or document', () => {
    expect(result.hasWindow).toBe(false);
    expect(result.hasDocument).toBe(false);
  });

  test('every control renders closed', () => {
    const html = result.html;
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Tier: Admin"');
    expect(html).toContain('aria-haspopup="menu"');
    // Select's trigger: a PickerPopover opens a dialog.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  test('a cards group renders its badge, hint, aside and the checked option’s children', () => {
    const html = result.html;
    expect(html).toMatch(
      /<div data-testid="answer" role="radiogroup" aria-label="Answer"[^>]*data-variant="cards"/
    );
    expect(html).toContain('name="answer"');
    // The badge inside the label, after a space; the hint and the aside
    // after it, outside.
    expect(html).toMatch(
      /Approve once(<!-- -->)? <span><span>Recommended<\/span><\/span><\/span><\/label>/
    );
    expect(html).toMatch(
      /<\/label><span id="[^"]+">Ends with the run<\/span><\/div><div><button[^>]*><span>Edit scope/
    );
    // Only the checked option reveals its children.
    expect(html).toContain('Reason box');
    expect(html).not.toContain('Never shown');
  });
  test('a tooltip-hint group renders the hint hidden, no tip and the sm size', () => {
    const html = result.html;
    expect(html).toMatch(
      /<div data-testid="verdict" role="radiogroup" aria-label="Verdict"[^>]*data-size="sm"/
    );
    // The default size is md.
    expect(html).toMatch(/aria-label="Scope"[^>]*data-size="md"/);
    // The radio is described by the hidden copy, outside its label.
    const described =
      /aria-describedby="([^"]+)"[^>]*value="comment"|value="comment"[^>]*aria-describedby="([^"]+)"/.exec(
        html
      );
    const hintId = described?.[1] ?? described?.[2] ?? 'none';
    expect(html).toContain(
      `</label><span id="${hintId}" class="srOnly">Feedback only; the run stays open</span>`
    );
    // No tip on the server (it shows on hover or focus only), and no
    // extra tab stop around the label.
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain('tabindex');
  });
});
