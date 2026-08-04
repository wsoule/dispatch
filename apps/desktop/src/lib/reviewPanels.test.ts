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

  test('a written value round-trips', () => {
    writePanelOpen('files', false);
    expect(readPanelOpen('files')).toBe(false);
    writePanelOpen('threads', true);
    expect(readPanelOpen('threads')).toBe(true);
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
