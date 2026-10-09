import type { ApiClient } from '@dispatch/client';
import { useId, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';

interface NewDocDialogProps {
  client: Pick<ApiClient, 'createDoc'>;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/** A title and a Team/Personal choice: a team doc every teammate and run can
 *  read, or a personal one only its owner sees. */
// Who a new doc is for: everyone on the team, or only you.
const SCOPES = [
  ['team', 'Team', 'Every teammate and their agents'],
  ['personal', 'Personal', 'Only you'],
] as const;

export function NewDocDialog({
  client,
  open,
  onClose,
  onCreated,
}: NewDocDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<'team' | 'personal'>('team');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const name = title.trim();
    setSending(true);
    setError(null);
    try {
      const result = await client.createDoc({
        title: name,
        body: `# ${name}\n`,
        scope,
      });
      setTitle('');
      setScope('team');
      onCreated(result.doc.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New doc</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId} className="text-[13px]">
              Title
            </Label>
            <Input
              id={titleId}
              value={title}
              placeholder="Checkout v2 spec"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span id={`${titleId}-scope`} className="text-[13px] font-medium">
              Who sees it
            </span>
            <RadioGroup
              aria-labelledby={`${titleId}-scope`}
              value={scope}
              onValueChange={(value) => setScope(value as typeof scope)}
              className="flex flex-col gap-2"
            >
              {SCOPES.map(([value, label, hint]) => (
                <div key={value} className="flex items-center gap-2">
                  <Label className="font-normal">
                    <RadioGroupItem
                      value={value}
                      aria-describedby={`${titleId}-${value}`}
                    />
                    <span className="text-[13px]">{label}</span>
                  </Label>
                  <span
                    id={`${titleId}-${value}`}
                    className="text-muted-foreground text-[12px]"
                  >
                    {hint}
                  </span>
                </div>
              ))}
            </RadioGroup>
          </div>
          {error !== null && (
            <p role="alert" className="text-xs text-[var(--color-destructive)]">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={sending || title.trim() === ''}
            onClick={() => void create()}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
