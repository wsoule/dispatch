import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// Server rendering of the edit family without a DOM, in a child process
// (the test process has happy-dom registered, which would hide any window
// or document read during render).

interface SsrResult {
  hasWindow: boolean;
  hasDocument: boolean;
  controls: string;
  detail: string;
}

function serverRender(): SsrResult {
  const entry = path.join(import.meta.dir, 'edit-ssr-entry.tsx');
  const child = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: path.join(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (child.exitCode !== 0) {
    throw new Error(`server render failed:\n${child.stderr.toString()}`);
  }
  return JSON.parse(child.stdout.toString()) as SsrResult;
}

describe('edit family server render', () => {
  const result = serverRender();

  test('renders with no window or document', () => {
    expect(result.hasWindow).toBe(false);
    expect(result.hasDocument).toBe(false);
  });

  test('every picker renders closed, named by property and value', () => {
    const html = result.controls;
    expect(html).toContain('aria-label="Status: In Progress"');
    expect(html).toContain('aria-label="Assignee: Unassigned"');
    expect(html).toContain('aria-label="Priority: High"');
    expect(html).toContain('aria-label="Labels: Bug, Evil"');
    expect(html).toContain('aria-label="Project: Beacon search"');
    expect(html).toContain('aria-label="Milestone: No milestone"');
    expect(html).toContain('aria-label="Estimate: 3 points"');
    expect(html).toContain('aria-label="Add blocked by"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('popover=');
  });

  test('only a hex label colour reaches a style attribute', () => {
    const html = result.controls;
    expect(html).toContain('style="background-color:#eb5757"');
    expect(html).not.toContain('url(x)');
  });

  test('text controls render as text, never markup', () => {
    const html = result.controls;
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-10-23"');
    expect(html).toContain('Line &lt;b&gt;one&lt;/b&gt;');
    expect(html).toContain('aria-label="Edit Description"');
    expect(html).toContain('aria-label="Comment"');
    expect(html).toContain('<textarea');
    // The shortcut renders the server's guess; the client corrects it.
    expect(html).toContain('Ctrl');
  });

  test('the task view renders the title field, the section picker and comments', () => {
    const html = result.detail;
    expect(html).toContain('data-inline-text=""');
    expect(html).toContain('Search analytics events');
    expect(html).toContain('aria-label="Add blocked by"');
    expect(html).toContain('&lt;i&gt;hi&lt;/i&gt;');
    expect(html).toContain('aria-label="Comments"');
  });
});
