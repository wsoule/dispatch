import type { Note, NoteKind } from '@dispatch/client';
import {
  Bot,
  Check,
  ChevronDown,
  ListTodo,
  Sparkles,
  StickyNote,
  Trash2,
  Triangle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';

interface NotesViewProps {
  data: DispatchProjectData;
  onOpenTask: (taskId: string) => void;
}

// The four note kinds, in the order they read as a hub: triage (spotted work) and follow-ups
// (post-merge) first because those are the ones agents file and the user acts on, then personal
// todos and plain notes.
const KINDS: {
  id: NoteKind;
  label: string;
  icon: ReactNode;
  tone: string;
}[] = [
  {
    id: 'triage',
    label: 'Triage',
    icon: <Triangle className="size-4" />,
    tone: 'text-amber-500',
  },
  {
    id: 'followup',
    label: 'Follow-ups',
    icon: <Sparkles className="size-4" />,
    tone: 'text-primary',
  },
  {
    id: 'todo',
    label: 'Todos',
    icon: <ListTodo className="size-4" />,
    tone: 'text-blue-500',
  },
  {
    id: 'note',
    label: 'Notes',
    icon: <StickyNote className="size-4" />,
    tone: 'text-muted-foreground',
  },
];

const KIND_LABEL: Record<NoteKind, string> = {
  triage: 'Triage',
  followup: 'Follow-up',
  todo: 'Todo',
  note: 'Note',
};

// One note: a done checkbox, its title (struck through when done), the "an agent flagged this"
// marker, and its actions — promote into a task (unless already promoted) and delete.
function NoteRow({
  note,
  onToggleDone,
  onPromote,
  onDelete,
  onOpenTask,
}: {
  note: Note;
  onToggleDone: () => void;
  onPromote: () => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <div className="border-border/60 hover:bg-muted/40 group flex items-start gap-2.5 rounded-md border px-3 py-2 transition-colors duration-150">
      <button
        type="button"
        aria-label={note.done ? 'Mark not done' : 'Mark done'}
        onClick={onToggleDone}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
          note.done
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40 hover:border-foreground'
        )}
      >
        {note.done && <Check className="size-3" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'text-[13px]',
            note.done ? 'text-muted-foreground line-through' : 'text-foreground'
          )}
        >
          {note.title}
        </span>
        {note.body.trim() !== '' && (
          <span className="text-muted-foreground text-[12px] whitespace-pre-wrap">
            {note.body}
          </span>
        )}
        <div className="text-muted-foreground/60 flex items-center gap-2 text-[11px]">
          {note.createdByRunId !== null && (
            <span className="inline-flex items-center gap-1">
              <Bot className="size-3" />
              flagged by an agent
            </span>
          )}
          <span>{formatRelativeTimeFromIso(note.created)}</span>
          {note.linkedTaskId !== null && (
            <button
              type="button"
              onClick={() => onOpenTask(note.linkedTaskId)}
              className="text-primary font-mono"
            >
              → {note.linkedTaskId}
            </button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {note.linkedTaskId === null && (
          <Button variant="ghost" size="sm" onClick={onPromote}>
            Make task
          </Button>
        )}
        <button
          type="button"
          aria-label="Delete note"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive p-1"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The notes & triage hub — the app's home for the lightweight data that isn't a task yet:
 * triage agents flag mid-run ("this file is huge, refactor it"), follow-ups to do after a
 * merge, personal todos, and plain notes. Anything here promotes into a real task in one click.
 * Agents write here through the `dispatch_note` MCP tool; the user through the composer at top.
 */
export function NotesView({ data, onOpenTask }: NotesViewProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NoteKind>('triage');

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function add() {
    if (title.trim() === '') return;
    void data.handleCreateNote({ kind, title: title.trim() });
    setTitle('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <h1 className="view-topbar-title">Notes &amp; triage</h1>

      <div className="border-border flex items-center gap-2 rounded-lg border p-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted/60 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px]"
            >
              {KIND_LABEL[kind]}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {KINDS.map((k) => (
              <DropdownMenuItem
                key={k.id}
                onSelect={() => setKind(k.id)}
                className="gap-2 text-[13px]"
              >
                <span className={k.tone}>{k.icon}</span>
                {k.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          className="h-8 flex-1 border-transparent bg-transparent shadow-none focus-visible:ring-0"
          placeholder="Capture a triage item, follow-up, todo, or note…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <Button size="sm" disabled={title.trim() === ''} onClick={add}>
          Add
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        {data.notes.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <StickyNote className="size-6" />
            <p className="text-[13px]">
              Nothing captured yet. Agents can add triage here with the
              <code className="mx-1 font-mono">dispatch_note</code> tool.
            </p>
          </div>
        ) : (
          KINDS.map((k) => {
            const notes = data.notes.filter((n) => n.kind === k.id);
            if (notes.length === 0) return null;
            return (
              <section key={k.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className={k.tone}>{k.icon}</span>
                  <h2 className="text-foreground text-[13px] font-medium">
                    {k.label}
                  </h2>
                  <span className="text-muted-foreground bg-muted rounded-full px-1.5 text-[11px]">
                    {notes.length}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {notes.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      onToggleDone={() =>
                        void data.handleUpdateNote(note.id, {
                          done: !note.done,
                        })
                      }
                      onPromote={() => void data.handlePromoteNote(note.id)}
                      onDelete={() => void data.handleDeleteNote(note.id)}
                      onOpenTask={onOpenTask}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
