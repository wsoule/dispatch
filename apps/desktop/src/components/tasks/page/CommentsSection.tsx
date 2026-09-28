import type { TaskComment } from '@dispatch/core/browser';
import { ArrowUp, Ellipsis, Link2, Reply } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskCommentsApi } from '../../../hooks/useTaskComments';
import {
  canModifyComment,
  commentThreads,
  isPendingComment,
} from '../../../lib/commentThreads';
import { formatRelativeTimeFromIso } from '../../../lib/format';
import { isSubmitChord } from '../../../lib/noteDraft';
import { assigneeLabel } from '../../../lib/taskDisplay';
import { usePeople } from '../../people/PeopleContext';
import { Markdown } from '../../runs/Markdown';
import { AssigneeAvatar } from '../AssigneeAvatar';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';

/**
 * A borderless comment field that grows with its text: Enter is a newline, ⌘⏎ sends.
 * Used for a new comment, a reply, and an edit, so all three type the same way.
 */
function CommentField({
  label,
  placeholder,
  initial = '',
  submitLabel,
  focusOnMount = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  initial?: string;
  submitLabel: string;
  focusOnMount?: boolean;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // A reply or an edit opens with the caret in its field.
  useEffect(() => {
    if (focusOnMount) fieldRef.current?.focus();
  }, [focusOnMount]);
  const text = draft.trim();
  function submit() {
    if (text === '') return;
    onSubmit(text);
    setDraft('');
  }
  return (
    <div
      data-slot="comment-field"
      className="bg-surface-quaternary rounded-card border-border-strong focus-within:ring-ring flex flex-col gap-1 border-[0.5px] px-2.5 py-2 focus-within:ring-1"
    >
      <Textarea
        variant="borderless"
        rows={1}
        ref={fieldRef}
        aria-label={label}
        placeholder={placeholder}
        className="font-book min-h-5 resize-none text-[13px] leading-5"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitChord(e)) {
            e.preventDefault();
            // The peek's ⌘⏎ expands the dialog; a send here must not also do that.
            e.stopPropagation();
            submit();
          } else if (e.key === 'Escape' && onCancel !== undefined) {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-1">
        {onCancel !== undefined && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <IconButton
          label={submitLabel}
          filled
          disabled={text === ''}
          onClick={submit}
          className="data-[ready]:bg-primary data-[ready]:text-primary-foreground size-6"
          data-ready={text !== '' || undefined}
        >
          <ArrowUp />
        </IconButton>
      </div>
    </div>
  );
}

interface CommentRowProps {
  comment: TaskComment;
  me: string | null;
  reply: boolean;
  onEdit: (body: string) => void;
  onDelete: () => void;
}

// One comment: avatar, author and time on a 12px byline, the markdown body beneath, and an
// author-only menu (edit, delete). A comment still on its way reads dimmed.
function CommentRow({ comment, me, reply, onEdit, onDelete }: CommentRowProps) {
  const people = usePeople();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = isPendingComment(comment);
  const author =
    people.personFor(comment.author)?.name ?? assigneeLabel(comment.author);
  const mine = !pending && canModifyComment(comment.author, me);
  const edited = comment.updated !== comment.created;
  return (
    <li
      data-slot="comment"
      data-comment-id={comment.id}
      data-pending={pending || undefined}
      className={cn(
        'group/comment flex flex-col gap-1',
        reply && 'pl-6',
        pending && 'opacity-60'
      )}
    >
      <div className="text-muted-foreground font-book flex h-5 items-center gap-1.5 text-[12px]">
        <AssigneeAvatar assignee={comment.author} size={16} />
        <span className="truncate font-medium text-(--text-secondary)">
          {author}
        </span>
        <span className="shrink-0">
          {pending ? 'Sending…' : formatRelativeTimeFromIso(comment.created)}
        </span>
        {edited && !pending && <span className="shrink-0">· edited</span>}
        {comment.external !== null && (
          <span className="flex shrink-0 items-center gap-0.5" title="Synced">
            <Link2 className="size-3" />
          </span>
        )}
        {mine && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  label="Comment actions"
                  className="ml-auto size-5 opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 data-popup-open:opacity-100"
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirming(true)}
              >
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <CommentField
          label="Edit comment"
          placeholder="Comment…"
          initial={comment.body}
          submitLabel="Save comment"
          focusOnMount
          onSubmit={(text) => {
            setEditing(false);
            if (text !== comment.body) onEdit(text);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="pl-[22px]">
          <Markdown
            content={comment.body}
            className="font-book text-[13px] leading-5"
          />
        </div>
      )}
      {confirming && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
              <AlertDialogDescription>
                Its replies go with it. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onDelete}>
                Delete comment
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}

export interface CommentsSectionProps {
  api: TaskCommentsApi;
  me: string | null;
  /** Reports a refused write; the thread has already rolled back. */
  onError: (title: string, err: unknown) => void;
}

/**
 * The task's conversation, Linear-style: threads oldest first, each reply indented under
 * the comment it answers, `Reply` on every thread, and the new-comment field at the foot.
 * Writes paint at once (see useTaskComments); only a comment's author sees its menu. Skeleton
 * rows hold the space until the thread's first fetch lands.
 */
export function CommentsSection({ api, me, onError }: CommentsSectionProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const threads = useMemo(
    () => (api.comments === undefined ? null : commentThreads(api.comments)),
    [api.comments]
  );

  function add(body: string, parentId: string | null = null) {
    api.add(body, parentId).catch((err: unknown) => {
      onError('Could not post the comment', err);
    });
  }

  return (
    <section data-slot="comments-section" className="flex flex-col gap-3">
      {threads === null ? (
        api.error !== null ? (
          <p className="text-red font-book text-[12px]">
            Couldn&rsquo;t load comments: {api.error}
          </p>
        ) : (
          <div aria-label="Loading comments" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        )
      ) : threads.length === 0 ? null : (
        <ul className="flex flex-col gap-4">
          {threads.map((thread) => (
            <li key={thread.root.id} data-slot="comment-thread">
              <ul className="flex flex-col gap-3">
                {[thread.root, ...thread.replies].map((comment) => (
                  <CommentRow
                    key={comment.id}
                    comment={comment}
                    me={me}
                    reply={comment !== thread.root}
                    onEdit={(body) => {
                      api.edit(comment.id, body).catch((err: unknown) => {
                        onError('Could not edit the comment', err);
                      });
                    }}
                    onDelete={() => {
                      api.remove(comment.id).catch((err: unknown) => {
                        onError('Could not delete the comment', err);
                      });
                    }}
                  />
                ))}
              </ul>
              <div className="mt-1.5 pl-6">
                {replyingTo === thread.root.id ? (
                  <CommentField
                    label="Reply"
                    placeholder="Reply…"
                    submitLabel="Send reply"
                    focusOnMount
                    onSubmit={(text) => {
                      setReplyingTo(null);
                      add(text, thread.root.id);
                    }}
                    onCancel={() => setReplyingTo(null)}
                  />
                ) : (
                  !isPendingComment(thread.root) && (
                    <button
                      type="button"
                      onClick={() => setReplyingTo(thread.root.id)}
                      className="text-muted-foreground rounded-control focus-visible:ring-ring flex h-6 items-center gap-1 px-1 text-[12px] font-medium outline-none hover:text-(--text-secondary) focus-visible:ring-2"
                    >
                      <Reply className="size-3" />
                      Reply
                    </button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <CommentField
        label="Leave a comment"
        placeholder="Leave a comment…"
        submitLabel="Send comment"
        onSubmit={(text) => add(text)}
      />
    </section>
  );
}
