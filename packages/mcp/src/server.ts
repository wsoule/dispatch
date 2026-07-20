import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ONBOARDING_MARKDOWN } from './onboarding.js';
import { registerDispatchTools } from './tools.js';

export const MCP_SERVER_NAME = 'dispatch';
export const MCP_SERVER_VERSION = '0.0.1';

// Builds a dispatch MCP server rooted at `rootDir`: the five task_* tools
// (see tools.ts) plus a `workflow://onboarding` resource that briefs an
// agent client on how to use them. `rootDir` is fixed at construction time —
// every tool call operates on it directly via core's TaskStore (no daemon
// proxy; see the Phase 3 plan for why direct file access is the sync point).
export function createDispatchMcpServer(rootDir: string): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  registerDispatchTools(server, rootDir);

  server.registerResource(
    'onboarding',
    'workflow://onboarding',
    {
      title: 'Dispatch onboarding',
      description: 'How an agent should use the task_* tools in this server.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/markdown', text: ONBOARDING_MARKDOWN },
      ],
    })
  );

  return server;
}

// Builds a server rooted at `rootDir` and serves it over stdio until the
// transport closes. The one thing both `dispatch-mcp` (this package's own
// bin) and `dispatch mcp` (the CLI, via a dynamic import — see
// packages/cli/src/program.ts) need, so neither has to depend on the SDK's
// transport APIs directly.
export async function runStdioServer(rootDir: string): Promise<void> {
  const server = createDispatchMcpServer(rootDir);
  await server.connect(new StdioServerTransport());
}
