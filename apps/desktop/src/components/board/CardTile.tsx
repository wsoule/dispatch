import { agentMeta } from '../../lib/agents';
import type { Card, Session } from '../../lib/types';

interface CardTileProps {
  card: Card;
  linkedSession: Session | null;
  onClick: () => void;
  onDragStart: (cardId: string) => void;
}

export function CardTile({
  card,
  linkedSession,
  onClick,
  onDragStart,
}: CardTileProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(card.id);
      }}
      onClick={onClick}
      // The `[-webkit-user-drag:element]` arbitrary property is load-bearing: without it,
      // WKWebView (Tauri's macOS webview) fires `dragstart` on a `draggable` element fine but
      // never delivers the corresponding `dragover`/`drop` to the drop target — it falls back
      // to treating the gesture as a generic content drag instead of page-internal HTML5 DnD.
      // Chromium doesn't need this; WebKit does.
      className="border-border/70 bg-card hover:border-border flex cursor-grab flex-col gap-1 rounded-md border p-3 transition-all duration-150 [-webkit-user-drag:element] hover:-translate-y-0.5 hover:shadow-sm active:cursor-grabbing"
    >
      <div className="text-foreground text-[13px] font-medium">
        {card.title}
      </div>
      {card.description ? (
        <div className="text-muted-foreground line-clamp-2 text-[12px]">
          {card.description}
        </div>
      ) : null}
      {linkedSession ? (
        <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
          <span
            className={`size-1.5 rounded-full ${
              linkedSession.status === 'active'
                ? 'bg-emerald-500'
                : 'bg-muted-foreground/40'
            }`}
          />
          {agentMeta(linkedSession.agent).icon}{' '}
          {linkedSession.model ?? agentMeta(linkedSession.agent).label}
          {linkedSession.cost_usd > 0
            ? ` · $${linkedSession.cost_usd.toFixed(2)}`
            : ''}
        </div>
      ) : null}
    </div>
  );
}
