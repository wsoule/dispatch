import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, useRef, useState } from 'react';
import { renderToString } from 'react-dom/server';

import {
  type ElementWidthOptions,
  useElementWidth,
  useWidthBelow,
} from '../src/index';

// useElementWidth and useWidthBelow: one ResizeObserver per hook on one
// element, reading its clientWidth; a zero width keeps the last answer.
// happy-dom lays nothing out, so a stand-in observer records what it watches
// and a test plays a resize by setting clientWidth and firing the callbacks.

interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

const Original = globalThis.ResizeObserver;
let observers: FakeObserver[] = [];

function installFakeObserver(): void {
  observers = [];
  class FakeResizeObserver {
    private entry: FakeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [], disconnected: false };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  }
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = Original;
});

// Gives `element` this clientWidth and fires every live observer watching it,
// as a resize would.
function resize(element: Element, width: number): void {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  act(() => {
    for (const o of observers) {
      if (!o.disconnected && o.targets.includes(element)) {
        o.callback([], {} as ResizeObserver);
      }
    }
  });
}

// A box measured through a ref object, printing the hook's answer.
function RefProbe({
  below,
  options,
  width,
}: {
  below?: number;
  options?: ElementWidthOptions;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  if (width !== undefined) {
    // A pre-set width, so a measure on mount has something to read.
    const set = (node: HTMLDivElement | null) => {
      ref.current = node;
      if (node !== null) {
        Object.defineProperty(node, 'clientWidth', {
          configurable: true,
          get: () => width,
        });
      }
    };
    return createElement(Answer, { target: ref, below, options, set });
  }
  return createElement(Answer, { target: ref, below, options, set: ref });
}

function Answer({
  target,
  below,
  options,
  set,
}: {
  target: { readonly current: Element | null };
  below?: number;
  options?: ElementWidthOptions;
  set: ((node: HTMLDivElement | null) => void) | { current: unknown };
}) {
  const width = useElementWidth(target, options);
  const narrow = useWidthBelow(target, below ?? 0, options);
  return createElement(
    'div',
    { ref: set as never, 'data-testid': 'box' },
    `${width ?? 'none'} ${narrow ? 'narrow' : 'wide'}`
  );
}

function box(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid=box]');
  if (el === null) throw new Error('no box');
  return el;
}

describe('useElementWidth', () => {
  test('null until the observer reports, then the clientWidth as it changes', () => {
    installFakeObserver();
    render(createElement(RefProbe));
    expect(box().textContent).toBe('none wide');
    resize(box(), 640);
    expect(box().textContent).toBe('640 wide');
    resize(box(), 320);
    expect(box().textContent).toBe('320 wide');
  });

  test('a box with no width keeps the last answer', () => {
    installFakeObserver();
    render(createElement(RefProbe, { below: 500 }));
    resize(box(), 320);
    expect(box().textContent).toBe('320 narrow');
    resize(box(), 0);
    expect(box().textContent).toBe('320 narrow');
  });

  test('measureOnMount answers before the first paint, with no callback', () => {
    installFakeObserver();
    render(
      createElement(RefProbe, {
        below: 500,
        width: 300,
        options: { measureOnMount: true },
      })
    );
    expect(box().textContent).toBe('300 narrow');
  });

  test('one observer per hook, on the one element, disconnected on unmount', () => {
    installFakeObserver();
    const { unmount } = render(createElement(RefProbe));
    // Two hooks in the probe: one observer each, each on the box alone.
    expect(observers).toHaveLength(2);
    for (const o of observers) expect(o.targets).toEqual([box()]);
    unmount();
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  test('an element held in state resubscribes when it changes', () => {
    installFakeObserver();
    function Swap() {
      const [first, setFirst] = useState<HTMLElement | null>(null);
      const [second, setSecond] = useState<HTMLElement | null>(null);
      const [useSecond, setUseSecond] = useState(false);
      const width = useElementWidth(useSecond ? second : first);
      return createElement(
        'div',
        null,
        createElement('div', { ref: setFirst, 'data-testid': 'first' }),
        createElement('div', { ref: setSecond, 'data-testid': 'second' }),
        createElement(
          'button',
          { type: 'button', onClick: () => setUseSecond(true) },
          String(width)
        )
      );
    }
    render(createElement(Swap));
    const first = document.querySelector('[data-testid=first]');
    const second = document.querySelector('[data-testid=second]');
    const button = document.querySelector('button');
    if (first === null || second === null || button === null) {
      throw new Error('missing');
    }
    resize(first, 400);
    expect(button.textContent).toBe('400');
    act(() => button.click());
    // The first element's observer is gone; the second's reports.
    expect(observers[0]?.disconnected).toBe(true);
    resize(second, 700);
    expect(button.textContent).toBe('700');
  });

  test('without ResizeObserver, measureOnMount still measures once', () => {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
    render(
      createElement(RefProbe, {
        width: 900,
        below: 500,
        options: { measureOnMount: true },
      })
    );
    expect(box().textContent).toBe('900 wide');
  });
});

describe('useWidthBelow', () => {
  test('flips at the threshold: under it is narrow, at it is wide', () => {
    installFakeObserver();
    render(createElement(RefProbe, { below: 512 }));
    resize(box(), 512);
    expect(box().textContent).toBe('512 wide');
    resize(box(), 511);
    expect(box().textContent).toBe('511 narrow');
  });

  test('re-renders only when the answer flips', () => {
    installFakeObserver();
    let renders = 0;
    function Counter() {
      const ref = useRef<HTMLDivElement>(null);
      const narrow = useWidthBelow(ref, 500);
      renders += 1;
      return createElement(
        'div',
        { ref, 'data-testid': 'box' },
        narrow ? 'narrow' : 'wide'
      );
    }
    render(createElement(Counter));
    const before = renders;
    resize(box(), 800);
    resize(box(), 900);
    resize(box(), 1000);
    expect(renders).toBe(before);
    resize(box(), 400);
    expect(renders).toBe(before + 1);
    expect(box().textContent).toBe('narrow');
  });
});

describe('server rendering', () => {
  test('renders the starting answers with no DOM work', () => {
    function Server() {
      const ref = useRef<HTMLDivElement>(null);
      const width = useElementWidth(ref, { measureOnMount: true });
      const narrow = useWidthBelow(ref, 500, { measureOnMount: true });
      return createElement(
        'div',
        { ref },
        `${width ?? 'none'} ${narrow ? 'narrow' : 'wide'}`
      );
    }
    expect(renderToString(createElement(Server))).toBe('<div>none wide</div>');
  });
});
