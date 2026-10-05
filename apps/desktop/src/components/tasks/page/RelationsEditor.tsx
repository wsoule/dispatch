import type {
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import { isSatisfiedForDispatchStatus } from '@dispatch-foo/core/browser';
import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { blocksIn, taskIndexOf } from '../../../lib/taskIndex';
import type { PickerItem } from '../detail/PickerPopover';
import { PickerPopover } from '../detail/PickerPopover';
import { StatusIcon } from '../StatusIcon';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';

// A task picker draws this many rows at most; typing narrows the rest.
const PICKER_LIMIT = 60;

/** One related task as a 28px row: status glyph, id, title, and a remove `×` on hover. A
 * blocker that has landed reads dimmed — it no longer holds anything back. */
function RelationRow({
  task,
  id,
  dim,
  onOpen,
  onRemove,
}: {
  task: TaskListItem | undefined;
  id: string;
  dim?: boolean;
  onOpen: (taskId: string) => void;
  onRemove?: () => void;
}) {
  return (
    <li
      data-slot="relation-row"
      className={cn(
        'group/relation rounded-control hover:bg-surface-hover flex h-7 items-center gap-1.5 pr-1 pl-2',
        dim === true && 'opacity-60'
      )}
    >
      {task !== undefined && <StatusIcon status={task.meta.status} />}
      <button
        type="button"
        onClick={() => onOpen(id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline"
      >
        <span className="text-muted-foreground font-book shrink-0 text-[12px] tracking-(--id-tracking)">
          {id}
        </span>
        <span className="truncate text-[13px] font-medium text-(--text-secondary)">
          {task?.meta.title ?? 'Unknown task'}
        </span>
      </button>
      {onRemove !== undefined && (
        <IconButton
          label={`Remove ${id}`}
          onClick={onRemove}
          className="size-5 opacity-0 group-focus-within/relation:opacity-100 group-hover/relation:opacity-100"
        >
          <X />
        </IconButton>
      )}
    </li>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-slot="relation-group" className="flex flex-col">
      <div className="text-muted-foreground flex h-6 items-center pl-2 text-[12px] font-medium">
        {label}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

export interface RelationsEditorProps {
  item: TaskListItem;
  tasks: readonly TaskListItem[];
  tasksById: ReadonlyMap<string, TaskListItem>;
  model: StatusModel;
  onPatch: (patch: UpdatePatch) => void;
  onOpenTask: (taskId: string) => void;
}

/**
 * A task's links to other tasks, each group editable where the relation is the task's own:
 * Blocked by, Related, Duplicate of — and Blocks, read from the tasks that name this one.
 * Pickers build their rows only when opened and draw the first few dozen matches, so a
 * 2000-task project opens them as fast as a small one.
 */
export function RelationsEditor({
  item,
  tasks,
  tasksById,
  model,
  onPatch,
  onOpenTask,
}: RelationsEditorProps) {
  const { id, blockedBy, relatedTo, duplicateOf } = item.meta;
  const blocks = blocksIn(taskIndexOf(tasks), id);
  // Rows for every other live task, built on open; `exclude` drops ones already linked.
  function candidates(exclude: readonly string[]): () => PickerItem[] {
    return () => {
      const skip = new Set([id, ...exclude]);
      const out: PickerItem[] = [];
      for (const t of tasks) {
        if (skip.has(t.meta.id) || t.meta.archivedAt !== undefined) continue;
        out.push({
          value: t.meta.id,
          label: t.meta.title,
          hint: t.meta.id,
          glyph: <StatusIcon status={t.meta.status} />,
        });
      }
      return out;
    };
  }
  function addButton(
    label: string,
    ariaLabel: string,
    exclude: readonly string[],
    onPick: (taskId: string) => void
  ) {
    return (
      <PickerPopover
        triggerLabel={ariaLabel}
        triggerClassName="text-muted-foreground hover:text-foreground hover:bg-surface-hover rounded-control focus-visible:ring-ring flex h-6 items-center gap-1 px-1.5 text-[12px] font-medium outline-none focus-visible:ring-2 [&_svg]:size-3"
        placeholder="Task…"
        items={candidates(exclude)}
        limit={PICKER_LIMIT}
        onSelect={onPick}
      >
        <Plus />
        {label}
      </PickerPopover>
    );
  }

  return (
    <div data-slot="relations-editor" className="flex flex-col gap-2">
      {blockedBy.length > 0 && (
        <Group label="Blocked by">
          {blockedBy.map((b) => {
            const blocker = tasksById.get(b);
            return (
              <RelationRow
                key={b}
                id={b}
                task={blocker}
                dim={
                  blocker !== undefined &&
                  isSatisfiedForDispatchStatus(blocker.meta.status, model)
                }
                onOpen={onOpenTask}
                onRemove={() =>
                  onPatch({ blockedBy: blockedBy.filter((x) => x !== b) })
                }
              />
            );
          })}
        </Group>
      )}
      {blocks.length > 0 && (
        <Group label="Blocks">
          {blocks.map((t) => (
            <RelationRow
              key={t.meta.id}
              id={t.meta.id}
              task={t}
              onOpen={onOpenTask}
            />
          ))}
        </Group>
      )}
      {relatedTo.length > 0 && (
        <Group label="Related">
          {relatedTo.map((r) => (
            <RelationRow
              key={r}
              id={r}
              task={tasksById.get(r)}
              onOpen={onOpenTask}
              onRemove={() =>
                onPatch({ relatedTo: relatedTo.filter((x) => x !== r) })
              }
            />
          ))}
        </Group>
      )}
      {duplicateOf !== null && (
        <Group label="Duplicate of">
          <RelationRow
            id={duplicateOf}
            task={tasksById.get(duplicateOf)}
            onOpen={onOpenTask}
            onRemove={() => onPatch({ duplicateOf: null })}
          />
        </Group>
      )}
      <div className="-ml-1.5 flex flex-wrap items-center gap-0.5">
        {addButton('Blocker', 'Add a blocker', blockedBy, (b) =>
          onPatch({ blockedBy: [...blockedBy, b] })
        )}
        {addButton('Related', 'Add a related task', relatedTo, (r) =>
          onPatch({ relatedTo: [...relatedTo, r] })
        )}
        {duplicateOf === null &&
          addButton('Duplicate of', 'Mark as a duplicate', [], (d) =>
            onPatch({ duplicateOf: d })
          )}
      </div>
    </div>
  );
}
