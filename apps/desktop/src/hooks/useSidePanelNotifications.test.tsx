import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { useSidePanelNotifications } from './useSidePanelNotifications';

afterEach(() => window.localStorage.clear());

test('notifications show in the side panel until someone hides them', () => {
  const { result } = renderHook(() => useSidePanelNotifications());
  expect(result.current[0]).toBe(true);
  act(() => result.current[1](false));
  expect(result.current[0]).toBe(false);
  act(() => result.current[1](true));
  expect(result.current[0]).toBe(true);
});

test('hiding in one place updates every mounted reader', () => {
  const panel = renderHook(() => useSidePanelNotifications());
  const settings = renderHook(() => useSidePanelNotifications());
  act(() => settings.result.current[1](false));
  expect(panel.result.current[0]).toBe(false);
  // A fresh mount (the next launch) reads the stored choice.
  expect(renderHook(() => useSidePanelNotifications()).result.current[0]).toBe(
    false
  );
});
