import { Asterisk, Bot, Diamond, Gem, Triangle } from 'lucide-react';

interface AgentIconProps {
  agentId: string;
  /** The icon's edge in px; 14 inside a Chip, the lucide size the design rules use. */
  size?: number;
}

/** Maps an agent id to a lucide icon — `agentMeta().icon` is a unicode glyph
 * (`✳`/`◆`/`◈`/`▲`), which `SessionDetailModal` renders as an equivalent lucide icon instead
 * of raw unicode. Decorative (`aria-hidden`): the agent's name always sits beside it. */
export function AgentIcon({ agentId, size = 14 }: AgentIconProps) {
  const props = { size, strokeWidth: 1.8, 'aria-hidden': true } as const;
  switch (agentId) {
    case 'claude':
      return <Asterisk {...props} />;
    case 'codex':
      return <Diamond {...props} />;
    case 'gemini':
      return <Gem {...props} />;
    case 'cursor':
      return <Triangle {...props} />;
    default:
      return <Bot {...props} />;
  }
}
