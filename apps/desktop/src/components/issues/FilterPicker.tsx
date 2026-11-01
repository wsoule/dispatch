import { statusType } from '@dispatch-foo/core/browser';
import {
  Button,
  cx,
  Kbd,
  type PickerMark,
  type PickerOption,
  PickerPopover,
  Popover,
  Spinner,
} from '@dispatch/ui';
import {
  Activity,
  Calendar,
  ChevronLeft,
  CircleDot,
  ListFilter,
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
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { toTaskPriority } from '../../adapters/rows';
import { useActiveStatusModel } from '../../lib/statusModel';
import {
  aiFilterErrorText,
  applyDatePick,
  facetLabel,
  FILTER_FACETS,
  type FilterFacet,
  type FilterOption,
  type FilterOptionMark,
  type FilterPickerContext,
  isDateFacet,
  matches,
  optionsFor,
  pickedDateValue,
  selectedCount,
  type TaskFilterSet,
  toggleFilterValue,
} from '../../lib/taskFilters';
import styles from './FilterPicker.module.css';

// A lucide glyph at the system's size: 14px, 1.8 stroke, hidden from assistive tech.
function icon(Glyph: typeof CircleDot): ReactNode {
  return <Glyph size={14} strokeWidth={1.8} aria-hidden />;
}

const FACET_ICON: Record<FilterFacet, ReactNode> = {
  status: icon(CircleDot),
  priority: icon(SignalHigh),
  assignee: icon(User),
  labels: icon(Tag),
  milestone: icon(Target),
  run: icon(Activity),
  created: icon(Calendar),
  updated: icon(Calendar),
};

const AI_FILTER_LABEL = 'AI filter';
const BACK_LABEL = 'Back to filters';
const FACETS_LABEL = 'Filter facets';

// The picker's option values. One list can mix steps (a facet), actions (the AI filter,
// Back) and values of any facet (search results), so each kind has its own prefix; a value
// is `v:<facet>:<value>` (the facet never holds a colon, the value may).
const AI_KEY = 'ai';
const BACK_KEY = 'back';
const FACET_PREFIX = 'facet:';
const VALUE_PREFIX = 'v:';

function facetKey(facet: FilterFacet): string {
  return `${FACET_PREFIX}${facet}`;
}

function valueKeyOf(facet: FilterFacet, value: string): string {
  return `${VALUE_PREFIX}${facet}:${value}`;
}

// What a picked option value stands for, read back from its prefix.
type PickedKey =
  | { kind: 'ai' }
  | { kind: 'back' }
  | { kind: 'facet'; facet: FilterFacet }
  | { kind: 'value'; facet: FilterFacet; value: string };

function readKey(key: string): PickedKey | null {
  if (key === AI_KEY) return { kind: 'ai' };
  if (key === BACK_KEY) return { kind: 'back' };
  if (key.startsWith(FACET_PREFIX)) {
    const facet = FILTER_FACETS.find(
      (f) => f === key.slice(FACET_PREFIX.length)
    );
    return facet === undefined ? null : { kind: 'facet', facet };
  }
  if (!key.startsWith(VALUE_PREFIX)) return null;
  const rest = key.slice(VALUE_PREFIX.length);
  const split = rest.indexOf(':');
  const facet = FILTER_FACETS.find((f) => f === rest.slice(0, split));
  return facet === undefined || split < 0
    ? null
    : { kind: 'value', facet, value: rest.slice(split + 1) };
}

/**
 * The next chosen list after a toggle, for the multiple-mode picker. A date value replaces
 * the facet's other pick, and re-picking it leaves the list as it is (a date facet holds one
 * bound; resolveToggle refreshes that bound itself); anything else (a value, or a step such
 * as a facet or Back, which the host acts on) is added or removed.
 */
function nextChosen(current: readonly string[], toggled: string): string[] {
  const picked = readKey(toggled);
  if (picked?.kind === 'value' && isDateFacet(picked.facet)) {
    if (current.includes(toggled)) return [...current];
    const sibling = `${VALUE_PREFIX}${picked.facet}:`;
    return [...current.filter((k) => !k.startsWith(sibling)), toggled];
  }
  return current.includes(toggled)
    ? current.filter((k) => k !== toggled)
    : [...current, toggled];
}

export interface FilterPickerProps {
  filters: TaskFilterSet;
  onChange: (filters: TaskFilterSet) => void;
  context: FilterPickerContext;
  /** Controlled from IssuesView, so `f` on the list or the board opens it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Turns a typed sentence into a filter set (the daemon's AI filter). When absent the
   * `AI filter` option is not listed. */
  onAiFilter?: (sentence: string) => Promise<TaskFilterSet>;
}

/**
 * Linear's Filter menu (§7) off the toolbar's funnel (or `f`), as a two-step PickerPopover.
 * Step one (an `Add filter` search box over the `Filter facets` list, with the F keycap)
 * lists `AI filter` (with `onAiFilter`) and the facets (Status, Priority, Assignee, Labels,
 * Milestone, Run state, Created, Updated) with their chosen counts; typing searches
 * the facets and every facet's values together, and Enter on a single facet match opens it.
 * Step two lists `Back to filters` and the facet's values under the facet's name: enums and
 * labels toggle and stay open, a date facet keeps one quick pick (picking it again refreshes
 * its bound to now). While a search is typed Back steps aside, so Enter takes the first
 * match. Escape in step two goes back to step one; a second Escape closes and returns focus
 * to the trigger. `AI filter` swaps the
 * picker for a Popover on the same trigger holding a sentence input; Enter sends it, and the
 * clauses it comes back with replace the set.
 */
export function FilterPicker({
  filters,
  onChange,
  context,
  open,
  onOpenChange,
  onAiFilter,
}: FilterPickerProps) {
  const statusModel = useActiveStatusModel();
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<FilterFacet | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [sentence, setSentence] = useState('');
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // One AI call in flight at a time: a result that lands after the AI popover closed, or
  // after a newer submit, is ignored rather than applied over what the user did since.
  const aiCallRef = useRef(0);
  // The option the picker toggled last (recorded by `resolveToggle`, read by `onChange`):
  // the picker hands back the whole chosen list, and a step such as a facet or Back must be
  // acted on once, not every time it is still in an optimistic copy of that list.
  const toggledRef = useRef<string | null>(null);
  // The AI popover hangs off the picker's own trigger button, found by its id.
  const triggerId = useId();
  const anchorRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return document.getElementById(triggerId);
      },
    }),
    [triggerId]
  );
  const active = filters.clauses.length > 0;

  // Reopening starts at the facet list with an empty search.
  useEffect(() => {
    if (open) return;
    aiCallRef.current += 1;
    setQuery('');
    setFacet(null);
    setAiMode(false);
    setSentence('');
    setAiPending(false);
    setAiError(null);
  }, [open]);

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
      onOpenChange(false);
    } catch (err) {
      if (call !== aiCallRef.current) return;
      setAiPending(false);
      setAiError(aiFilterErrorText(err));
    }
  }

  // Every chosen value as an option key: what the list marks as chosen.
  const now = Date.now();
  const chosenKeys = (f: FilterFacet): string[] => {
    if (isDateFacet(f)) {
      const picked = pickedDateValue(filters, f, now);
      return picked === null ? [] : [valueKeyOf(f, picked)];
    }
    const clause = filters.clauses.find((c) => c.facet === f);
    return (clause?.values ?? []).map((v) => valueKeyOf(f, v));
  };

  const markFor = (f: FilterFacet, mark: FilterOptionMark | undefined) => {
    if (mark === undefined) {
      return { kind: 'node', node: FACET_ICON[f] } satisfies PickerMark;
    }
    switch (mark.kind) {
      case 'state':
        return {
          kind: 'state',
          state: statusType(mark.status, statusModel),
        } satisfies PickerMark;
      case 'priority':
        return {
          kind: 'priority',
          priority: toTaskPriority(mark.priority),
        } satisfies PickerMark;
      case 'avatar':
        return { kind: 'avatar', name: mark.name } satisfies PickerMark;
    }
  };

  const valueOption = (
    f: FilterFacet,
    option: FilterOption,
    crumb: boolean
  ): PickerOption => ({
    value: valueKeyOf(f, option.value),
    label: crumb ? `${facetLabel(f)} › ${option.label}` : option.label,
    mark: markFor(f, option.mark),
  });

  const facetOption = (f: FilterFacet): PickerOption => {
    const count = selectedCount(filters, f);
    return {
      value: facetKey(f),
      label: facetLabel(f),
      mark: { kind: 'node', node: FACET_ICON[f] },
      hint: count > 0 ? String(count) : undefined,
      keepOpen: true,
    };
  };

  const aiOption: PickerOption = {
    value: AI_KEY,
    label: AI_FILTER_LABEL,
    mark: { kind: 'node', node: icon(Sparkles) },
    keepOpen: true,
  };

  // Step one: the facets (AI filter first), or the search's matches: facets, then the AI
  // filter, then values across every facet. A single matching facet leads, so Enter opens it.
  function stepOneOptions(): PickerOption[] {
    if (query.trim() === '') {
      return [
        ...(onAiFilter === undefined ? [] : [aiOption]),
        ...FILTER_FACETS.map(facetOption),
      ];
    }
    const facets = FILTER_FACETS.filter((f) => matches(query, facetLabel(f)));
    const ai = onAiFilter !== undefined && matches(query, AI_FILTER_LABEL);
    const values = FILTER_FACETS.flatMap((f) =>
      optionsFor(f, context)
        .filter((o) => matches(query, o.label))
        .map((o) => valueOption(f, o, true))
    );
    return [...facets.map(facetOption), ...(ai ? [aiOption] : []), ...values];
  }

  // Step two: Back, then the facet's values the search matches, under the facet's name (the
  // step's visible title). While a search is typed Back is left out, so Enter takes the first
  // matching value rather than going back (Escape still goes back). With nothing to pick, a
  // disabled row says why.
  function stepTwoOptions(f: FilterFacet): {
    options: PickerOption[];
    choosable: boolean;
  } {
    const searching = query.trim() !== '';
    const back: PickerOption[] = searching
      ? []
      : [
          {
            value: BACK_KEY,
            label: BACK_LABEL,
            mark: { kind: 'node', node: icon(ChevronLeft) },
            keepOpen: true,
          },
        ];
    const all = optionsFor(f, context);
    const values = all
      .filter((o) => !searching || matches(query, o.label))
      .map((o) => ({ ...valueOption(f, o, false), group: facetLabel(f) }));
    if (values.length > 0) {
      return { options: [...back, ...values], choosable: true };
    }
    const reason =
      all.length === 0 ? 'Nothing to filter on' : 'No matching filter';
    return {
      options: [...back, { value: 'empty', label: reason, disabled: true }],
      choosable: false,
    };
  }

  // Acts on one picked option: opens the AI filter or a facet, goes back, or applies a
  // value (a toggle, or a date facet's quick pick, which replaces the bound).
  function act(key: string) {
    const picked = readKey(key);
    if (picked === null) return;
    switch (picked.kind) {
      case 'ai':
        setQuery('');
        setFacet(null);
        setAiMode(true);
        return;
      case 'back':
        setQuery('');
        setFacet(null);
        return;
      case 'facet':
        setQuery('');
        setFacet(picked.facet);
        return;
      case 'value':
        onChange(
          isDateFacet(picked.facet)
            ? applyDatePick(filters, picked.facet, picked.value, Date.now())
            : toggleFilterValue(filters, picked.facet, picked.value)
        );
        return;
    }
  }

  // Records the toggled option for onPickList. A date pick already chosen changes no list, so
  // the picker saves nothing: it is applied here instead, which refreshes its bound to now
  // (a pick made yesterday as "In the last day" means today's last day again).
  function resolveToggle(current: readonly string[], toggled: string) {
    const picked = readKey(toggled);
    if (
      picked?.kind === 'value' &&
      isDateFacet(picked.facet) &&
      current.includes(toggled)
    ) {
      toggledRef.current = null;
      act(toggled);
      return [...current];
    }
    toggledRef.current = toggled;
    return nextChosen(current, toggled);
  }

  function onPickList() {
    const key = toggledRef.current;
    toggledRef.current = null;
    if (key !== null) act(key);
  }

  // Escape in step two goes back to the facets instead of closing. Caught on the way down,
  // before the picker's own Escape (which closes it) sees it.
  function onKeyDownCapture(event: KeyboardEvent<HTMLSpanElement>) {
    if (
      facet === null ||
      event.key !== 'Escape' ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setQuery('');
    setFacet(null);
  }

  const trigger = (
    <span
      className={styles.face}
      data-active={active ? 'true' : undefined}
      data-slot="filter-trigger"
    >
      <ListFilter size={14} strokeWidth={1.8} aria-hidden />
      {active ? <span className={styles.dot} aria-hidden /> : null}
    </span>
  );

  const shared = {
    id: triggerId,
    'data-slot': 'filter-menu',
    appearance: 'quiet',
    align: 'end',
    trigger,
    triggerLabel: 'Filter',
    shortcut: 'F',
    open: open && !aiMode,
    onOpenChange: (next: boolean) => {
      // The trigger pressed while the AI filter is open closes everything (a toggle).
      onOpenChange(next && !aiMode);
    },
    query,
    onQueryChange: setQuery,
    filter: false,
    className: styles.picker,
  } as const;

  let picker: ReactNode;
  if (facet === null) {
    picker = (
      <PickerPopover
        {...shared}
        multiple
        marks="tick"
        label={FACETS_LABEL}
        searchLabel="Add filter"
        searchPlaceholder="Add filter…"
        emptyLabel="No matching filter"
        options={stepOneOptions()}
        value={FILTER_FACETS.flatMap(chosenKeys)}
        resolveToggle={resolveToggle}
        onChange={onPickList}
      />
    );
  } else {
    const { options, choosable } = stepTwoOptions(facet);
    const label = `${facetLabel(facet)} values`;
    const searchPlaceholder = `Filter ${facetLabel(facet).toLowerCase()}…`;
    picker = choosable ? (
      <PickerPopover
        {...shared}
        multiple
        marks={isDateFacet(facet) ? 'tick' : 'box'}
        label={label}
        searchPlaceholder={searchPlaceholder}
        options={options}
        value={chosenKeys(facet)}
        resolveToggle={resolveToggle}
        onChange={onPickList}
      />
    ) : (
      // Nothing to choose: a single picker, so the disabled reason row draws no box.
      <PickerPopover
        {...shared}
        label={label}
        searchPlaceholder={searchPlaceholder}
        options={options}
        value={null}
        onChange={(key) => {
          if (key !== null) act(key);
        }}
      />
    );
  }

  return (
    <span className={styles.root} onKeyDownCapture={onKeyDownCapture}>
      {picker}
      <Popover
        open={open && aiMode}
        onOpenChange={(next) => {
          // Escape is handled inside (back to the facets); an outside press, Tab or Done
          // closes the whole filter.
          if (next) return;
          leaveAi();
          onOpenChange(false);
        }}
        label={AI_FILTER_LABEL}
        anchorRef={anchorRef}
        align="end"
        initialFocus={inputRef}
        data-slot="ai-filter"
      >
        <div
          className={styles.ai}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            leaveAi();
          }}
        >
          <div className={styles.aiHead}>
            <Button
              variant="quiet"
              size="sm"
              icon={icon(ChevronLeft)}
              aria-label={BACK_LABEL}
              onClick={leaveAi}
            />
            <span className={styles.aiTitle}>{AI_FILTER_LABEL}</span>
          </div>
          <div className={styles.aiRow}>
            <input
              ref={inputRef}
              type="text"
              className={cx('input', styles.aiInput)}
              placeholder="Describe a filter…"
              aria-label={AI_FILTER_LABEL}
              aria-invalid={aiError !== null || undefined}
              autoComplete="off"
              value={sentence}
              // Read-only, not disabled, while the call runs: a disabled field drops focus to
              // <body>, which would lose the Escape-back path and the place to retype.
              readOnly={aiPending}
              aria-busy={aiPending || undefined}
              onChange={(event) => {
                setSentence(event.target.value);
                setAiError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || aiPending) return;
                event.preventDefault();
                void submitAi();
              }}
            />
            {aiPending ? (
              <Spinner size="sm" label="Reading the sentence" />
            ) : (
              <Kbd>⏎</Kbd>
            )}
          </div>
          {aiError !== null ? (
            <p role="alert" className={styles.aiError} data-tone="danger">
              {aiError}
            </p>
          ) : null}
        </div>
      </Popover>
    </span>
  );
}
