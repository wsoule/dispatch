import { ApiError, type RunState } from '@dispatch/client';
import type { Assignee, Priority, TaskListItem } from '@dispatch/core/browser';
import {
  Activity,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Milestone,
  SignalHigh,
  Sparkles,
  Tag,
  Target,
  User,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  facetLabel,
  FILTER_FACETS,
  FILTER_NONE,
  type FilterFacet,
  filterValueLabel,
  setDateFilter,
  type TaskFilterSet,
  toggleFilterValue,
} from '../../lib/taskFilters';
import { AssigneeAvatar } from './AssigneeAvatar';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { IconButton } from '@/ui/ai/icon-button';
import { FilterIconButton } from '@/ui/ai/page-header';
import { Input } from '@/ui/input';
import { Kbd } from '@/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Spinner } from '@/ui/spinner';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const ASSIGNEES: Assignee[] = ['agent', 'human', 'none'];
const RUN_STATES: (RunState | typeof FILTER_NONE)[] = [
  'running',
  'provisioning',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
  FILTER_NONE,
];

const FACET_ICON: Record<FilterFacet, ReactNode> = {
  status: <CircleDot aria-hidden />,
  priority: <SignalHigh aria-hidden />,
  assignee: <User aria-hidden />,
  labels: <Tag aria-hidden />,
  epic: <Milestone aria-hidden />,
  milestone: <Target aria-hidden />,
  run: <Activity aria-hidden />,
  created: <Calendar aria-hidden />,
  updated: <Calendar aria-hidden />,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// The Dates facets take one bound; these are the quick picks a menu can offer without a
// date input. `days` ago from now, `before` or `after`.
const DATE_PICKS: { label: string; op: 'before' | 'after'; days: number }[] = [
  { label: 'In the last day', op: 'after', days: 1 },
  { label: 'In the last week', op: 'after', days: 7 },
  { label: 'In the last month', op: 'after', days: 30 },
  { label: 'More than a week ago', op: 'before', days: 7 },
  { label: 'More than a month ago', op: 'before', days: 30 },
];

// One menu row: 32px, 14px icon, 13px label, trailing chevron/check.
const ROW_CLASS =
  'flex h-8 w-full cursor-default items-center gap-2 rounded-control px-2 text-left text-[13px] outline-none hover:bg-surface-hover focus-visible:bg-surface-hover [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5 [&_svg:not([class*=text-])]:text-muted-foreground';

export interface FilterMenuContext {
  /** The project's statuses in config order. */
  statuses: readonly string[];
  epics: readonly TaskListItem[];
  /** Every label in use, sorted. */
  labels: readonly string[];
  /** Every milestone name in use, sorted. */
  milestones: readonly string[];
}

export interface FilterMenuProps {
  filters: TaskFilterSet;
  onChange: (filters: TaskFilterSet) => void;
  context: FilterMenuContext;
  /** Controlled open state, so `f` on the list can open it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Turns a typed sentence into a filter set (the daemon's AI filter). When absent the
   * `AI filter` row is not rendered and the menu is unchanged. */
  onAiFilter?: (sentence: string) => Promise<TaskFilterSet>;
}

interface FacetOption {
  value: string;
  label: string;
  glyph?: ReactNode;
}

// Every value a facet can filter on, from the project's own vocabulary.
function optionsFor(facet: FilterFacet, ctx: FilterMenuContext): FacetOption[] {
  switch (facet) {
    case 'status':
      return ctx.statuses.map((s) => ({
        value: s,
        label: filterValueLabel('status', s),
        glyph: <StatusIcon status={s} />,
      }));
    case 'priority':
      return PRIORITIES.map((p) => ({
        value: p,
        label: filterValueLabel('priority', p),
        glyph: <PriorityIcon priority={p} />,
      }));
    case 'assignee':
      return ASSIGNEES.map((a) => ({
        value: a,
        label: filterValueLabel('assignee', a),
        glyph: <AssigneeAvatar assignee={a} size={16} />,
      }));
    case 'labels':
      return ctx.labels.map((l) => ({ value: l, label: l }));
    case 'epic':
      return [
        { value: FILTER_NONE, label: 'No epic' },
        ...ctx.epics.map((e) => ({ value: e.meta.id, label: e.meta.title })),
      ];
    case 'milestone':
      return [
        { value: FILTER_NONE, label: 'No milestone' },
        ...ctx.milestones.map((m) => ({ value: m, label: m })),
      ];
    case 'run':
      return RUN_STATES.map((s) => ({
        value: s,
        label: filterValueLabel('run', s),
      }));
    case 'created':
    case 'updated':
      return DATE_PICKS.map((pick) => ({
        value: `${pick.op}:${pick.days}`,
        label: pick.label,
      }));
  }
}

function matches(query: string, text: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

const AI_FILTER_LABEL = 'AI filter';

// What the AI subview shows under its input when the daemon says no: an old daemon has no
// route (404), anything else carries its own message.
function aiFilterErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'Update the daemon to use AI filters';
  }
  return err instanceof Error && err.message !== ''
    ? err.message
    : 'AI filter failed';
}

// The arrow-key roving a `role="menu"` promises: ArrowDown/ArrowUp move focus between the
// menu's items (wrapping), Home/End jump to the ends. Tab still leaves the menu.
function moveMenuFocus(e: KeyboardEvent<HTMLElement>) {
  const step =
    e.key === 'ArrowDown'
      ? 1
      : e.key === 'ArrowUp'
        ? -1
        : e.key === 'Home' || e.key === 'End'
          ? 0
          : null;
  if (step === null) return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')
  );
  if (items.length === 0) return;
  e.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (current + step + items.length) % items.length;
  items[next]?.focus();
}

/**
 * Linear's Filter menu (§7) off the header's funnel (or `f`): a 180px popover with an
 * `Add filter…` search, then one row per facet — Status, Priority, Assignee, Labels, Epic,
 * Milestone, Run state, Created, Updated — each opening its values (a `▸` drill-in rather
 * than a hover submenu, so it works the same from the keyboard). Picking a value toggles it
 * into the facet's clause; the applied clauses render as chips under the header
 * (`AppliedFilters`). Typing searches facets and their values together. With `onAiFilter`
 * an `AI filter` row sits first: a sentence typed there becomes clauses the same way.
 */
export function FilterMenu({
  filters,
  onChange,
  context,
  open,
  onOpenChange,
  onAiFilter,
}: FilterMenuProps) {
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<FilterFacet | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [sentence, setSentence] = useState('');
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Mirrors the popover's open state when nobody controls it, so applying an AI filter can
  // close the menu either way.
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  const inputRef = useRef<HTMLInputElement>(null);
  // One AI call in flight at a time: a result that lands after the subview closed, or after
  // a newer submit, is ignored rather than applied over what the user did since.
  const aiCallRef = useRef(0);
  const active = filters.clauses.length > 0;

  // Reopening starts at the facet list with an empty search.
  useEffect(() => {
    if (!isOpen) {
      aiCallRef.current += 1;
      setQuery('');
      setFacet(null);
      setAiMode(false);
      setSentence('');
      setAiPending(false);
      setAiError(null);
    }
  }, [isOpen]);

  // The subview's input mounts after the popover's `initialFocus` already ran, so it takes
  // focus itself.
  useEffect(() => {
    if (aiMode) inputRef.current?.focus();
  }, [aiMode]);

  function leaveAi() {
    aiCallRef.current += 1;
    setAiMode(false);
    setSentence('');
    setAiPending(false);
    setAiError(null);
  }

  async function submitAi() {
    if (onAiFilter === undefined || sentence.trim() === '') return;
    const call = ++aiCallRef.current;
    setAiPending(true);
    setAiError(null);
    try {
      const result = await onAiFilter(sentence.trim());
      if (call !== aiCallRef.current) return;
      // No clauses is the model's "cannot express that" answer: keep the sentence editable
      // rather than wiping the chips already applied.
      if (result.clauses.length === 0) {
        setAiPending(false);
        setAiError('No filter matched that sentence');
        return;
      }
      onChange(result);
      leaveAi();
      setInnerOpen(false);
      onOpenChange?.(false);
    } catch (err) {
      if (call !== aiCallRef.current) return;
      setAiPending(false);
      setAiError(aiFilterErrorText(err));
    }
  }

  const clauseFor = (f: FilterFacet) =>
    filters.clauses.find((c) => c.facet === f);
  const selectedValues = (f: FilterFacet): ReadonlySet<string> =>
    new Set(clauseFor(f)?.values ?? []);
  // A date pick stores a resolved ISO bound, so its row can't match on value: the checked
  // row is the pick with the clause's operator whose `days` is nearest to how old that
  // bound is now (the bound was "now minus `days`" when it was picked).
  const pickedDateValue = (f: 'created' | 'updated'): string | null => {
    const clause = clauseFor(f);
    const bound = Date.parse(clause?.values[0] ?? '');
    if (clause === undefined || Number.isNaN(bound)) return null;
    const ageDays = (Date.now() - bound) / DAY_MS;
    const nearest = DATE_PICKS.filter((pick) => pick.op === clause.op).sort(
      (a, b) => Math.abs(a.days - ageDays) - Math.abs(b.days - ageDays)
    )[0];
    return nearest === undefined ? null : `${nearest.op}:${nearest.days}`;
  };
  const isPicked = (f: FilterFacet, value: string): boolean =>
    f === 'created' || f === 'updated'
      ? pickedDateValue(f) === value
      : selectedValues(f).has(value);

  function pick(f: FilterFacet, value: string) {
    if (f === 'created' || f === 'updated') {
      const [op, days] = value.split(':');
      const bound = new Date(Date.now() - Number(days) * DAY_MS).toISOString();
      onChange(
        setDateFilter(filters, f, op === 'before' ? 'before' : 'after', bound)
      );
      return;
    }
    onChange(toggleFilterValue(filters, f, value));
  }

  // Search results: facets whose name matches, then values across every facet.
  const searchRows = useMemo(() => {
    if (query.trim() === '') return null;
    const ai = onAiFilter !== undefined && matches(query, AI_FILTER_LABEL);
    const facets = FILTER_FACETS.filter((f) => matches(query, facetLabel(f)));
    const values = FILTER_FACETS.flatMap((f) =>
      optionsFor(f, context)
        .filter((o) => matches(query, o.label))
        .map((o) => ({ facet: f, option: o }))
    );
    return { ai, facets, values };
  }, [query, context, onAiFilter]);

  const optionRow = (f: FilterFacet, option: FacetOption, crumb: boolean) => {
    const selected = isPicked(f, option.value);
    return (
      <button
        key={`${f}:${option.value}`}
        type="button"
        role="menuitemcheckbox"
        aria-checked={selected}
        onClick={() => pick(f, option.value)}
        className={ROW_CLASS}
      >
        {option.glyph ?? FACET_ICON[f]}
        <span className="min-w-0 truncate">
          {crumb && (
            <span className="text-muted-foreground">{facetLabel(f)} › </span>
          )}
          {option.label}
        </span>
        {selected && <Check className="ml-auto size-3" aria-label="Selected" />}
      </button>
    );
  };

  // Linear's first row (§7): opens the sentence subview instead of a facet.
  const aiRow =
    onAiFilter === undefined ? null : (
      <button
        key="ai"
        type="button"
        role="menuitem"
        data-facet="ai"
        onClick={() => {
          setQuery('');
          setAiMode(true);
        }}
        className={ROW_CLASS}
      >
        <Sparkles aria-hidden />
        <span className="min-w-0 flex-1 truncate">{AI_FILTER_LABEL}</span>
        <ChevronRight aria-hidden className="text-muted-foreground size-3" />
      </button>
    );

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        setInnerOpen(next);
        onOpenChange?.(next);
        if (!next) {
          setQuery('');
          setFacet(null);
          leaveAi();
        }
      }}
    >
      <PopoverTrigger render={<FilterIconButton active={active} />} />
      <PopoverContent
        align="end"
        data-slot="filter-menu"
        initialFocus={inputRef}
        className="w-[180px] p-0"
      >
        {aiMode ? (
          // Escape steps back to the facet list, the same as leaving a facet.
          <div
            data-slot="ai-filter"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              leaveAi();
            }}
          >
            <div className="shadow-hairline-bottom flex h-9 items-center gap-1 px-1">
              <IconButton label="Back to filters" onClick={leaveAi}>
                <ChevronLeft aria-hidden />
              </IconButton>
              <span className="text-muted-foreground min-w-0 truncate text-[12px] font-medium">
                {AI_FILTER_LABEL}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5">
              <div className="flex h-7 items-center gap-2">
                <Input
                  ref={inputRef}
                  variant="borderless"
                  placeholder="Describe a filter…"
                  aria-label={AI_FILTER_LABEL}
                  aria-invalid={aiError !== null || undefined}
                  value={sentence}
                  disabled={aiPending}
                  onChange={(e) => {
                    setSentence(e.target.value);
                    setAiError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || aiPending) return;
                    e.preventDefault();
                    void submitAi();
                  }}
                  className="flex-1 text-[13px]"
                />
                {aiPending ? (
                  <Spinner className="text-muted-foreground size-3.5 motion-reduce:animate-none" />
                ) : (
                  <Kbd>⏎</Kbd>
                )}
              </div>
              {aiError !== null && (
                <span
                  role="alert"
                  className="font-book text-muted-foreground text-[12px]"
                >
                  {aiError}
                </span>
              )}
            </div>
          </div>
        ) : facet === null ? (
          <>
            <div className="shadow-hairline-bottom flex h-9 items-center gap-2 px-2.5">
              <Input
                ref={inputRef}
                variant="borderless"
                placeholder="Add filter…"
                aria-label="Add filter"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || searchRows === null) return;
                  if (searchRows.facets.length === 1) {
                    e.preventDefault();
                    setFacet(searchRows.facets[0]);
                    setQuery('');
                  } else if (searchRows.ai && searchRows.facets.length === 0) {
                    e.preventDefault();
                    setQuery('');
                    setAiMode(true);
                  }
                }}
                className="flex-1 text-[13px]"
              />
              <Kbd>F</Kbd>
            </div>
            <div
              role="menu"
              aria-label="Filter facets"
              onKeyDown={moveMenuFocus}
              className="flex max-h-80 flex-col overflow-y-auto p-1"
            >
              {searchRows === null ? (
                <>
                  {aiRow}
                  {FILTER_FACETS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="menuitem"
                      data-facet={f}
                      onClick={() => setFacet(f)}
                      className={ROW_CLASS}
                    >
                      {FACET_ICON[f]}
                      <span className="min-w-0 flex-1 truncate">
                        {facetLabel(f)}
                      </span>
                      {selectedValues(f).size > 0 && (
                        <span className="font-book text-muted-foreground text-[11px]">
                          {selectedValues(f).size}
                        </span>
                      )}
                      <ChevronRight
                        aria-hidden
                        className="text-muted-foreground size-3"
                      />
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {searchRows.ai && aiRow}
                  {searchRows.facets.map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="menuitem"
                      data-facet={f}
                      onClick={() => {
                        setFacet(f);
                        setQuery('');
                      }}
                      className={ROW_CLASS}
                    >
                      {FACET_ICON[f]}
                      <span className="min-w-0 flex-1 truncate">
                        {facetLabel(f)}
                      </span>
                      <ChevronRight
                        aria-hidden
                        className="text-muted-foreground size-3"
                      />
                    </button>
                  ))}
                  {searchRows.values.map(({ facet: f, option }) =>
                    optionRow(f, option, true)
                  )}
                  {!searchRows.ai &&
                    searchRows.facets.length === 0 &&
                    searchRows.values.length === 0 && (
                      <span className="font-book text-muted-foreground flex h-8 items-center px-2 text-[13px]">
                        No matching filter
                      </span>
                    )}
                </>
              )}
            </div>
          </>
        ) : (
          // Escape inside a facet steps back to the facet list rather than closing the
          // popover — stopped here so the popover's own dismiss never sees it.
          <div
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              setFacet(null);
            }}
          >
            <div className="shadow-hairline-bottom flex h-9 items-center gap-1 px-1">
              <IconButton
                label="Back to filters"
                onClick={() => setFacet(null)}
              >
                <ChevronLeft aria-hidden />
              </IconButton>
              <span className="text-muted-foreground min-w-0 truncate text-[12px] font-medium">
                {facetLabel(facet)}
              </span>
            </div>
            <div
              role="menu"
              aria-label={`${facetLabel(facet)} values`}
              onKeyDown={moveMenuFocus}
              className="flex max-h-80 flex-col overflow-y-auto p-1"
            >
              {optionsFor(facet, context).length === 0 ? (
                <span className="font-book text-muted-foreground flex h-8 items-center px-2 text-[13px]">
                  Nothing to filter on
                </span>
              ) : (
                optionsFor(facet, context).map((option) =>
                  optionRow(facet, option, false)
                )
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
