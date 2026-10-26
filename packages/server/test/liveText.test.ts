import { describe, expect, it } from 'bun:test';

import { LiveTextBuffer } from '../src/liveText.js';

describe('LiveTextBuffer', () => {
  it('appends to segments in order and counts every frame', () => {
    const live = new LiveTextBuffer();
    const turn = live.begin('wc-1');
    expect(live.append('wc-1', turn, 'a', 'Check')).toBe(1);
    expect(live.append('wc-1', turn, 'a', 'ing.')).toBe(2);
    expect(live.append('wc-1', turn, 'b', 'Done')).toBe(3);
    expect(live.snapshot('wc-1')).toEqual({
      seq: 3,
      turnId: turn,
      segments: [
        { id: 'a', text: 'Checking.' },
        { id: 'b', text: 'Done' },
      ],
    });
  });

  it('keeps seq across turns, with a new turn id and no segments', () => {
    const live = new LiveTextBuffer();
    const first = live.begin('wc-1');
    live.append('wc-1', first, 'a', 'one');
    expect(live.end('wc-1', first)).toEqual([{ id: 'a', text: 'one' }]);
    expect(live.snapshot('wc-1')).toBeUndefined();
    const second = live.begin('wc-1');
    expect(second).not.toBe(first);
    expect(live.snapshot('wc-1')).toEqual({
      seq: 1,
      turnId: second,
      segments: [],
    });
    expect(live.append('wc-1', second, 'a', 'two')).toBe(2);
  });

  it('ignores writes from a turn that is not the running one', () => {
    const live = new LiveTextBuffer();
    const first = live.begin('wc-1');
    live.end('wc-1', first);
    expect(live.append('wc-1', first, 'a', 'late')).toBeUndefined();
    const second = live.begin('wc-1');
    expect(live.append('wc-1', first, 'a', 'late')).toBeUndefined();
    expect(live.isRunning('wc-1', first)).toBe(false);
    expect(live.isRunning('wc-1', second)).toBe(true);
    expect(live.end('wc-1', first)).toEqual([]);
    expect(live.snapshot('wc-1')?.segments).toEqual([]);
  });

  it('drops a committed segment and keeps conversations apart', () => {
    const live = new LiveTextBuffer();
    const one = live.begin('wc-1');
    const two = live.begin('wc-2');
    live.append('wc-1', one, 'a', 'narrated');
    live.append('wc-1', one, 'b', 'still live');
    live.append('wc-2', two, 'a', 'elsewhere');
    live.drop('wc-1', one, 'a');
    expect(live.snapshot('wc-1')?.segments).toEqual([
      { id: 'b', text: 'still live' },
    ]);
    expect(live.snapshot('wc-2')).toMatchObject({ seq: 1 });
  });
});

describe('LiveTextBuffer.forget', () => {
  it('drops a key for good, ending its turn and its seq', () => {
    const live = new LiveTextBuffer();
    const turn = live.begin('r-1');
    live.append('r-1', turn, 'a', 'half');
    live.forget('r-1');
    expect(live.snapshot('r-1')).toBeUndefined();
    expect(live.isRunning('r-1', turn)).toBe(false);
    expect(live.append('r-1', turn, 'a', 'late')).toBeUndefined();
    // A key begun again starts counting over: forget is for keys that are done.
    const again = live.begin('r-1');
    expect(live.append('r-1', again, 'a', 'x')).toBe(1);
  });
});
