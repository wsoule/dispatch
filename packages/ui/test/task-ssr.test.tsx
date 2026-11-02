import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// Server rendering of the task family without a DOM. The test process has
// happy-dom registered (test/setup.ts), which would hide any `window` or
// `document` read during render, so the render runs in a child process.

interface SsrResult {
  hasWindow: boolean;
  hasDocument: boolean;
  page: string;
  drawer: string;
  issueList: string;
  windowedList: string;
  disclosures: string;
  primitives: string;
}

function serverRender(): SsrResult {
  const entry = path.join(import.meta.dir, 'task-ssr-entry.tsx');
  const child = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: path.join(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (child.exitCode !== 0) {
    throw new Error(`server render failed:\n${child.stderr.toString()}`);
  }
  return JSON.parse(child.stdout.toString()) as SsrResult;
}

describe('task family server render', () => {
  const result = serverRender();

  test('renders with no window or document', () => {
    expect(result.hasWindow).toBe(false);
    expect(result.hasDocument).toBe(false);
  });

  test('the page layout carries every section, the description as text', () => {
    const html = result.page;
    expect(html).toContain('data-layout="page"');
    expect(html).toContain('Search analytics events');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('Stalled');
    expect(html).toContain('Ana Moreno');
    expect(html).toContain('Typo tolerance');
    expect(html).toContain('Flagged as stalled');
    // Escaped, never markup.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    // The long text is clamped on the server already (the first guess).
    expect(html).toContain('data-clamped="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show more');
  });

  test('the slide-over renders open with the task inside', () => {
    const html = result.drawer;
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Search analytics events');
    expect(html).toContain('data-layout="drawer"');
    expect(html).toContain('Typo tolerance');
  });

  test('the issue list parts render, with no grip draggable before hydration', () => {
    const html = result.issueList;
    expect(html).toContain('aria-label="Search issues"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Remove status filter');
    expect(html).toContain('Select ENG-12');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('Moving to Dual-write…');
    expect(html).toContain('title="Atlas › Dual-write"');
    expect(html).toContain('Missing: done means…');
    expect(html).toContain('Showing 1 of 212');
    expect(html).toContain('212 issues');
    expect(html).toContain('Group menu');
    expect(html).toContain('data-appearance="cell"');
    expect(html).toContain('Move 24 issues to Atlas › Dual-write?');
    // Media queries read false on the server: drag turns on after
    // hydration on a fine pointer, so the markup has no draggable grip.
    expect(html).not.toContain('draggable');
    // No popover is open on the server.
    expect(html).not.toContain('role="listbox"');
  });

  test('a list over the windowing threshold renders its first rows and estimated gaps', () => {
    const html = result.windowedList;
    // The first 60 rows of the first group are drawn, with their place.
    expect(html).toContain('Row 0-0');
    expect(html).toContain('Row 0-59');
    expect(html).not.toContain('Row 0-60');
    expect(html).toContain('aria-posinset="1"');
    expect(html).toContain('aria-setsize="100"');
    // The rest stand as gaps of the default row height (55px).
    expect(html).toContain('data-row-gap="40"');
    expect(html).toContain('height:2200px');
    expect(html).toContain('data-row-gap="100"');
    expect(html).toContain('height:5500px');
    expect(html).not.toContain('Row 1-0<');
    expect(html).not.toContain('Row 2-0<');
    // Every group header is there.
    expect(html).toContain('aria-label="Group 2"');
  });

  test('disclosures render closed, open, kept and with a host trigger', () => {
    const html = result.disclosures;
    // Closed: the wiring and the hidden panel, no content.
    expect(html).toContain('aria-expanded="false" aria-controls="fold-closed"');
    expect(html).toContain('<div id="fold-closed" hidden=""');
    expect(html).not.toContain('never on the server');
    // Open from the first render, with the host's hook and no motion.
    expect(html).toContain('data-testid="setup-fold"');
    expect(html).toContain('data-open="true" data-variant="bar"');
    expect(html).toContain('aria-expanded="true" aria-controls="fold-open"');
    expect(html).toContain('Hide steps');
    expect(html).toContain('Install the CLI');
    expect(html).not.toContain('data-motion');
    // keepMounted: hidden, content in the markup.
    expect(html).toMatch(
      /<div id="fold-kept" hidden=""[^>]*><p>Kept while closed/
    );
    // A host's trigger, wired.
    expect(html).toMatch(
      /<button aria-expanded="false" aria-controls="fold-chip" type="button" class="chip">\+3 more<\/button>/
    );
  });

  test('the Settings primitives render with their hooks and no client state', () => {
    const html = result.primitives;
    // SearchField: the named search box with its clear button.
    expect(html).toContain('data-testid="settings-search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Clear search"');
    // CopyValue: the hook on the code element, idle.
    expect(html).toMatch(/<code data-testid="issued-token"[^>]*>dsp_tok_123</);
    expect(html).toContain('aria-label="Copy token"');
    expect(html).toContain('data-state="idle"');
    // NavTabs groups.
    expect(html).toContain('role="group" aria-label="Project"');
    expect(html).toContain('aria-current="page"');
    // ChipButton as a toggle and as a link.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('href="/runs"');
    // The passthrough hooks.
    for (const id of [
      'failed-chip',
      'live-switch',
      'viewed-box',
      'read-only',
      'spend',
      'spend-row',
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('role="note"');
    expect(html).toContain('data-slot="cost"');
  });
});
