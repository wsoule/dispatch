import { expect, test } from 'bun:test';

import { presenceLine } from './remotePresence';

const BOB = { replica: 'bob-0000000b', handle: 'bob', device: 'desk' };

test("names the machine a task's run is on, and whom it waits on", () => {
  expect(presenceLine(BOB, null)).toBe("Running on bob's desk");
  expect(presenceLine(BOB, 'ada')).toBe(
    "Running on bob's desk, waiting on ada"
  );
  expect(presenceLine(null, 'ada')).toBe('waiting on ada');
  expect(presenceLine(null, null)).toBeNull();
});
