import { Asterisk, Bot, Diamond, Gem, Triangle } from 'lucide-react';

interface AgentIconProps {
  agentId: string;
  className?: string;
}

/** Maps an agent id to a lucide icon — `agentMeta().icon` is a unicode glyph
 * (`✳`/`◆`/`◈`/`▲`), which `SessionDetailModal` renders as an equivalent lucide icon instead
 * of raw unicode. */
export function AgentIcon({ agentId, className }: AgentIconProps) {
  switch (agentId) {
    case 'claude':
      return <Asterisk className={className} />;
    case 'codex':
      return <Diamond className={className} />;
    case 'gemini':
      return <Gem className={className} />;
    case 'cursor':
      return <Triangle className={className} />;
    default:
      return <Bot className={className} />;
  }
}
