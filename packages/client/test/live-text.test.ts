import { describe, expect, it } from 'bun:test';

import type { LiveText } from '../src/api';
import {
  applyDelta,
  dropSegment,
  type LiveFrame,
  type LiveTextState,
  LiveTextStore,
  mergeSnapshot,
} from '../src/liveText';

function frame(
  seq: number,
  text: string,
  segmentId = 'a',
  turnId = 't1'
): LiveFrame {
  return { turnId, seq, segmentId, text };
}

// Folds frames one after another, collecting every repair request.
function fold(
  frames: LiveFrame[],
  from?: LiveTextState
): { state: LiveTextState | undefined; repairs: number } {
  let state = from;
  let repairs = 0;
  for (const f of frames) {
    const step = applyDelta(state, f);
    state = step.state;
    if (step.repair) repairs += 1;
  }
  return { state, repairs };
}

function snapshot(
  seq: number,
  segments: LiveText['segments'],
  turnId = 't1'
): LiveText {
  return { seq, turnId, segments };
}

describe('applyDelta', () => {
  it('appends each frame that follows on, by segment', () => {
    const { state, repairs } = fold([
      frame(1, 'Check'),
      frame(2, 'ing.'),
      frame(3, 'Done', 'b'),
    ]);
    expect(repairs).toBe(0);
    expect(state).toEqual({
      turnId: 't1',
      seq: 3,
      segments: [
        { id: 'a', text: 'Checking.' },
        { id: 'b', text: 'Done' },
      ],
      stale: false,
      held: [],
    });
  });

  it('ignores a frame it already has, keeping the same state', () => {
    const { state } = fold([frame(1, 'one'), frame(2, 'two')]);
    const step = applyDelta(state, frame(2, 'two'));
    expect(step.state).toBe(state);
    expect(step.repair).toBe(false);
    expect(applyDelta(state, frame(1, 'one')).state).toBe(state);
  });

  it('starts a new turn empty when its first frame follows on', () => {
    const { state } = fold([
      frame(1, 'old reply'),
      frame(2, 'New', 'a', 't2'),
      frame(3, ' turn', 'a', 't2'),
    ]);
    expect(state).toMatchObject({
      turnId: 't2',
      seq: 3,
      segments: [{ id: 'a', text: 'New turn' }],
    });
  });

  it('holds frames past a gap and asks for one repair per gap', () => {
    const { state, repairs } = fold([
      frame(1, 'a'),
      frame(3, 'c'),
      frame(5, 'e'),
      frame(4, 'd'),
      frame(4, 'd'),
    ]);
    expect(repairs).toBe(1);
    expect(state?.stale).toBe(true);
    expect(state?.seq).toBe(1);
    expect(state?.segments).toEqual([{ id: 'a', text: 'a' }]);
    expect(state?.held.map((f) => f.seq)).toEqual([3, 4, 5]);
  });

  it('places only the very first frame without a snapshot', () => {
    expect(applyDelta(undefined, frame(1, 'Hi'))).toEqual({
      state: {
        turnId: 't1',
        seq: 1,
        segments: [{ id: 'a', text: 'Hi' }],
        stale: false,
        held: [],
      },
      repair: false,
    });
    // A window that joins mid-turn has missed what came before.
    const joined = applyDelta(undefined, frame(7, 'tail'));
    expect(joined.repair).toBe(true);
    expect(joined.state).toMatchObject({
      turnId: null,
      stale: true,
      segments: [],
    });
  });
});

describe('an abandoned segment', () => {
  // The model's stream broke off mid-block: no row will replace the text.
  it('leaves the segments and is remembered for the rest of its turn', () => {
    const { state } = fold([
      frame(1, 'Half a sen'),
      { ...frame(2, ''), abandoned: true },
      frame(3, 'Whole.', 'b'),
    ]);
    expect(state?.segments).toEqual([{ id: 'b', text: 'Whole.' }]);
    expect(state?.abandoned).toEqual(['a']);

    // A snapshot of the same turn no longer has it, and keeps the record of it.
    const merged = mergeSnapshot(state, snapshot(4, [])).state;
    expect(merged?.abandoned).toEqual(['a']);
    // A new turn starts with none.
    const next = applyDelta(merged, frame(5, 'New', 'a', 't2')).state;
    expect(next?.abandoned).toBeUndefined();
  });
});

describe('dropSegment', () => {
  it('removes a committed segment, keeping seq, and leaves anything else alone', () => {
    const { state } = fold([frame(1, 'One'), frame(2, 'Two', 'b')]);
    const dropped = dropSegment(state, 'a').state;
    expect(dropped?.segments).toEqual([{ id: 'b', text: 'Two' }]);
    expect(dropped?.seq).toBe(2);
    expect(dropSegment(dropped, 'a').state).toBe(dropped);
    expect(dropSegment(undefined, 'a').state).toBeUndefined();
  });
});

describe('mergeSnapshot', () => {
  it('takes a newer snapshot and replays the held frames past it', () => {
    const { state } = fold([frame(1, 'a'), frame(4, 'd'), frame(5, 'e')]);
    const step = mergeSnapshot(state, snapshot(3, [{ id: 'a', text: 'abc' }]));
    expect(step.repair).toBe(false);
    expect(step.state).toEqual({
      turnId: 't1',
      seq: 5,
      segments: [{ id: 'a', text: 'abcde' }],
      stale: false,
      held: [],
    });
  });

  it('drops held frames the snapshot already covers', () => {
    const { state } = fold([frame(1, 'a'), frame(3, 'c')]);
    const step = mergeSnapshot(state, snapshot(4, [{ id: 'a', text: 'abcd' }]));
    expect(step.state).toMatchObject({
      seq: 4,
      segments: [{ id: 'a', text: 'abcd' }],
      stale: false,
      held: [],
    });
  });

  it('keeps local text newer than the snapshot', () => {
    const { state } = fold([frame(1, 'a'), frame(2, 'b'), frame(3, 'c')]);
    const step = mergeSnapshot(state, snapshot(2, [{ id: 'a', text: 'ab' }]));
    expect(step.repair).toBe(false);
    expect(step.state).toMatchObject({
      seq: 3,
      segments: [{ id: 'a', text: 'abc' }],
      stale: false,
    });
  });

  it('stays stale and asks once more when the snapshot leaves a gap', () => {
    const { state } = fold([frame(1, 'a'), frame(5, 'e')]);
    const step = mergeSnapshot(state, snapshot(3, [{ id: 'a', text: 'abc' }]));
    expect(step.repair).toBe(true);
    expect(step.state).toMatchObject({
      seq: 3,
      segments: [{ id: 'a', text: 'abc' }],
      stale: true,
    });
    expect(step.state?.held.map((f) => f.seq)).toEqual([5]);
    // The next snapshot closes it.
    const closed = mergeSnapshot(
      step.state,
      snapshot(4, [{ id: 'a', text: 'abcd' }])
    );
    expect(closed).toMatchObject({
      repair: false,
      state: { seq: 5, stale: false, segments: [{ id: 'a', text: 'abcde' }] },
    });
  });

  it('anchors a key that joined mid-turn, whatever the snapshot seq', () => {
    const joined = applyDelta(undefined, frame(8, 'h'));
    const step = mergeSnapshot(
      joined.state,
      snapshot(7, [{ id: 'a', text: 'abcdefg' }])
    );
    expect(step).toMatchObject({
      repair: false,
      state: {
        seq: 8,
        stale: false,
        segments: [{ id: 'a', text: 'abcdefgh' }],
      },
    });
  });

  it('takes a newer turn from the snapshot', () => {
    const { state } = fold([frame(1, 'old')]);
    const step = mergeSnapshot(state, snapshot(4, [], 't2'));
    expect(step.state).toMatchObject({ turnId: 't2', seq: 4, segments: [] });
  });

  it('clears the text when the record has no live turn', () => {
    const { state } = fold([frame(1, 'a'), frame(3, 'c')]);
    expect(mergeSnapshot(state, undefined)).toEqual({
      state: {
        turnId: 't1',
        seq: 1,
        segments: [],
        stale: false,
        held: [],
      },
      repair: false,
    });
    expect(mergeSnapshot(undefined, undefined)).toEqual({
      state: undefined,
      repair: false,
    });
    // Already clear: the same state, so nothing re-renders.
    const cleared = mergeSnapshot(state, undefined).state;
    expect(mergeSnapshot(cleared, undefined).state).toBe(cleared);
  });
});

// A store whose frames the test paints by hand: `paint` runs the flush the
// store asked for (if it asked), and `asked` counts how often it asked.
function storeWithFrames() {
  const waiting: (() => void)[] = [];
  let asked = 0;
  const store = new LiveTextStore((flush) => {
    asked += 1;
    waiting.push(flush);
  });
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  return {
    store,
    unsubscribe,
    paint: () => {
      for (const flush of waiting.splice(0)) flush();
    },
    asked: () => asked,
    notified: () => notified,
  };
}

describe('LiveTextStore', () => {
  it('keeps keys and daemons apart, notifies, and runs the repair it was handed', () => {
    const { store, unsubscribe, paint, notified } = storeWithFrames();
    let repairs = 0;
    const repair = () => {
      repairs += 1;
    };
    store.applyDelta(1, 'overseer:a', frame(1, 'one'), repair);
    store.applyDelta(2, 'overseer:a', frame(1, 'two'), repair);
    store.applyDelta(1, 'overseer:b', frame(4, 'gap'), repair);
    expect(store.get(1, 'overseer:a')?.segments).toEqual([
      { id: 'a', text: 'one' },
    ]);
    expect(store.get(2, 'overseer:a')?.segments).toEqual([
      { id: 'a', text: 'two' },
    ]);
    // The repair runs at once; the listeners hear of all three at the frame.
    expect(repairs).toBe(1);
    expect(notified()).toBe(0);
    paint();
    expect(notified()).toBe(1);

    // A duplicate changes nothing, so nothing re-renders.
    const before = store.get(1, 'overseer:a');
    store.applyDelta(1, 'overseer:a', frame(1, 'one'), repair);
    paint();
    expect(store.get(1, 'overseer:a')).toBe(before);
    expect(notified()).toBe(1);

    // A daemon's hello forgets that daemon only.
    store.reset(1);
    expect(store.get(1, 'overseer:a')).toBeUndefined();
    expect(store.get(1, 'overseer:b')).toBeUndefined();
    expect(store.get(2, 'overseer:a')).toBeDefined();
    paint();
    expect(notified()).toBe(2);
    unsubscribe();
    store.reset(2);
    paint();
    expect(notified()).toBe(2);
  });

  it('forgets one key and drops one segment, notifying only on a change', () => {
    const { store, paint, asked, notified } = storeWithFrames();
    store.applyDelta(1, 'run:a', frame(1, 'one'), () => {});
    store.applyDelta(1, 'run:b', frame(1, 'two'), () => {});
    paint();
    store.drop(1, 'run:a', 'a');
    expect(store.get(1, 'run:a')?.segments).toEqual([]);
    paint();
    store.drop(1, 'run:a', 'a');
    paint();
    expect(notified()).toBe(2);
    expect(asked()).toBe(2);
    store.forget(1, 'run:a');
    store.forget(1, 'run:a');
    expect(store.get(1, 'run:a')).toBeUndefined();
    expect(store.get(1, 'run:b')).toBeDefined();
    paint();
    expect(notified()).toBe(3);
    expect(asked()).toBe(3);
  });

  it('applies each frame at once but notifies once per animation frame', () => {
    const { store, paint, asked, notified } = storeWithFrames();
    for (let seq = 1; seq <= 100; seq += 1) {
      store.applyDelta(1, 'run:a', frame(seq, 'x'), () => {});
      expect(store.get(1, 'run:a')?.segments[0]?.text).toHaveLength(seq);
    }
    expect(asked()).toBe(1);
    expect(notified()).toBe(0);
    paint();
    expect(notified()).toBe(1);

    // The next change asks for the next frame.
    store.applyDelta(1, 'run:a', frame(101, 'x'), () => {});
    expect(asked()).toBe(2);
    paint();
    expect(notified()).toBe(2);
  });

  it('notifies at once on flush, and not again when the frame comes', () => {
    const { store, paint, asked, notified } = storeWithFrames();
    store.applyDelta(1, 'run:a', frame(1, 'one'), () => {});
    store.flush();
    expect(notified()).toBe(1);
    paint();
    store.flush();
    expect(notified()).toBe(1);

    // A change after the flush asks for a frame of its own.
    store.applyDelta(1, 'run:a', frame(2, ' two'), () => {});
    expect(asked()).toBe(2);
    paint();
    expect(notified()).toBe(2);
  });

  it('waits for an animation frame, or a macrotask where there are none', async () => {
    const host = globalThis as {
      requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    };
    const had = Object.hasOwn(host, 'requestAnimationFrame');
    const original = host.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    try {
      host.requestAnimationFrame = (cb) => frames.push(cb);
      const store = new LiveTextStore();
      let notified = 0;
      store.subscribe(() => {
        notified += 1;
      });
      store.applyDelta(1, 'run:a', frame(1, 'one'), () => {});
      store.applyDelta(1, 'run:a', frame(2, ' two'), () => {});
      expect(frames).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(notified).toBe(0);
      frames[0](0);
      expect(notified).toBe(1);

      host.requestAnimationFrame = undefined;
      store.applyDelta(1, 'run:a', frame(3, ' three'), () => {});
      expect(notified).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(notified).toBe(2);
    } finally {
      if (had) host.requestAnimationFrame = original;
      else delete host.requestAnimationFrame;
    }
  });
});
