'use client';

import { Search } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import StatusMark from '../components/status-mark';
import styles from './command-palette.module.css';
import {
  isTypingTarget,
  modalIsOpen,
  PHONE_QUERY,
  trapTab,
  useDialogFocus,
  useMediaQuery,
  useModKeyLabel,
  useScrollLock,
} from './dom';
import { fuzzyMatch, highlightRuns } from './fuzzy';
import { Kbd, KbdKeys } from './kbd';
import { cx, renderIcon } from './render';
import { Skeleton } from './skeleton';
import type {
  CommandPaletteApi,
  CommandPaletteProps,
  CommandPaletteProviderProps,
  PaletteItem,
  PaletteView,
  ShortcutGroup,
  ShortcutSheetProps,
} from './types';

// The command palette (Ctrl/⌘ K), its "?" shortcuts sheet, and the global
// two-key shortcuts registered from palette items (G then W → My week).
// Gr8r's palette — sections, ↑/↓, ↵, Tab between sections, Esc — and its
// look: a rounded white card with the pop shadow over the --overlay scrim,
// a soft --surface-2 highlight for the active row.

/** How long the second key of a sequence may lag the first (Gr8r: 1.2s). */
const SEQUENCE_MS = 1200;
const RETRY_ID = '__shell-palette-retry';
const MODIFIER_KEYS = new Set([
  'ctrl',
  'control',
  'cmd',
  'command',
  'meta',
  'mod',
  'shift',
  'alt',
  'option',
  '⌘',
  '⇧',
  '⌥',
  '⌃',
]);

/**
 * The registered form of a shortcut ("g w"), or null when it is display
 * only: empty, longer than two keys, naming a modifier, or using a named key
 * such as Esc. Keys compare case-insensitively.
 */
export function shortcutCode(
  keys: readonly string[] | undefined
): string | null {
  if (keys === undefined || keys.length === 0 || keys.length > 2) return null;
  const lower = keys.map((k) => k.toLowerCase());
  if (lower.some((k) => MODIFIER_KEYS.has(k) || k.length !== 1)) {
    return null;
  }
  return lower.join(' ');
}

function defaultNavigate(href: string): void {
  window.location.assign(href);
}

interface RankedItem {
  item: PaletteItem;
  labelHits: number[];
  hintHits: number[];
  score: number;
  /** Position in the flattened option list (drives aria-activedescendant). */
  index: number;
}

interface RankedSection {
  name: string;
  items: RankedItem[];
  /** Matches beyond the per-section cap. */
  hidden: number;
}

/**
 * Groups items into ordered sections. With a query, only fuzzy matches stay
 * and each section is ranked best-first (ties keep their given order).
 * Sections follow `order`, then first appearance. One pass over the items.
 */
function rankSections(
  items: readonly PaletteItem[],
  query: string,
  order: readonly string[],
  maxPerSection: number
): RankedSection[] {
  const bySection = new Map<string, RankedItem[]>();
  const searching = query.trim() !== '';
  for (const item of items) {
    const match = searching
      ? fuzzyMatch(query, item.label, item.hint)
      : { score: 0, labelHits: [], hintHits: [] };
    if (match === null) continue;
    let list = bySection.get(item.section);
    if (list === undefined) {
      list = [];
      bySection.set(item.section, list);
    }
    list.push({ item, ...match, index: 0 });
  }
  const ordered = new Set<string>();
  for (const name of order) if (bySection.has(name)) ordered.add(name);
  for (const name of bySection.keys()) ordered.add(name);

  // A cap below 1 would leave headed sections with no rows (and nothing
  // for Tab to land on), so every section shows at least one.
  const cap = Math.max(1, Math.floor(maxPerSection));
  let index = 0;
  const out: RankedSection[] = [];
  for (const name of ordered) {
    const list = bySection.get(name) ?? [];
    if (searching) list.sort((a, b) => b.score - a.score);
    const shown = list.slice(0, cap);
    for (const ranked of shown) ranked.index = index++;
    out.push({ name, items: shown, hidden: list.length - shown.length });
  }
  return out;
}

/** Static items first; a loaded item with the same id is dropped. */
function mergeItems(
  base: readonly PaletteItem[],
  extra: readonly PaletteItem[]
): PaletteItem[] {
  if (extra.length === 0) return [...base];
  const seen = new Set(base.map((i) => i.id));
  return [...base, ...extra.filter((i) => !seen.has(i.id))];
}

function Highlight({
  text,
  hits,
}: {
  text: string;
  hits: readonly number[];
}): ReactNode {
  return highlightRuns(text, hits).map((run, i) =>
    run.hit ? (
      // Runs are positional slices of one string; order never changes.
      <mark key={i} className={styles.hit}>
        {run.text}
      </mark>
    ) : (
      <span key={i}>{run.text}</span>
    )
  );
}

/**
 * The palette dialog itself, controlled: mount it to open, unmount to
 * close (focus returns to whatever had it). The input keeps focus the whole
 * time; options are driven through aria-activedescendant.
 */
export function CommandPalette({
  items,
  onClose,
  onRun,
  loading = false,
  error = null,
  onRetry,
  onShowShortcuts,
  placeholder = 'Type a command or search…',
  sectionOrder,
  maxPerSection = 50,
  refuseQuery,
  onSubmitFreeText,
  freeTextLabel = 'Use text',
}: CommandPaletteProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useDialogFocus(panelRef, true, inputRef);
  // On a phone the panel fills the screen, so the page behind must not
  // scroll under a finger on the scrim (desktop keeps its scrollbar, so
  // opening the palette never shifts the layout).
  useScrollLock(useMediaQuery(PHONE_QUERY));

  // Text the host refuses outright (a pasted API key) matches nothing.
  const refusal = refuseQuery?.(query) ?? null;
  const sections = useMemo(() => {
    if (refusal !== null) return [];
    const ranked = rankSections(
      items,
      query,
      sectionOrder ?? [],
      maxPerSection
    );
    if (error !== null && onRetry !== undefined) {
      const index = ranked.reduce((n, s) => n + s.items.length, 0);
      ranked.push({
        name: 'Could not load',
        hidden: 0,
        items: [
          {
            item: {
              id: RETRY_ID,
              label: 'Retry loading',
              hint: error,
              section: 'Could not load',
            },
            labelHits: [],
            hintHits: [],
            score: 0,
            index,
          },
        ],
      });
    }
    return ranked;
  }, [items, query, sectionOrder, maxPerSection, error, onRetry, refusal]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const count = flat.length;
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);
  const optionId = (index: number): string => `${baseId}-opt-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = document.getElementById(`${baseId}-opt-${activeIndex}`);
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, baseId]);

  function choose(item: PaletteItem): void {
    if (item.id === RETRY_ID) {
      onRetry?.();
      return;
    }
    onRun(item);
  }

  // The typed text as a command of its own: only with a host handler, a
  // non-blank query and no refusal. Tab (forward) and the footer action
  // take this path; it is the least intrusive key, since a query narrows
  // the sections Tab would otherwise walk.
  const freeText = query.trim();
  const canSubmitFreeText =
    onSubmitFreeText !== undefined && freeText !== '' && refusal === null;

  function submitFreeText(): void {
    if (!canSubmitFreeText) return;
    onSubmitFreeText(freeText);
  }

  /** Moves the active row to the first row of the next (or previous)
      section, wrapping, so Tab walks Suggestions → Jump to → Navigation. */
  function cycleSection(direction: 1 | -1): void {
    if (sections.length === 0) return;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].items[0].index <= activeIndex) current = i;
    }
    const target = (current + direction + sections.length) % sections.length;
    setActive(sections[target].items[0].index);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) setActive((activeIndex + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) setActive((activeIndex - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        if (activeIndex >= 0) choose(flat[activeIndex].item);
        break;
      case 'Tab':
        event.preventDefault();
        if (canSubmitFreeText && !event.shiftKey) submitFreeText();
        else cycleSection(event.shiftKey ? -1 : 1);
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  }

  const status = loading
    ? 'Loading more results'
    : `${count} ${count === 1 ? 'result' : 'results'}`;

  return (
    <div className={styles.layer}>
      <div className={styles.scrim} aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={styles.panel}
        onKeyDown={(event) => {
          if (event.isDefaultPrevented()) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (panelRef.current !== null) trapTab(event, panelRef.current);
        }}
      >
        <div className={styles.inputRow}>
          <Search
            className={styles.searchIcon}
            size={16}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0 ? optionId(activeIndex) : undefined
            }
            aria-label="Search commands, pages and issues"
            autoComplete="off"
            spellCheck={false}
            className={styles.input}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className={styles.escButton}
            // The visible "Esc" leads the name (WCAG 2.5.3, label in name).
            aria-label="Esc, close command palette"
            onClick={onClose}
          >
            <Kbd>Esc</Kbd>
          </button>
        </div>

        <div className={styles.scroll}>
          <div
            role="listbox"
            id={listId}
            aria-label="Results"
            className={styles.list}
          >
            {sections.map((section, si) => {
              const headingId = `${baseId}-group-${si}`;
              const isError = section.items[0]?.item.id === RETRY_ID;
              return (
                <div
                  key={section.name}
                  role="group"
                  aria-labelledby={headingId}
                  className={styles.group}
                >
                  <div
                    aria-hidden="true"
                    className={cx(
                      styles.groupTitle,
                      isError && styles.groupError
                    )}
                  >
                    <span id={headingId}>{section.name}</span>
                    {!isError ? (
                      <span className={styles.groupCount}>
                        {section.items.length + section.hidden}
                      </span>
                    ) : null}
                  </div>
                  {section.items.map((ranked) => {
                    const { item } = ranked;
                    const selected = ranked.index === activeIndex;
                    return (
                      <div
                        key={item.id}
                        id={optionId(ranked.index)}
                        role="option"
                        aria-selected={selected}
                        className={styles.option}
                        onMouseMove={() => {
                          if (!selected) setActive(ranked.index);
                        }}
                        // Keep focus in the input; the click still selects.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(item)}
                        // The keyboard works through the input (↑/↓, ↵ on
                        // the active row): focus never lands on a row, so
                        // this runs only if a host focuses one. It still
                        // gives the row its own keyboard path.
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ')
                            return;
                          event.preventDefault();
                          event.stopPropagation();
                          choose(item);
                        }}
                      >
                        <span className={styles.optionIcon}>
                          {item.status !== undefined ? (
                            <StatusMark
                              status={item.status}
                              label={item.statusLabel ?? item.status}
                              muted={item.statusMuted === true}
                            />
                          ) : (
                            renderIcon(item.icon)
                          )}
                        </span>
                        <span className={styles.optionLabel}>
                          <Highlight
                            text={item.label}
                            hits={ranked.labelHits}
                          />
                        </span>
                        {item.hint !== undefined && item.hint !== '' ? (
                          <span className={styles.optionHint}>
                            <Highlight
                              text={item.hint}
                              hits={ranked.hintHits}
                            />
                          </span>
                        ) : null}
                        {item.shortcut !== undefined &&
                        item.shortcut.length > 0 ? (
                          <KbdKeys
                            keys={item.shortcut}
                            className={styles.optionKeys}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {section.hidden > 0 ? (
                    <div className={styles.more} aria-hidden="true">
                      {`+${section.hidden} more · keep typing`}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {loading ? (
            <div className={styles.loading} aria-hidden="true">
              <div className={styles.groupTitle}>
                <span>Loading</span>
              </div>
              {[46, 62].map((width) => (
                <div key={width} className={styles.skeletonRow}>
                  <Skeleton
                    width={13}
                    height={13}
                    className={styles.skeletonMark}
                  />
                  <Skeleton width={`${width}%`} height={9} />
                  <Skeleton
                    width={52}
                    height={9}
                    className={styles.skeletonEnd}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {refusal !== null ? (
            <p className={styles.empty} role="alert">
              {refusal}
            </p>
          ) : count === 0 && !loading ? (
            <p className={styles.empty}>
              {query.trim() === ''
                ? 'Nothing to jump to yet'
                : `No matches for “${query.trim()}”`}
            </p>
          ) : null}
        </div>

        <div role="status" aria-live="polite" className="srOnly">
          {status}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <KbdKeys keys={['↑', '↓']} /> Navigate
          </span>
          <span className={styles.footerHint}>
            <Kbd>↵</Kbd> Select
          </span>
          {canSubmitFreeText ? (
            <button
              type="button"
              className={styles.footerAction}
              onClick={submitFreeText}
            >
              <Kbd>Tab</Kbd> {freeTextLabel}
            </button>
          ) : (
            <span className={styles.footerHint}>
              <Kbd>Tab</Kbd> Sections
            </span>
          )}
          {onShowShortcuts !== undefined ? (
            <button
              type="button"
              className={styles.footerButton}
              onClick={onShowShortcuts}
            >
              <Kbd>?</Kbd> Shortcuts
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The "?" sheet: every shortcut, grouped, in the palette's frame. */
export function ShortcutSheet({
  groups,
  onClose,
}: ShortcutSheetProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(panelRef, true);
  useScrollLock(useMediaQuery(PHONE_QUERY));

  return (
    <div className={styles.layer}>
      <div className={styles.scrim} aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(styles.panel, styles.sheet)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (panelRef.current !== null) trapTab(event, panelRef.current);
        }}
      >
        <div className={styles.sheetHead}>
          <h2 id={titleId} className={styles.sheetTitle}>
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            className={styles.escButton}
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <Kbd>Esc</Kbd>
          </button>
        </div>
        <div className={styles.sheetBody}>
          {groups.map((group) => (
            <section key={group.title} className={styles.sheetGroup}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div key={row.label} className={styles.sheetRow}>
                    <dt className={styles.sheetLabel}>{row.label}</dt>
                    <dd className={styles.sheetKeys}>
                      <KbdKeys keys={row.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const PaletteContext = createContext<CommandPaletteApi | null>(null);

/** The palette API; throws outside a CommandPaletteProvider. */
export function useCommandPalette(): CommandPaletteApi {
  const api = useContext(PaletteContext);
  if (api === null) {
    throw new Error(
      'useCommandPalette() must be used inside <CommandPaletteProvider>.'
    );
  }
  return api;
}

/** The palette API, or null without a provider (the shell's optional use). */
export function useOptionalCommandPalette(): CommandPaletteApi | null {
  return useContext(PaletteContext);
}

type LoadState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'error'; message: string };

/**
 * Owns the palette: open state, the lazy loadItems() fetch (once, on first
 * open), the global keys (Ctrl/⌘ K anywhere; "?" and the items' one- and
 * two-key shortcuts when not typing and no modal is open) and the "?"
 * sheet. Renders children plus the open overlay.
 */
export function CommandPaletteProvider({
  items,
  loadItems,
  sectionOrder,
  navigate,
  shortcutGroups,
  placeholder,
  maxPerSection,
  refuseQuery,
  onSubmitFreeText,
  freeTextLabel,
  children,
}: CommandPaletteProviderProps): ReactNode {
  const [view, setView] = useState<PaletteView | null>(null);
  const [loaded, setLoaded] = useState<PaletteItem[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [registered, setRegistered] = useState<
    { id: number; group: ShortcutGroup }[]
  >([]);
  const loadStarted = useRef(false);
  const nextGroupId = useRef(0);
  // The first key of a two-key shortcut waiting for its second (G of G W),
  // and when it was pressed. Read by isSequencePending().
  const sequence = useRef<{ key: string; at: number } | null>(null);
  const mod = useModKeyLabel();

  const allItems = useMemo(
    () => mergeItems(items ?? [], loaded),
    [items, loaded]
  );

  const startLoad = useCallback(() => {
    if (loadItems === undefined) return;
    loadStarted.current = true;
    setLoad({ status: 'loading' });
    void loadItems().then(
      (result) => {
        setLoaded(result);
        setLoad({ status: 'ready' });
      },
      (error: unknown) => {
        setLoad({
          status: 'error',
          message:
            error instanceof Error && error.message !== ''
              ? error.message
              : 'The results could not be loaded.',
        });
      }
    );
  }, [loadItems]);

  const open = useCallback(() => {
    setView('palette');
    if (!loadStarted.current) startLoad();
  }, [startLoad]);
  const close = useCallback(() => setView(null), []);
  const openShortcuts = useCallback(() => setView('shortcuts'), []);
  const toggle = useCallback(() => {
    setView((current) => (current === 'palette' ? null : 'palette'));
    if (!loadStarted.current) startLoad();
  }, [startLoad]);

  const registerShortcutGroup = useCallback((group: ShortcutGroup) => {
    nextGroupId.current += 1;
    const id = nextGroupId.current;
    setRegistered((list) => [...list, { id, group }]);
    return () => setRegistered((list) => list.filter((r) => r.id !== id));
  }, []);

  const runItem = useCallback(
    (item: PaletteItem) => {
      setView(null);
      if (item.onSelect !== undefined) item.onSelect();
      else if (item.href !== undefined)
        (navigate ?? defaultNavigate)(item.href);
    },
    [navigate]
  );

  // Free text runs like an item: the palette closes, then the host acts.
  const submitFreeText = useMemo(
    () =>
      onSubmitFreeText === undefined
        ? undefined
        : (query: string) => {
            setView(null);
            onSubmitFreeText(query);
          },
    [onSubmitFreeText]
  );

  // Shortcut lookup: "g w" → item, plus the set of keys that start a
  // two-key sequence (so the first key waits for the second).
  const shortcuts = useMemo(() => {
    const byCode = new Map<string, PaletteItem>();
    const firsts = new Set<string>();
    for (const item of allItems) {
      const code = shortcutCode(item.shortcut);
      if (code === null || byCode.has(code)) continue;
      byCode.set(code, item);
      const space = code.indexOf(' ');
      if (space > 0) firsts.add(code.slice(0, space));
    }
    return { byCode, firsts };
  }, [allItems]);

  // The document listener is bound once; it reads the latest state here.
  const latest = useRef({ view, shortcuts, runItem, toggle, openShortcuts });
  useEffect(() => {
    latest.current = { view, shortcuts, runItem, toggle, openShortcuts };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const state = latest.current;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'k') {
        event.preventDefault();
        sequence.current = null;
        state.toggle();
        return;
      }
      if (state.view !== null) return;
      if (['shift', 'control', 'meta', 'alt'].includes(key)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) {
        sequence.current = null;
        return;
      }
      if (isTypingTarget(event.target) || modalIsOpen()) {
        sequence.current = null;
        return;
      }
      if (key === '?') {
        event.preventDefault();
        sequence.current = null;
        state.openShortcuts();
        return;
      }
      const { byCode, firsts } = state.shortcuts;
      const pending = sequence.current;
      if (pending !== null && Date.now() - pending.at < SEQUENCE_MS) {
        const hit = byCode.get(`${pending.key} ${key}`);
        sequence.current = null;
        if (hit !== undefined) {
          event.preventDefault();
          state.runItem(hit);
          return;
        }
      }
      if (firsts.has(key)) {
        sequence.current = { key, at: Date.now() };
        return;
      }
      sequence.current = null;
      const single = byCode.get(key);
      if (single !== undefined) {
        event.preventDefault();
        state.runItem(single);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const sheetGroups = useMemo(() => {
    const general: ShortcutGroup = {
      title: 'General',
      rows: [
        { label: 'Open the command palette', keys: [mod, 'K'] },
        { label: 'Show keyboard shortcuts', keys: ['?'] },
        { label: 'Close a panel or dialog', keys: ['Esc'] },
        { label: 'Next section in the palette', keys: ['Tab'] },
      ],
    };
    const fromItems = new Map<string, ShortcutGroup>();
    for (const item of allItems) {
      if (item.shortcut === undefined || item.shortcut.length === 0) continue;
      let group = fromItems.get(item.section);
      if (group === undefined) {
        group = { title: item.section, rows: [] };
        fromItems.set(item.section, group);
      }
      group.rows.push({ label: item.label, keys: item.shortcut });
    }
    return [
      general,
      ...registered.map((r) => r.group),
      ...fromItems.values(),
      ...(shortcutGroups ?? []),
    ];
  }, [mod, allItems, registered, shortcutGroups]);

  const isSequencePending = useCallback(() => {
    const pending = sequence.current;
    return pending !== null && Date.now() - pending.at < SEQUENCE_MS;
  }, []);

  const api = useMemo<CommandPaletteApi>(
    () => ({
      view,
      open,
      openShortcuts,
      close,
      toggle,
      registerShortcutGroup,
      isSequencePending,
    }),
    [
      view,
      open,
      openShortcuts,
      close,
      toggle,
      registerShortcutGroup,
      isSequencePending,
    ]
  );

  return (
    <PaletteContext.Provider value={api}>
      {children}
      {view === 'palette' ? (
        <CommandPalette
          items={allItems}
          onClose={close}
          onRun={runItem}
          loading={load.status === 'loading'}
          error={load.status === 'error' ? load.message : null}
          onRetry={startLoad}
          onShowShortcuts={openShortcuts}
          placeholder={placeholder}
          sectionOrder={sectionOrder}
          maxPerSection={maxPerSection}
          refuseQuery={refuseQuery}
          onSubmitFreeText={submitFreeText}
          freeTextLabel={freeTextLabel}
        />
      ) : null}
      {view === 'shortcuts' ? (
        <ShortcutSheet groups={sheetGroups} onClose={close} />
      ) : null}
    </PaletteContext.Provider>
  );
}
