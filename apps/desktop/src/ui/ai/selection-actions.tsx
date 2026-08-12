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
  /** Top edge of the scrollable area `position` is measured against, for flip-below
   * detection. Defaults to `0` (the viewport top) — pass a container's own top when the
   * selection lives inside a scrolled pane rather than the window. */
  viewportTop?: number;
  /** Width of the area to keep the menu's horizontal center within. Defaults to
   * `window.innerWidth`; pass `undefined` explicitly (or render outside a browser) to skip
   * horizontal clamping. */
  viewportWidth?: number;
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

// Gap kept between the selection rect and the menu, both above and below.
const MENU_GAP = 8;
// The menu is a fixed `h-9` row; there's nothing to measure before the first paint, so this
// stands in for its real height when deciding whether it fits above the selection.
const MENU_HEIGHT_ESTIMATE = 36;
// Kept clear of either viewport edge when clamping the horizontal center.
const HORIZONTAL_MARGIN = 8;

export type MenuPlacement = {
  top: number;
  left: number;
  transform: string;
};

/** Where `SelectionActionsMenu` renders relative to a selection `rect`: above it by default,
 * flipping below (`rect.bottom + gap`) whenever there isn't `MENU_GAP + MENU_HEIGHT_ESTIMATE`
 * of clearance above `viewportTop` (a selection near the top of the window, or of a scrolled
 * container when `viewportTop` is supplied). Horizontal placement centers on `rect`, clamping
 * that center into `[HORIZONTAL_MARGIN, viewportWidth - HORIZONTAL_MARGIN]` when `viewportWidth`
 * is given.
 *
 * This clamps the *center point* the menu is transformed from, not its rendered edges — the
 * menu's real width isn't known without measuring the DOM, which this pure function
 * deliberately doesn't do (kept synchronous and testable without a render). For a menu whose
 * on-screen width is small relative to the viewport (this one caps out well under 400px), that
 * approximation keeps it from running off-screen in practice; a viewport narrower than the menu
 * itself isn't something this covers, but also isn't a case actionable without a real
 * measurement pass. */
export function menuPlacement(
  rect: DOMRect,
  options: { viewportTop?: number; viewportWidth?: number } = {}
): MenuPlacement {
  const { viewportTop = 0, viewportWidth } = options;

  const fitsAbove = rect.top - MENU_GAP - MENU_HEIGHT_ESTIMATE >= viewportTop;
  const top = fitsAbove ? rect.top : rect.bottom;
  const verticalTransform = fitsAbove
    ? `calc(-100% - ${MENU_GAP}px)`
    : `${MENU_GAP}px`;

  const center = rect.left + rect.width / 2;
  const left =
    viewportWidth === undefined
      ? center
      : Math.min(
          Math.max(center, HORIZONTAL_MARGIN),
          viewportWidth - HORIZONTAL_MARGIN
        );

  return { top, left, transform: `translate(-50%, ${verticalTransform})` };
}

/** Floating chip-row menu shown above a text selection, pop-in with `ease-out-expo`
 * (`motion-reduce:` disables it). Renders `actions` as a row of pill buttons; an action with
 * `options` (Tone by default) swaps the row for a submenu of its options instead of calling
 * `onAction` right away — a back chevron returns to the top-level row. Flips below the
 * selection (via `menuPlacement`) when there isn't room above, so a selection near the top of
 * the viewport still gets a visible, on-screen menu. Purely positioned and controlled: the
 * caller supplies `position` (typically from `useTextSelection`) and reacts to `onAction`.
 * Matches the showcase's "Selection Actions" primitive. */
export function SelectionActionsMenu({
  actions,
  onAction,
  position,
  viewportTop,
  viewportWidth = typeof window === 'undefined' ? undefined : window.innerWidth,
}: SelectionActionsMenuProps) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const submenu = actions.find((action) => action.id === openSubmenuId);
  const placement = menuPlacement(position, { viewportTop, viewportWidth });

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
        top: placement.top,
        left: placement.left,
        transform: placement.transform,
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
