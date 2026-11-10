import { describe, expect, test } from 'bun:test';

import { e2eProjects } from './playwright.config';

// The two Playwright passes of playwright.config.ts: the default Chromium
// suite every local and Linux run gets, and the WebKit pass the macOS
// workflow opts into with DISPATCH_E2E_WEBKIT=1. Checked here because a wrong
// ignore pattern does not fail a run, it just drops specs from it.

const SPEC = (name: string) => `/repo/apps/desktop/e2e/${name}`;

// Whether a project's testIgnore pattern leaves the spec file out.
function ignores(
  project: ReturnType<typeof e2eProjects>[number],
  name: string
): boolean {
  return project.testIgnore.test(SPEC(name));
}

describe('the default Chromium suite', () => {
  const projects = e2eProjects(false);

  test('keeps the dark and light projects on Playwright’s default browser', () => {
    expect(projects.map((p) => p.name)).toEqual(['dark', 'light']);
    for (const project of projects) {
      expect('browserName' in project.use).toBe(false);
    }
  });

  test('runs the screenshot and functional specs, not the webkit ones', () => {
    for (const project of projects) {
      expect(ignores(project, 'views.spec.ts')).toBe(false);
      expect(ignores(project, 'shell.spec.ts')).toBe(false);
      expect(ignores(project, 'webkit-views.spec.ts')).toBe(true);
    }
  });
});

describe('the WebKit pass', () => {
  const projects = e2eProjects(true);

  // The theme-independent flows skip every project not named `dark`.
  test('keeps the project names the specs skip on, in WebKit', () => {
    expect(projects.map((p) => p.name)).toEqual(['dark', 'light']);
    expect(projects.map((p) => p.use.colorScheme)).toEqual(['dark', 'light']);
    for (const project of projects) {
      expect(project.use).toMatchObject({ browserName: 'webkit' });
    }
  });

  // `webkit-views.spec.ts` ends in `views.spec.ts`: an unanchored pattern
  // once left the pass with no webkit spec at all.
  test('drops the Chromium screenshot spec and keeps the webkit one', () => {
    for (const project of projects) {
      expect(ignores(project, 'views.spec.ts')).toBe(true);
      expect(ignores(project, 'webkit-views.spec.ts')).toBe(false);
      expect(ignores(project, 'shell.spec.ts')).toBe(false);
    }
  });
});
