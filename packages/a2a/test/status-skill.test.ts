import { expect, it } from 'bun:test';

import { statusReply } from '../src/statusSkill.js';

it('writes one line per task and the same data', () => {
  const reply = statusReply([
    {
      a2aTask: 'm-1',
      task: 't-4a8cce',
      title: 'Rate-limit uploads',
      status: 'working',
      stage: 'review',
      pr: 'https://github.com/acme/api/pull/42',
    },
  ]);
  expect(reply.text).toBe(
    't-4a8cce · working (review) · Rate-limit uploads · https://github.com/acme/api/pull/42'
  );
  expect(reply.data).toEqual({
    tasks: [
      {
        a2aTask: 'm-1',
        task: 't-4a8cce',
        title: 'Rate-limit uploads',
        status: 'working',
        stage: 'review',
        pr: 'https://github.com/acme/api/pull/42',
      },
    ],
  });
  expect(statusReply([]).text).toBe('No handoffs yet.');
});
