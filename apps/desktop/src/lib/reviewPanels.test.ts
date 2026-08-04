import { beforeEach, describe, expect, test } from 'bun:test';

import { readPanelOpen, writePanelOpen } from './reviewPanels';

// happy-dom is preloaded (see test-setup.ts), so `window.localStorage` is real
// here — unlike `reviewViewed.test.ts`, which predates that and stubs it.
beforeEach(() => window.localStorage.clear());

describe('review panel state', () => {
  test('files default open, threads default closed', () => {
    expect(readPanelOpen('files')).toBe(true);
    expect(readPanelOpen('threads')).toBe(false);
  });

  // The PR rail is the only place a PR can be approved, so a reviewer who has
  // never touched a panel toggle must still land on it.
  test('the PR review rail defaults open', () => {
    expect(readPanelOpen('review')).toBe(true);
  });

  // The rails are separate keys precisely so a run review's closed thread list
  // cannot hide a PR's only review affordance.
  test('closing the thread list leaves the PR rail open', () => {
    writePanelOpen('threads', false);
    expect(readPanelOpen('review')).toBe(true);
  });

  test('a written value round-trips', () => {
    writePanelOpen('files', false);
    expect(readPanelOpen('files')).toBe(false);
    writePanelOpen('threads', true);
    expect(readPanelOpen('threads')).toBe(true);
    writePanelOpen('review', false);
    expect(readPanelOpen('review')).toBe(false);
  });

  test('the panels are stored independently', () => {
    writePanelOpen('threads', true);
    expect(readPanelOpen('files')).toBe(true);
    expect(readPanelOpen('threads')).toBe(true);
  });

  test('an unreadable value falls back to the default', () => {
    window.localStorage.setItem('dispatch:review-panel:files', 'nonsense');
    expect(readPanelOpen('files')).toBe(true);
  });
});
