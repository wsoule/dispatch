import { describe, expect, it } from 'bun:test';

import { portCallOf } from '../../src/a2a/relayClient.js';

describe('relay review M6: a call names a port route and nothing else', () => {
  it('maps a port route to its segments', () => {
    expect(portCallOf('/tasks/x/watch?y=1')).toEqual({
      url: 'http://relay.invalid/api/a2a/port/tasks/x/watch?y=1',
      rest: ['tasks', 'x', 'watch'],
    });
  });

  it('refuses a route that leaves /api/a2a/port/', () => {
    for (const route of [
      '/../../tasks',
      '/%2e%2e/%2e%2e/tasks',
      '/',
      '//evil.example/x',
      'tasks',
    ])
      expect(portCallOf(route)).toBeNull();
  });
});
