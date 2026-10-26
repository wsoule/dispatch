import type { EditLabels, PickerOption } from './types';

// Pure helpers of the edit family: default wording, the search match, the
// option grouping and the trigger's value text. Deliberately not a client
// module, so tests and server code can use them.

export const DEFAULT_EDIT_LABELS: EditLabels = {
  saving: 'Saving',
  notSaved: 'Not saved',
  saveFailed: 'Could not save.',
  search: 'Search…',
  noMatch: 'No match',
  loading: 'Loading',
  error: 'Error',
  retry: 'Retry',
  close: 'Close',
  done: 'Done',
  results: '{count} options',
  move: 'Move',
  select: 'Select',
  toggle: 'Toggle',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  clear: 'Clear',
  required: 'Cannot be empty.',
  unsaved: 'Unsaved changes · Esc again discards them',
  saveShortcut: 'saves',
};

/** Merges a host's label overrides over the defaults. */
export function editLabels(overrides?: Partial<EditLabels>): EditLabels {
  return overrides === undefined
    ? DEFAULT_EDIT_LABELS
    : { ...DEFAULT_EDIT_LABELS, ...overrides };
}

/** Lowercased text with accents folded ("Café" → "cafe"), so a search for
    "jose" finds "José". */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** The words of a search, folded; empty for a blank search. */
export function queryWords(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** True when every word of the search appears in the option's label,
    hint or keywords (in any order, anywhere in a word). */
export function optionMatches(
  option: Pick<PickerOption, 'label' | 'hint' | 'keywords'>,
  words: readonly string[]
): boolean {
  if (words.length === 0) return true;
  const hay = foldText(
    [option.label, option.hint ?? '', ...(option.keywords ?? [])].join(' ')
  );
  return words.every((word) => hay.includes(word));
}

/** The options matching `query`, in the host's order. */
export function filterOptions<T extends PickerOption>(
  options: readonly T[],
  query: string
): T[] {
  const words = queryWords(query);
  return options.filter((option) => optionMatches(option, words));
}

export interface OptionGroup<T extends PickerOption = PickerOption> {
  /** null for the options without a group (listed first). */
  heading: string | null;
  options: T[];
}

/** Buckets options by `group`: ungrouped first, then each group in the
    order it first appears. The list is drawn (and walked by the arrow
    keys) in this order. */
export function groupOptions<T extends PickerOption>(
  options: readonly T[]
): OptionGroup<T>[] {
  const loose: T[] = [];
  const groups = new Map<string, T[]>();
  for (const option of options) {
    if (option.group === undefined || option.group === '') {
      loose.push(option);
      continue;
    }
    const bucket = groups.get(option.group);
    if (bucket === undefined) groups.set(option.group, [option]);
    else bucket.push(option);
  }
  const out: OptionGroup<T>[] = [];
  if (loose.length > 0) out.push({ heading: null, options: loose });
  for (const [heading, list] of groups) out.push({ heading, options: list });
  return out;
}

/** The default toggle of a multiple picker: adds `toggled`, or removes it
    when it is already chosen. */
export function toggleValue(
  current: readonly string[],
  toggled: string
): string[] {
  return current.includes(toggled)
    ? current.filter((value) => value !== toggled)
    : [...current, toggled];
}

/** "AM" for "Ana Moreno", "D" for "dev": the first letters of the first
    and last words, by code point so an emoji or accented letter stays
    whole. The one initials helper of the package and its hosts (avatars,
    the brand tile), so a person gets the same letters everywhere. Not
    locale-sensitive (toUpperCase): the server and the browser must agree. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const last =
    words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** True for `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`: the only colours
    from data the package will paint (a label's swatch). Anything else is
    refused, so a value can never smuggle other CSS into a style
    attribute. */
export function isHexColor(color: string): boolean {
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color);
}

/** Fills a "{count}" template. */
export function withCount(template: string, count: number): string {
  return template.replace('{count}', String(count));
}
