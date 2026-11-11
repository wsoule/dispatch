import { describe, expect, it } from 'bun:test';

import { describeMachine } from '../src/commands/machineTeam.js';

// `dispatch team status` also says which roster this machine's agent
// clients use, and which clients cannot reach Dispatch (#237).

describe('describeMachine', () => {
  it('names the account team and says it is separate from the project team', () => {
    const lines = describeMachine(
      {
        server: 'https://app.dispatch.foo',
        token: 't',
        handle: 'bob',
        team: { id: 'team_1', name: 'Core' },
        device: 'd',
      },
      [{ client: 'Claude Code', state: 'connected' }]
    );
    expect(lines.join('\n')).toContain(
      'team: Core as bob on https://app.dispatch.foo'
    );
    expect(lines.join('\n')).toContain('separate from the project team');
    expect(lines).toContain('  ✓ Claude Code: connected');
  });

  it('says how to sign in, and how to fix a broken client', () => {
    const lines = describeMachine(null, [
      {
        client: 'Claude Code hooks',
        state: 'broken',
        detail: '/gone/node no longer exists',
      },
    ]);
    expect(lines.join('\n')).toContain('npx -y @dispatch-foo/mcp login');
    expect(lines).toContain(
      '  ✗ Claude Code hooks: broken — /gone/node no longer exists'
    );
  });
});
