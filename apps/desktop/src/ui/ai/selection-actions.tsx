import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  ScissorsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SpellCheckIcon,
} from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';

export type SelectionActionOption = {
  id: string;
  label: string;
};

export type SelectionAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Present only on actions that expand into a submenu (Tone) instead of firing `onAction`
   * directly when clicked. */
  options?: SelectionActionOption[];
};

export type SelectionActionsMenuProps = {
  actions: SelectionAction[];
  onAction: (actionId: string) => void;
  /** The selection's bounding rect (viewport coordinates, e.g. from `useTextSelection`) the
   * menu floats above. */
  position: DOMRect;
};

const ICON_CLASS = 'size-3.5';

/** Explain/Improve/Shorten/Tone/Grammar — the default action set shown over a text selection.
 * Tone is the one entry with `options`, so picking it opens a submenu instead of firing
 * immediately. */
export const defaultSelectionActions: SelectionAction[] = [
  {
    id: 'explain',
    label: 'Explain',
    icon: <MessageCircleQuestionIcon aria-hidden className={ICON_CLASS} />,
  },
  {
    id: 'improve',
    label: 'Improve',
    icon: <SparklesIcon aria-hidden className={ICON_CLASS} />,
  },
  {
    id: 'shorten',
    label: 'Shorten',
    icon: <ScissorsIcon aria-hidden className={ICON_CLASS} />,
  },
  {
    id: 'tone',
    label: 'Tone',
    icon: <SlidersHorizontalIcon aria-hidden className={ICON_CLASS} />,
    options: [
      { id: 'tone-professional', label: 'Professional' },
      { id: 'tone-friendly', label: 'Friendly' },
      { id: 'tone-direct', label: 'Direct' },
    ],
  },
  {
    id: 'grammar',
    label: 'Grammar',
    icon: <SpellCheckIcon aria-hidden className={ICON_CLASS} />,
  },
];

const CHIP_BUTTON_CLASS =
  'text-foreground hover:bg-surface-hover ease-out-expo inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-normal transition-colors duration-100 active:scale-[0.96]';

/** Floating chip-row menu shown above a text selection, pop-in with `ease-out-expo`
 * (`motion-reduce:` disables it). Renders `actions` as a row of pill buttons; an action with
 * `options` (Tone by default) swaps the row for a submenu of its options instead of calling
 * `onAction` right away — a back chevron returns to the top-level row. Purely positioned and
 * controlled: the caller supplies `position` (typically from `useTextSelection`) and reacts to
 * `onAction`. Matches the showcase's "Selection Actions" primitive. */
export function SelectionActionsMenu({
  actions,
  onAction,
  position,
}: SelectionActionsMenuProps) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const submenu = actions.find((action) => action.id === openSubmenuId);

  function handleActionClick(action: SelectionAction) {
    if (action.options) {
      setOpenSubmenuId(action.id);
      return;
    }
    onAction(action.id);
  }

  function handleOptionClick(option: SelectionActionOption) {
    onAction(option.id);
    setOpenSubmenuId(null);
  }

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left + position.width / 2,
        transform: 'translate(-50%, calc(-100% - 8px))',
      }}
      className="animate-in fade-in-0 zoom-in-95 ease-out-expo rounded-control bg-card shadow-overlay z-50 flex h-9 items-center gap-0.5 p-1 duration-150 motion-reduce:animate-none"
    >
      {submenu?.options ? (
        <>
          <button
            type="button"
            aria-label="Back to actions"
            onClick={() => setOpenSubmenuId(null)}
            className="text-muted-foreground hover:bg-surface-hover flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-100"
          >
            <ChevronLeftIcon aria-hidden className={ICON_CLASS} />
          </button>
          {submenu.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => handleOptionClick(option)}
              className={CHIP_BUTTON_CLASS}
            >
              {option.label}
            </button>
          ))}
        </>
      ) : (
        actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => handleActionClick(action)}
            className={CHIP_BUTTON_CLASS}
          >
            {action.icon}
            {action.label}
            {action.options && (
              <ChevronRightIcon
                aria-hidden
                className="text-muted-foreground size-3"
              />
            )}
          </button>
        ))
      )}
    </div>
  );
}

/** Reads the document selection scoped to `ref`'s subtree, kept in sync via the
 * `selectionchange` event and cleaned up on unmount. Returns `{ text: '', rect: null }`
 * whenever there is no selection, it is collapsed (a bare caret), or it lives outside `ref` —
 * a caller can use that to hide `SelectionActionsMenu` without a separate "is there a
 * selection" check. */
export function useTextSelection(ref: RefObject<HTMLElement | null>): {
  text: string;
  rect: DOMRect | null;
} {
  const [state, setState] = useState<{ text: string; rect: DOMRect | null }>({
    text: '',
    rect: null,
  });

  useEffect(() => {
    function handleSelectionChange() {
      const container = ref.current;
      const selection = document.getSelection();
      if (
        !container ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setState({ text: '', rect: null });
        return;
      }

      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setState({ text: '', rect: null });
        return;
      }

      setState({
        text: selection.toString(),
        rect: range.getBoundingClientRect(),
      });
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange);
  }, [ref]);

  return state;
}
