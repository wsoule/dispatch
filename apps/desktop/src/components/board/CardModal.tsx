import { useState } from 'react';

import { agentMeta } from '../../lib/agents';
import type { Card, Session } from '../../lib/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Textarea } from '@/ui/textarea';

interface CardModalProps {
  card: Card;
  /** Sessions belonging to this card's project that no other card is linked to yet — the
   * candidate list for "link to session." Empty once every session on the project is spoken
   * for. */
  linkableSessions: Session[];
  linkedSession: Session | null;
  onClose: () => void;
  onSave: (title: string, description: string) => void;
  onDelete: () => void;
  onLinkSession: (sessionId: string) => void;
}

export function CardModal({
  card,
  linkableSessions,
  linkedSession,
  onClose,
  onSave,
  onDelete,
  onLinkSession,
}: CardModalProps) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? '');

  const dirty =
    title !== card.title || description !== (card.description ?? '');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-medium">Card</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Card title"
            className="text-[13px] font-medium"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={4}
            className="text-[13px]"
          />

          {linkedSession ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Linked session
              </span>
              <span className="text-foreground font-mono text-[12px]">
                {agentMeta(linkedSession.agent).icon}{' '}
                {linkedSession.model ?? agentMeta(linkedSession.agent).label} ·{' '}
                {linkedSession.status}
                {linkedSession.summary ? ` — ${linkedSession.summary}` : ''}
              </span>
            </div>
          ) : linkableSessions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Link to session
              </span>
              <Select onValueChange={(value) => value && onLinkSession(value)}>
                <SelectTrigger className="w-full text-[13px]">
                  <SelectValue placeholder="Choose a session…" />
                </SelectTrigger>
                <SelectContent>
                  {linkableSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {agentMeta(s.agent).icon}{' '}
                      {s.model ?? agentMeta(s.agent).label} · {s.status} ·{' '}
                      {new Date((s.started_at ?? 0) * 1000).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              Delete
            </Button>
            <Button
              size="sm"
              disabled={!dirty || title.trim() === ''}
              onClick={() => onSave(title.trim(), description.trim())}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
