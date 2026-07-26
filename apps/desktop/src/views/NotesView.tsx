import type { Note, NoteKind, PlannedTask } from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  ListTodo,
  Loader2,
  Sparkles,
  StickyNote,
  Trash2,
  Triangle,
  Wand2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { NoteDraftState } from '../lib/noteDraft';
import {
  applyNotePlanRecord,
  editNoteDraftTask,
  failNoteDraft,
  isNoteDraftPending,
  NO_NOTE_DRAFT,
  startNoteDraft,
} from '../lib/noteDraft';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Textarea } from '@/ui/textarea';

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

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/**
 * The AI-drafted task a note is about to become, shown inline under its note and editable
 * before anything is written — the same confirm-before-write contract the Plans view has,
 * because this draft comes back through the very same plan endpoint. Acceptance criteria are
 * read-only here: they are the context the draft exists to add, and editing a list in a row
 * this small would cost more than it's worth (the task is editable once it exists).
 */
function NoteDraftCard({
  tasks,
  creating,
  onEdit,
  onCreate,
  onDiscard,
}: {
  tasks: PlannedTask[];
  creating: boolean;
  onEdit: (index: number, patch: Partial<PlannedTask>) => void;
  onCreate: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="border-primary/30 bg-card animate-in fade-in-0 ml-7 flex flex-col gap-3 rounded-md border p-3 duration-150">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
        <Wand2 className="text-primary size-3" />
        Drafted task
      </div>

      {tasks.map((task, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              value={task.title}
              onChange={(e) => onEdit(i, { title: e.target.value })}
              aria-label={`Drafted task ${i + 1} title`}
              className="focus-visible:ring-ring/40 h-auto flex-1 border-none bg-transparent px-0 py-0.5 text-[13px] font-medium shadow-none focus-visible:ring-1"
            />
            <Select
              value={task.priority}
              onValueChange={(value) =>
                onEdit(i, { priority: value as Priority })
              }
            >
              <SelectTrigger
                size="sm"
                aria-label={`Drafted task ${i + 1} priority`}
                className="h-7 w-[104px] px-2 text-[12px] capitalize"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            rows={4}
            value={task.description}
            onChange={(e) => onEdit(i, { description: e.target.value })}
            aria-label={`Drafted task ${i + 1} description`}
            className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 py-0.5 text-[12px] shadow-none focus-visible:ring-1"
          />
          {task.acceptanceCriteria.length > 0 && (
            <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-4 text-[12px]">
              {task.acceptanceCriteria.map((criterion, c) => (
                <li key={c}>{criterion}</li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <div className="border-border flex items-center justify-end gap-2 border-t pt-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={creating}
        >
          Discard
        </Button>
        <Button size="sm" onClick={onCreate} disabled={creating}>
          {creating ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Creating…
            </>
          ) : (
            <>
              <Check className="size-3.5" /> Create task
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// One note: a done checkbox, its title (struck through when done), the "an agent flagged this"
// marker, and its actions — promote into a task verbatim, hand the note to an agent to draft a
// properly specified task first (unless already promoted), and delete.
function NoteRow({
  note,
  drafting,
  onToggleDone,
  onPromote,
  onDraft,
  onDelete,
  onOpenTask,
}: {
  note: Note;
  drafting: boolean;
  onToggleDone: () => void;
  onPromote: () => void;
  onDraft: () => void;
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
      <div
        className={cn(
          'flex shrink-0 items-center gap-1 transition-opacity duration-150',
          // The row's actions stay hidden until hover — except while this note's draft is
          // being written, when the spinner below is the only thing telling the user
          // anything is happening.
          drafting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        {note.linkedTaskId === null &&
          (drafting ? (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 px-2 text-[12px]">
              <Loader2 className="text-primary size-3.5 animate-spin" />
              Drafting…
            </span>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDraft}
                title="Have an agent read the codebase and draft a fuller task"
              >
                <Wand2 className="size-3.5" />
                Draft with AI
              </Button>
              <Button variant="ghost" size="sm" onClick={onPromote}>
                Make task
              </Button>
            </>
          ))}
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
 *
 * Promoting comes in two flavours: "Make task" copies the note across verbatim, while "Draft
 * with AI" sends the note to the planner, which reads the repo and proposes the fuller task
 * that one-liner was shorthand for — description, acceptance criteria, priority — shown inline
 * and editable before it is created, since a note is usually too terse to dispatch an agent on.
 */
export function NotesView({ data, onOpenTask }: NotesViewProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NoteKind>('triage');
  // The AI draft in flight, if any — one at a time, since the hook keeps a single note plan
  // slot. See lib/noteDraft.ts for the transitions.
  const [draft, setDraft] = useState<NoteDraftState>(NO_NOTE_DRAFT);
  const [creating, setCreating] = useState(false);

  const notePlanRecord = data.notePlanRecord;

  // Seeds the editable draft the moment this note's proposal is ready, and surfaces a failed
  // plan on the note's own row rather than silently leaving it spinning.
  useEffect(() => {
    setDraft((prev) => applyNotePlanRecord(prev, notePlanRecord));
  }, [notePlanRecord]);

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

  // Kicks off the agent draft for one note. Any draft already open is dropped first: the
  // hook holds a single note plan slot, so two notes can't be mid-draft at once.
  async function startDraft(noteId: string) {
    setDraft(startNoteDraft(noteId));
    try {
      await data.handleEnrichNote(noteId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraft((prev) => failNoteDraft(prev, message));
    }
  }

  function discardDraft() {
    setDraft(NO_NOTE_DRAFT);
    data.setNotePlanId(null);
  }

  async function createDraftTask() {
    if (draft.tasks === null) return;
    setCreating(true);
    try {
      await data.handleConfirmNotePlan({ tasks: draft.tasks });
      setDraft(NO_NOTE_DRAFT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDraft((prev) => failNoteDraft(prev, message));
    } finally {
      setCreating(false);
    }
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
                    <div key={note.id} className="flex flex-col gap-1">
                      <NoteRow
                        note={note}
                        drafting={isNoteDraftPending(draft, note.id)}
                        onToggleDone={() =>
                          void data.handleUpdateNote(note.id, {
                            done: !note.done,
                          })
                        }
                        onPromote={() => void data.handlePromoteNote(note.id)}
                        onDraft={() => void startDraft(note.id)}
                        onDelete={() => void data.handleDeleteNote(note.id)}
                        onOpenTask={onOpenTask}
                      />
                      {draft.noteId === note.id && draft.error !== null && (
                        <div className="border-destructive/30 bg-destructive/10 text-destructive ml-7 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px]">
                          <CircleAlert className="size-3.5 shrink-0" />
                          <span className="flex-1">
                            Drafting failed: {draft.error}
                          </span>
                          <button
                            type="button"
                            onClick={discardDraft}
                            className="underline underline-offset-2"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                      {draft.noteId === note.id && draft.tasks !== null && (
                        <NoteDraftCard
                          tasks={draft.tasks}
                          creating={creating}
                          onEdit={(index, patch) =>
                            setDraft((prev) =>
                              editNoteDraftTask(prev, index, patch)
                            )
                          }
                          onCreate={() => void createDraftTask()}
                          onDiscard={discardDraft}
                        />
                      )}
                    </div>
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
