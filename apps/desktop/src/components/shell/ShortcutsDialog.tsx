import { Fragment } from 'react';

import {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';

interface ShortcutRow {
  label: string;
  /** Each entry is one keycap. Several entries are alternates (`J` / `K`) unless `chord`,
   * in which case they are pressed in sequence (`G` then `S`). */
  keys: string[];
  chord?: boolean;
}

interface ShortcutGroup {
  heading: string;
  rows: ShortcutRow[];
}

// The left column: the shell. The right column: a focused list row. Mirrors
// `lib/keyboard.ts` — a key listed here that the resolver doesn't know is a bug in one of
// the two.
const SHELL_GROUPS: ShortcutGroup[] = [
  {
    heading: 'Shell',
    rows: [
      { label: 'Command menu', keys: ['⌘K'] },
      { label: 'New task', keys: ['C'] },
      { label: 'Drop a thought', keys: ['⌘D'] },
      { label: 'Toggle sidebar', keys: ['['] },
      { label: 'Keyboard shortcuts', keys: ['?'] },
      { label: 'Close / back out', keys: ['Esc'] },
    ],
  },
  {
    heading: 'Go to',
    rows: [
      { label: 'Home', keys: ['G', 'H'], chord: true },
      { label: 'Inbox', keys: ['G', 'I'], chord: true },
      { label: 'Tasks', keys: ['G', 'T'], chord: true },
      { label: 'Projects', keys: ['G', 'R'], chord: true },
      { label: 'Live', keys: ['G', 'F'], chord: true },
      { label: 'Overview', keys: ['G', 'C'], chord: true },
      { label: 'Assistant', keys: ['G', 'A'], chord: true },
      { label: 'Settings', keys: ['G', 'S'], chord: true },
      { label: 'Nth rail entry', keys: ['⌘1'] },
      { label: 'Back / forward', keys: ['⌘[', '⌘]'] },
    ],
  },
  {
    heading: 'View',
    rows: [
      { label: 'Zoom in / out', keys: ['⌘+', '⌘−'] },
      { label: 'Reset zoom', keys: ['⌘0'] },
    ],
  },
];

const LIST_GROUPS: ShortcutGroup[] = [
  {
    heading: 'List',
    rows: [
      { label: 'Move down / up', keys: ['J', 'K'] },
      { label: 'Open', keys: ['O'] },
      { label: 'Peek', keys: ['Space'] },
      { label: 'Select', keys: ['X'] },
      { label: 'Clear selection', keys: ['Esc'] },
      { label: 'Filter', keys: ['F'] },
      { label: 'Display', keys: ['⇧V'] },
    ],
  },
  {
    heading: 'Home',
    rows: [
      { label: 'Change lane', keys: ['H', 'L'] },
      { label: 'Open beside', keys: ['↵'] },
      { label: 'Mine / team', keys: ['T'] },
      { label: 'Group by person', keys: ['G', 'P'], chord: true },
    ],
  },
  {
    heading: 'Live',
    rows: [
      { label: 'Next / previous node', keys: ['J', 'K'] },
      { label: 'Next / previous band', keys: ['⇧J', '⇧K'] },
      { label: 'Across columns', keys: ['H', 'L'] },
    ],
  },
  {
    heading: 'Task',
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

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The `?` reference: every global and list key, two columns of 28px rows with keycaps. */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[40rem] max-w-[calc(100vw-2rem)]"
        showCloseButton={false}
      >
        <DialogChrome>Keyboard shortcuts</DialogChrome>
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">
          Every global and list shortcut.
        </DialogDescription>
        <DialogBody className="grid grid-cols-1 gap-x-8 gap-y-4 pb-5 sm:grid-cols-2">
          <ShortcutColumn groups={SHELL_GROUPS} />
          <ShortcutColumn groups={LIST_GROUPS} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutColumn({ groups }: { groups: ShortcutGroup[] }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3 className="text-muted-foreground flex h-7 items-center text-[12px] font-medium">
            {group.heading}
          </h3>
          <dl className="flex flex-col">
            {group.rows.map((row) => (
              <div
                key={row.label}
                className="flex h-7 items-center justify-between gap-4"
              >
                <dt className="min-w-0 truncate text-[13px] text-(--text-secondary)">
                  {row.label}
                </dt>
                <dd className="flex shrink-0 items-center gap-1">
                  {row.keys.map((key, index) => (
                    <Fragment key={key}>
                      {index > 0 && (
                        <span className="text-muted-foreground text-[11px]">
                          {row.chord ? 'then' : '/'}
                        </span>
                      )}
                      <Kbd>{key}</Kbd>
                    </Fragment>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
