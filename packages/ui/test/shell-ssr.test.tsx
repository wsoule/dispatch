import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// Server rendering without a DOM. The test process has happy-dom
// registered (test/setup.ts), which would hide any `window` or `document`
// read during render, so the render runs in a child process instead.

interface SsrResult {
  hasWindow: boolean;
  hasDocument: boolean;
  shell: string;
  switcher: string;
  signedOut: string;
}

function serverRender(): SsrResult {
  const entry = path.join(import.meta.dir, 'shell-ssr-entry.tsx');
  const child = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: path.join(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const out = child.stdout.toString();
  if (child.exitCode !== 0) {
    throw new Error(`server render failed:\n${child.stderr.toString()}`);
  }
  return JSON.parse(out) as SsrResult;
}

describe('shell family server render', () => {
  test('renders with no window or document', () => {
    const result = serverRender();
    expect(result.hasWindow).toBe(false);
    expect(result.hasDocument).toBe(false);
    // The frame, the open drawer and the real sign-out form are all there.
    expect(result.shell).toContain('Skip to content');
    expect(result.shell).toContain('aria-label="Primary"');
    expect(result.shell).toContain('role="dialog"');
    expect(result.shell).toContain('M3 Cutover');
    expect(result.shell).toContain('action="/api/auth/logout"');
    // The server answers "expanded" and "Ctrl"; the client corrects both
    // after hydration (pre-paint script + platform check).
    expect(result.shell).toContain('Collapse sidebar');
    expect(result.shell).toContain('(Ctrl K)');
    expect(result.signedOut).toContain('Milestone Planner');
  });

  test('the signed-out frame lists its footer links in a named landmark', () => {
    const { signedOut } = serverRender();
    expect(signedOut).toContain('<footer');
    expect(signedOut).toContain('<nav aria-label="About this site">');
    const links = [...signedOut.matchAll(/<a [^>]*href="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(links).toEqual(['#main', '/', '/privacy', '/terms', '/contact']);
  });

  test('the workspace switcher renders as a closed menu button', () => {
    const { switcher } = serverRender();
    expect(switcher).toContain(
      'aria-label="Milestone Planner Northwind, switch workspace"'
    );
    expect(switcher).toContain('aria-haspopup="dialog"');
    expect(switcher).toContain('aria-expanded="false"');
    expect(switcher).toContain('data-appearance="brand"');
    expect(switcher).toContain('data-tip="Northwind · Switch workspace"');
    // Closed: no menu rows in the markup.
    expect(switcher).not.toContain('Connect another workspace');
  });
});
