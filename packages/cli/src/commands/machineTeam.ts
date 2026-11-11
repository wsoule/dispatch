import type { ClientHealth, TeamFile } from '@dispatch-foo/mcp';

// `dispatch team status` reads the project team (the repo's team.yml). The
// agent clients on this machine (Claude Code and others, through
// dispatch-mcp) reach teammates through a different roster: the account
// team this machine signed in to. Showing both, with each client's health,
// is what tells someone why a teammate's agent is invisible (#237).

/** Lines describing this machine's own team sign-in and agent clients. */
export function describeMachine(
  team: TeamFile | null,
  clients: ClientHealth[]
): string[] {
  const lines = [
    '',
    "This machine's agent clients (Claude Code, Codex, … through dispatch-mcp):",
    team === null
      ? '  team: not signed in, so they reach only agents on this machine. Run `npx -y @dispatch-foo/mcp login`, or `npx -y @dispatch-foo/mcp join <invite link>`.'
      : `  team: ${team.team.name} as ${team.handle} on ${team.server}. This is the roster their agent_list shows; it is separate from the project team above.`,
  ];
  if (clients.length === 0)
    lines.push('  no agent clients found on this machine');
  for (const c of clients)
    lines.push(
      c.state === 'connected'
        ? `  ✓ ${c.client}: connected`
        : `  ✗ ${c.client}: ${c.state}${c.detail === undefined ? '' : ` — ${c.detail}`}`
    );
  return lines;
}
