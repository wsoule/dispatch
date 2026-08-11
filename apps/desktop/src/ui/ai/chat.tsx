import { PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type ChatTab = {
  id: string;
  label: string;
  unread?: boolean;
};

export type ChatPanelProps = {
  tabs: ChatTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onNewTab?: () => void;
  children: ReactNode;
  composer: ReactNode;
};

/** Card-framed chat panel: a segmented tab strip up top (matching ui/tabs.tsx's
 * lifted-active treatment — `bg-card` + `shadow-btn` on the active tab, a dot for
 * tabs with unread activity), a scrollable message area for `children` (typically
 * `ChatMessage` rows), and a `composer` slot pinned to the bottom. Fully controlled:
 * tab selection lives with the caller. Matches the showcase's "Chat" primitive. */
export function ChatPanel({
  tabs,
  activeTabId,
  onSelectTab,
  onNewTab,
  children,
  composer,
}: ChatPanelProps) {
  return (
    <div className="bg-card rounded-card shadow-card flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-1.5 py-1.5">
        <div className="bg-muted rounded-control flex items-center gap-0.5 p-[3px]">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => onSelectTab(tab.id)}
                className={`flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[13px] font-medium transition-colors duration-100 ${
                  isActive
                    ? 'bg-card text-foreground shadow-btn'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
                {tab.unread === true && (
                  <span
                    aria-hidden
                    className="bg-primary size-1.5 shrink-0 rounded-full"
                  />
                )}
              </button>
            );
          })}
        </div>
        {onNewTab !== undefined && (
          <button
            type="button"
            aria-label="New chat"
            onClick={onNewTab}
            className="text-muted-foreground hover:bg-surface-hover hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-100"
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {children}
      </div>

      <div className="shrink-0 p-1.5">{composer}</div>
    </div>
  );
}

export type ChatMessageProps = {
  role: 'user' | 'agent';
  children: ReactNode;
  avatar?: ReactNode;
};

/** One message row. User turns render as a right-aligned inset bubble, indented from
 * the left so it never spans the full width. Agent turns render full-width with no
 * bubble chrome, so streamed replies, `Thinking` traces, and `ToolChip`s can sit
 * directly in the flow; an optional `avatar` sits at the top-left of an agent
 * message. Matches the showcase's "Chat" primitive. */
export function ChatMessage({ role, children, avatar }: ChatMessageProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end pl-10">
        <div className="bg-surface-inset rounded-card text-foreground px-3 py-1.5 text-[13px] leading-[1.4]">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-start gap-2">
      {avatar !== undefined && <div className="mt-0.5 shrink-0">{avatar}</div>}
      <div className="text-foreground min-w-0 flex-1 text-[13px] leading-normal">
        {children}
      </div>
    </div>
  );
}
