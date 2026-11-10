import { afterEach, expect, test } from 'bun:test';

import { whenDisconnected } from './whenDisconnected';

// MutationObserver callbacks run as microtasks after the change.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.replaceChildren();
});

test('fires once when the node leaves the document', async () => {
  const host = document.createElement('div');
  const node = document.createElement('span');
  host.append(node);
  document.body.append(host);
  let calls = 0;
  whenDisconnected(node, () => {
    calls += 1;
  });
  // Changes that keep the node in the document fire nothing.
  host.append(document.createElement('i'));
  await flush();
  expect(calls).toBe(0);
  // An ancestor's removal takes the node out with it.
  host.remove();
  await flush();
  expect(calls).toBe(1);
  document.body.append(host);
  host.remove();
  await flush();
  expect(calls).toBe(1);
});

test('a node already out of the document fires at once', () => {
  let calls = 0;
  whenDisconnected(document.createElement('div'), () => {
    calls += 1;
  });
  expect(calls).toBe(1);
});

test('stopping the watch before the removal fires nothing', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  let calls = 0;
  const stop = whenDisconnected(node, () => {
    calls += 1;
  });
  stop();
  node.remove();
  await flush();
  expect(calls).toBe(0);
});
