import { describe, expect, test } from 'bun:test';

import type { CockpitLaneId } from './cockpit';
import {
  CHORD_WINDOW_MS,
  moveCockpitCursor,
  resolveCockpitKey,
} from './cockpitKeys';

const key = (k: string, at = 1000) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  at,
});

describe('resolveCockpitKey', () => {
  test('maps the single keys', () => {
    expect(resolveCockpitKey(key('j'), null).command).toBe('down');
    expect(resolveCockpitKey(key('ArrowUp'), null).command).toBe('up');
    expect(resolveCockpitKey(key('l'), null).command).toBe('right');
    expect(resolveCockpitKey(key('Enter'), null).command).toBe('open-split');
    expect(resolveCockpitKey(key('o'), null).command).toBe('open-full');
    expect(resolveCockpitKey(key(' '), null).command).toBe('peek');
    expect(resolveCockpitKey(key('d'), null).command).toBe('dispatch');
    expect(resolveCockpitKey(key('t'), null).command).toBe('toggle-team');
    expect(resolveCockpitKey(key('Escape'), null).command).toBe('close');
    expect(resolveCockpitKey(key('z'), null).command).toBeNull();
  });

  test('g arms the chord and g p is the roster', () => {
    const armed = resolveCockpitKey(key('g', 1000), null);
    expect(armed).toEqual({ command: null, gArmedAt: 1000 });
    expect(resolveCockpitKey(key('p', 1200), armed.gArmedAt)).toEqual({
      command: 'roster',
      gArmedAt: null,
    });
  });

  test('another chord second key is left to the shell, never a Cockpit key', () => {
    // `g t` is the shell's Tasks, not the Cockpit's team toggle.
    expect(resolveCockpitKey(key('t', 1100), 1000).command).toBeNull();
  });

  test('the chord expires after its window', () => {
    expect(
      resolveCockpitKey(key('p', 1000 + CHORD_WINDOW_MS + 1), 1000).command
    ).toBeNull();
  });

  test('a modified key is never the Cockpit’s', () => {
    expect(
      resolveCockpitKey({ ...key('j'), metaKey: true }, null).command
    ).toBeNull();
  });
});

describe('moveCockpitCursor', () => {
  const lanes: Record<CockpitLaneId, string[]> = {
    ready: ['r1', 'r2', 'r3'],
    flight: [],
    needs: ['n1', 'n2'],
  };

  test('j/k step within the lane and clamp', () => {
    expect(
      moveCockpitCursor(lanes, { lane: 'ready', key: 'r1' }, 'down')
    ).toEqual({ lane: 'ready', key: 'r2' });
    expect(
      moveCockpitCursor(lanes, { lane: 'ready', key: 'r3' }, 'down')
    ).toEqual({ lane: 'ready', key: 'r3' });
    expect(
      moveCockpitCursor(lanes, { lane: 'ready', key: 'r1' }, 'up')
    ).toEqual({ lane: 'ready', key: 'r1' });
  });

  test('h/l hop over an empty lane and keep the position down the lane', () => {
    expect(
      moveCockpitCursor(lanes, { lane: 'ready', key: 'r3' }, 'right')
    ).toEqual({ lane: 'needs', key: 'n2' });
    expect(
      moveCockpitCursor(lanes, { lane: 'needs', key: 'n1' }, 'left')
    ).toEqual({ lane: 'ready', key: 'r1' });
  });

  test('no lane further along leaves the cursor where it is', () => {
    const at = { lane: 'needs' as const, key: 'n1' };
    expect(moveCockpitCursor(lanes, at, 'right')).toBe(at);
  });
});
