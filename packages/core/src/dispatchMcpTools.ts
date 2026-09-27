// Every tool the dispatch MCP server registers. @dispatch/mcp's tests hold its
// registrations to this list; executors that gate MCP tools by name use it.
export const DISPATCH_MCP_TOOLS = [
  'channel_join',
  'channel_leave',
  'channel_list',
  'dispatch_note',
  'inbox_read',
  'memory_read',
  'memory_search',
  'msg_reply',
  'msg_send',
  'record_decision',
  'record_evidence',
  'record_mutation',
  'run_list',
  'task_comment',
  'task_get',
  'task_list',
  'task_next',
  'task_save',
  'thread_read',
] as const;
