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
  controlsToolbar: string;
  windowedList: string;
  disclosures: string;
  primitives: string;
  board: string;
  lists: string;
  codeBlocks: string;
  checkboxChecklist: string;
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

  test('a toolbar of controls only renders no search field', () => {
    const html = result.controlsToolbar;
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Run filters"');
    expect(html).toContain('All runs');
    expect(html).toContain('Show archived (2)');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('aria-busy');
    // The end actions are the bar's own cell after the controls, not inside
    // their scroller.
    expect(html).toMatch(
      /All runs<\/button><\/div><div[^>]*><button type="button">Show archived \(2\)/
    );
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
    // A cell that spans the row holds block content in a block value.
    expect(html).toMatch(
      /<div data-slot="spend-note" class="[^"]*" data-tone="default" data-span="row"><div[^>]*><p>Over budget<\/p><\/div><\/div>/
    );
    // Register's small container step.
    expect(html).toContain('data-stack="container-600"');
    // A segmented option's count is read after its label with a separator.
    expect(html).toContain('aria-label="Live, 2"');
  });

  test('the board parts render: section header, progress pie, label chips, a mark picker', () => {
    const html = result.board;
    // SectionHeader: the host hook and the state on the root, the count
    // inside the heading, the fold chevron and the + named.
    expect(html).toMatch(
      /<div data-slot="group-header" class="[^"]*" data-tone="info" data-collapsed="true">/
    );
    expect(html).toMatch(
      /<h3[^>]*><span[^>]*data-part="name">In progress<\/span> <span[^>]*data-part="count">4<\/span><\/h3>/
    );
    expect(html).toContain('aria-label="Expand group"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="New task in In progress"');
    expect(html).toContain('data-testid="lane-menu"');
    // ProgressPie: named, then decorative, with no NaN.
    expect(html).toContain('role="img" aria-label="3 of 8 done"');
    expect(html).toContain('data-tone="success"');
    expect(html).not.toContain('NaN');
    expect(html).toMatch(/<svg[^>]*width="14"[^>]*aria-hidden="true"/);
    // Chips: the colour square and the hue dot.
    expect(html).toContain('data-mark="swatch"');
    expect(html).toContain('background-color:#e5484d');
    expect(html).toContain('data-hue="violet"');
    // The mark picker: no words in the trigger, named by its value.
    expect(html).toMatch(
      /<button[^>]*aria-label="Status: In Progress"[^>]*data-appearance="mark"[^>]*><span[^>]*><span[^>]*><svg/
    );
  });

  test('the list parts render: list items, a panel with its rows, a removable chip', () => {
    const html = result.lists;
    // ListItem: the slot hooks in reading order, the state on the root,
    // the unread word, the connector and the crumb.
    expect(html).toMatch(
      /<div data-testid="overseer-notification-row" data-slot="list-item" data-unread="true" data-indent="1" data-clickable="true" role="listitem" tabindex="0"/
    );
    expect(html).toContain('<span class="srOnly">Unread, </span>');
    expect(html).toContain(
      'data-slot="list-item-connector" aria-hidden="true"'
    );
    expect(html).toContain(' › <!-- -->Overseer');
    const order = [...html.matchAll(/data-slot="(list-item-[a-z]+)"/g)].map(
      (m) => m[1]
    );
    expect(order.slice(0, 6)).toEqual([
      'list-item-connector',
      'list-item-unread',
      'list-item-title',
      'list-item-crumb',
      'list-item-meta',
      'list-item-date',
    ]);
    // An option says it is selected; its id is the host's.
    expect(html).toMatch(
      /data-selected="true"[^>]*id="thread-7" role="option" aria-selected="true"/
    );
    // A button row with a trailing control: the wrapper holds the button
    // and the control beside it, never inside.
    expect(html).toMatch(
      /<div data-testid="overseer-docked" data-slot="list-item"[^>]*><button[^>]*type="button"[^>]*>.*?<\/button><span[^>]*data-slot="list-item-trailing"><span data-testid="docked-count">2<\/span><\/span><\/div>/
    );
    // Panel: the hook, the tone and floating on the root, the heading row.
    expect(html).toMatch(
      /<section data-testid="overseer-inflow" class="[^"]*" data-tone="warning" data-floating="true">/
    );
    expect(html).toContain('>Coming in</h3>');
    expect(html).toMatch(/data-part="count">2<\/span>/);
    expect(html).toContain('data-testid="panel-actions"');
    expect(html).toContain('data-part="body" data-flush="true"');
    // PanelRow: urgent and clickable, the visible word or the sr-only one.
    expect(html).toMatch(
      /data-tone="warning" data-urgent="true" role="button" tabindex="0"><span[^>]*data-part="urgent">Failed<\/span>Build the docs/
    );
    expect(html).toContain(
      '<span class="srOnly" data-part="urgent">Urgent, </span>Merge the fix'
    );
    // The removable chip: still a span, its one button named.
    expect(html).toMatch(
      /<span[^>]*data-tone="default"><span[^>]*>boot.rs<\/span><button type="button"[^>]*aria-label="Remove boot.rs" data-chip-remove="">/
    );
  });
  test('code blocks render their lines, header and caps with no client state', () => {
    const html = result.codeBlocks;
    // The host hook and the slot on the root; the cap on the body; the
    // blank line as a space; no final blank line.
    expect(html).toMatch(/<div data-testid="fence" data-slot="code-block"/);
    expect(html).toContain('style="max-height:240px"');
    expect(html).toMatch(
      /<pre[^>]*><code[^>]*><span[^>]*>const a = 1;\n<\/span><span[^>]*> \n<\/span><span[^>]*>const b = 2;<\/span><\/code><\/pre>/
    );
    // The header: filename (with its title), the language label, Copy.
    expect(html).toContain('title="src/app.ts"');
    expect(html).toContain('>TypeScript</span>');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('aria-live="polite"');
    // The wrapped block: data-wrap, and no header, button or live region.
    expect(html).toMatch(
      /<div data-slot="code-block" class="[^"]*" data-wrap="true"><pre/
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    // Nothing is measured on the server: no tab stop on a body.
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('data-scrollable');
  });

  test('a checklist with onToggle renders its rows as checkboxes, met ones checked', () => {
    const html = result.checkboxChecklist;
    expect(html).toMatch(/^<ul[^>]* aria-label="Review checklist">/);
    // One li per item with data-met, each holding the Checkbox's label.
    expect(html.match(/<li[^>]* data-met="(true|false)"><label/g)).toHaveLength(
      2
    );
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes('type="checkbox"'))).toBe(
      true
    );
    // Controlled by met: the met item is checked, the other is not.
    expect(inputs[0]).toContain('checked=""');
    expect(inputs[1]).not.toContain('checked');
    expect(html).toContain('Events are hashed');
    expect(html).toContain('Sampling is configurable');
    // No rubric state column in this mode.
    expect(html).not.toContain('Missing');
    expect(html).not.toContain('>Met<');
  });
});
