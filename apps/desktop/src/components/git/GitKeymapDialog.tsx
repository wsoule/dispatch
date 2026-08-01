import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';

const ENTRIES: [string, string][] = [
  ['1 .. 5', 'Focus Status / Files / Branches / Commits / Stashes'],
  ['j / k', 'Move selection down / up'],
  ['space', 'Stage or unstage the selected file'],
  ['a', 'Stage all'],
  ['c', 'Commit'],
  ['A', 'Amend the last commit'],
  ['d', 'Discard the selected change (confirms)'],
  ['b', 'New branch'],
  ['enter', 'Checkout the selected branch'],
  ['s', 'Stash'],
  ['S', 'Pop the selected stash'],
  ['f', 'Fetch'],
  ['p', 'Pull'],
  ['P', 'Push'],
  ['/', 'Filter'],
  ['?', 'Show this keymap'],
];

interface GitKeymapDialogProps {
  open: boolean;
  onClose: () => void;
}

/** The `?` keymap reference — every row here also has a button or menu item somewhere in the
 * page, listed so a keyboard-only reader can confirm that without hunting for it. */
export function GitKeymapDialog({ open, onClose }: GitKeymapDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-[12px]">
          {ENTRIES.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground font-mono">{key}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
