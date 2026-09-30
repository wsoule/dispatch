// Every tool the dispatch MCP server registers. @dispatch/mcp's tests hold its
// registrations to this list; executors that gate MCP tools by name use it.
export const DISPATCH_MCP_TOOLS = [
  'channel_join',
  'channel_leave',
  'channel_list',
  'dispatch_note',
  'doc_link',
  'doc_list',
  'doc_read',
  'doc_save',
  'doc_search',
  'inbox_read',
  'memory_forget',
  'memory_read',
  'memory_save',
  'memory_search',
  'msg_reply',
  'msg_send',
  'record_evidence',
  'record_mutation',
  'run_list',
  'task_comment',
  'task_comments',
  'task_get',
  'task_list',
  'task_next',
  'task_save',
  'thread_read',
] as const;

// The messaging subset of DISPATCH_MCP_TOOLS. Executors auto-allow these:
// gating one would make a human approve a question before seeing it.
export const DISPATCH_MESSAGING_TOOLS = [
  'channel_join',
  'channel_leave',
  'channel_list',
  'inbox_read',
  'msg_reply',
  'msg_send',
  'thread_read',
] as const satisfies readonly (typeof DISPATCH_MCP_TOOLS)[number][];
