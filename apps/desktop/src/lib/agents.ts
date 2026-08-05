/** Shared display metadata for every agent CLI this app knows about, keyed by the `agent`
 * column's value. Centralized here since the same icon/label pairing shows up everywhere a
 * session or project is displayed (dashboard, project cards, session detail, board cards,
 * reports) — one place to update if an icon or label ever changes. */
export interface AgentMeta {
  label: string;
  icon: string;
}

const AGENT_META: Record<string, AgentMeta> = {
  claude: { label: 'Claude Code', icon: '✳' },
  codex: { label: 'Codex', icon: '◆' },
  gemini: { label: 'Gemini', icon: '◈' },
  cursor: { label: 'Cursor', icon: '▲' },
};

/** Falls back to the raw id as the label (and a generic dot icon) for any agent id this list
 * doesn't know about yet, rather than rendering `undefined`. */
export function agentMeta(agentId: string): AgentMeta {
  return AGENT_META[agentId] ?? { label: agentId, icon: '●' };
}
