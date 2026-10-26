import type { ShortcutGroup } from '@dispatch/ui';

// The "?" sheet's contents: every global, list, Live and task key, as
// @dispatch/ui's ShortcutSheet draws them. A row's keys are one shortcut
// (['G', 'L'] is G then L; [mod, 'K'] is the modifier held with K), so what
// the old dialog printed as alternates ("Move down / up" J / K) is two rows.
// Mirrors `lib/keyboard.ts` and `keyAction` (lib/appNav.ts): a chord listed
// here that the resolver does not know, or one it knows that is not listed,
// fails shortcutGroups.test.ts. `g h`, `g c` and `g a` are unlisted aliases
// of `g o`.

/** The chords of the Go to group: the second key and the place. */
export const GOTO_CHORDS: readonly { key: string; label: string }[] = [
  { key: 'O', label: 'Overseer' },
  { key: 'T', label: 'Issues' },
  { key: 'I', label: 'Needs you' },
  { key: 'F', label: 'Moving' },
  { key: 'R', label: 'Review' },
  { key: 'M', label: 'Threads' },
  { key: 'L', label: 'Timeline' },
  { key: 'G', label: 'Graph' },
  { key: 'S', label: 'Settings' },
];

/**
 * The sheet's groups, with the platform's modifier label (⌘ on a Mac, Ctrl
 * elsewhere: @dispatch/ui's useModKeyLabel) in every modified shortcut, so
 * ⌘ is never shown on Linux or Windows. Pure: built once per label.
 */
export function buildShortcutGroups(mod: string): ShortcutGroup[] {
  return [
    {
      title: 'Shell',
      rows: [
        { label: 'Command menu', keys: [mod, 'K'] },
        { label: 'New task', keys: ['C'] },
        { label: 'Drop a thought', keys: [mod, 'D'] },
        { label: 'Keyboard shortcuts', keys: ['?'] },
        { label: 'Close / back out', keys: ['Esc'] },
      ],
    },
    {
      title: 'Go to',
      rows: [
        ...GOTO_CHORDS.map(({ key, label }) => ({ label, keys: ['G', key] })),
        // The modified ones work from a text field too.
        { label: 'Overseer, from anywhere', keys: [mod, '1'] },
        { label: 'Issues, from anywhere', keys: [mod, '2'] },
        { label: 'Presets, in chip order', keys: [mod, '3–9'] },
        { label: 'Back', keys: [mod, '['] },
        { label: 'Forward', keys: [mod, ']'] },
      ],
    },
    {
      title: 'View',
      rows: [
        { label: 'Zoom in', keys: [mod, '+'] },
        { label: 'Zoom out', keys: [mod, '−'] },
        { label: 'Reset zoom', keys: [mod, '0'] },
      ],
    },
    {
      title: 'List',
      rows: [
        { label: 'Move down', keys: ['J'] },
        { label: 'Move up', keys: ['K'] },
        { label: 'Open', keys: ['O'] },
        { label: 'Peek', keys: ['Space'] },
        { label: 'Select', keys: ['X'] },
        { label: 'Clear selection', keys: ['Esc'] },
        { label: 'Filter', keys: ['F'] },
        { label: 'Display', keys: ['⇧', 'V'] },
      ],
    },
    {
      title: 'Live',
      rows: [
        { label: 'Next node', keys: ['J'] },
        { label: 'Previous node', keys: ['K'] },
        { label: 'Next band', keys: ['⇧', 'J'] },
        { label: 'Previous band', keys: ['⇧', 'K'] },
        { label: 'Column left', keys: ['H'] },
        { label: 'Column right', keys: ['L'] },
      ],
    },
    {
      title: 'Task',
      rows: [
        { label: 'Status', keys: ['S'] },
        { label: 'Priority', keys: ['P'] },
        { label: 'Assignee', keys: ['A'] },
        { label: 'Labels', keys: ['L'] },
        { label: 'Epic', keys: ['E'] },
        { label: 'Milestone', keys: ['M'] },
        { label: 'Dispatch', keys: ['D'] },
      ],
    },
  ];
}
