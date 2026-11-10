import type { OverseerAttachment } from '@dispatch/client';
import { Button, Chip, cx, Notice } from '@dispatch/ui';
import { X } from 'lucide-react';
import { useState } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { describeError } from '../../lib/actionFeedback';
import { overseerTurnLive } from '../../lib/agentPresence';
import { useAttachmentPreviews } from './OverseerChat';
import { PromptBar } from './PromptBar';
import styles from './TasksComposer.module.css';

export interface TasksComposerProps {
  overseer: OverseerSession;
  /** The task you have open or selected, offered as a context pill. */
  about: { taskId: string; title: string } | null;
  onOpenOverseer: () => void;
  disabled: boolean;
  /** The project it sends to; a switch starts the composer afresh. */
  project: string;
}

/**
 * "say something" in Tasks: always your agent. Its reply shows in a tray; you
 * stay put. Its text, files and failure are its own: the Overseer page keeps
 * its unsent message on the session, and a send from here never touches it.
 * They are one project's too, keyed by `project`: its files were uploaded to
 * that project's dispatchd, and Tasks stays mounted across a project switch.
 */
export function TasksComposer(props: TasksComposerProps) {
  return <ProjectTasksComposer key={props.project} {...props} />;
}

function ProjectTasksComposer({
  overseer,
  about,
  onOpenOverseer,
  disabled,
}: TasksComposerProps) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<OverseerAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collapsed to one line until used, so Tasks keeps its height for work.
  const [expanded, setExpanded] = useState(false);
  // The task whose pill you removed; another task brings the pill back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // How many messages the conversation held when this composer last sent.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const pill = about !== null && about.taskId !== dismissed ? about : null;
  const messages = overseer.record?.messages ?? [];
  const reply =
    sentAt === null
      ? undefined
      : messages
          .slice(sentAt)
          .filter((m) => m.role === 'assistant')
          .at(-1);
  const working = sentAt !== null && overseerTurnLive(overseer);
  const previews = useAttachmentPreviews(files, overseer.fetchAttachment);
  const pending = files.length > 0;

  const attach = async (picked: File[]) => {
    if (picked.length === 0) return;
    setAttaching(true);
    setError(null);
    try {
      const uploaded = await overseer.upload(picked);
      setFiles((current) => [...current, ...uploaded]);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAttaching(false);
    }
  };

  // Clears the composer up front and puts the text and files back if the
  // send fails, unless something new was typed or attached meanwhile.
  const submit = () => {
    const text = draft.trim();
    if ((text === '' && !pending) || overseer.sending || attaching) {
      return;
    }
    const prompt =
      pill === null ? text : `About ${pill.taskId} ("${pill.title}"): ${text}`;
    const typed = draft;
    const sent = files;
    setSentAt(messages.length);
    setDraft('');
    setFiles([]);
    setError(null);
    overseer.reply(prompt, sent).catch((err: unknown) => {
      setError(describeError(err));
      setDraft((current) => (current === '' ? typed : current));
      setFiles((current) => [...sent, ...current]);
    });
  };

  return (
    <div className={styles.root}>
      {(sentAt !== null || error !== null) && (
        <div className={styles.lane}>
          <Notice
            tone={error === null ? 'default' : 'danger'}
            role="status"
            data-testid="tasks-composer-tray"
            action={
              <span className={styles.trayActions}>
                <Button variant="quiet" size="sm" onClick={onOpenOverseer}>
                  Open in Overseer →
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label="Dismiss"
                  icon={<X size={14} strokeWidth={1.8} aria-hidden />}
                  onClick={() => {
                    setSentAt(null);
                    setError(null);
                  }}
                />
              </span>
            }
          >
            <p className={styles.trayText}>
              {error ??
                (working
                  ? 'Your agent is working…'
                  : (reply?.text ?? 'Sent to your agent.'))}
            </p>
          </Notice>
        </div>
      )}
      {!expanded && draft === '' && !pending ? (
        // A press anywhere on the line opens the composer; the input inside
        // is what takes focus and the keyboard (its focus opens it too).
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          data-testid="tasks-composer-collapsed"
          data-disabled={disabled || undefined}
          className={cx(styles.lane, styles.collapsed)}
          onClick={() => {
            if (!disabled) setExpanded(true);
          }}
        >
          {pill !== null && <Chip>{`about ${pill.taskId}`}</Chip>}
          <input
            className={cx('input', styles.collapsedInput)}
            readOnly
            disabled={disabled}
            aria-label="Open the composer"
            placeholder="say something"
            onFocus={() => setExpanded(true)}
          />
        </div>
      ) : (
        <div
          className={styles.lane}
          // Leaving an empty composer folds it back to one line.
          onBlur={(event) => {
            if (
              draft === '' &&
              !pending &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setExpanded(false);
            }
          }}
        >
          <PromptBar
            focusOnMount
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={disabled || overseer.sending}
            placeholder="say something"
            ariaLabel="Say something to your agent"
            references={
              pill === null
                ? undefined
                : [{ id: 'about', label: `about ${pill.taskId}` }]
            }
            onRemoveReference={() => setDismissed(about?.taskId ?? null)}
            onAttachFiles={(picked) => void attach(picked)}
            attachments={files.map((a) => ({
              id: a.path,
              name: a.name,
              previewUrl: previews[a.path],
            }))}
            onRemoveAttachment={(path) =>
              setFiles((current) => current.filter((a) => a.path !== path))
            }
            attaching={attaching}
          />
        </div>
      )}
    </div>
  );
}
