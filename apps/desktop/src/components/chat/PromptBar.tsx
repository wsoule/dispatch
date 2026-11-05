import { Button, Chip, cx, Spinner } from '@dispatch/ui';
import { ArrowUp, FileText, Mic, Paperclip } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import styles from './PromptBar.module.css';

/** A chip above the text box naming what the message is about or who it goes to. */
type PromptBarReference = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown without a remove button, such as a recipient the caller fixes. */
  locked?: boolean;
};

/** One entry of the '/' command list. */
export type PromptBarCommand = {
  id: string;
  label: string;
  hint?: string;
  /** A muted line after the label saying what the command does. */
  description?: string;
};

/** A file waiting to go out with the message. */
type PromptBarAttachment = {
  id: string;
  name: string;
  /** An image's preview; without one the file shows as a named chip. */
  previewUrl?: string;
};

/** One choice of the model (or effort) select. */
type PromptBarModel = {
  id: string;
  label: string;
};

type PromptBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  references?: PromptBarReference[];
  onRemoveReference?: (id: string) => void;
  commands?: PromptBarCommand[];
  models?: PromptBarModel[];
  modelId?: string;
  onModelChange?: (id: string) => void;
  /** A second select beside the model one, same shape — the reasoning effort
   *  the conversation runs at. Omitted, no effort select renders. */
  efforts?: PromptBarModel[];
  effortId?: string;
  onEffortChange?: (id: string) => void;
  /** Shows the mic; without a handler there is no mic, so no button does nothing. */
  onMicClick?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the textarea. Defaults to "Prompt" — override when a caller embeds
   * more than one `PromptBar` on a page, or needs its own label for test/assistive-tech
   * lookup. */
  ariaLabel?: string;
  /** A completion list the caller renders for what is being typed: the text box
   *  names it and its highlighted option, so screen readers announce moves. */
  completion?: { listId: string; activeOptionId?: string };
  /** Puts the caret in the text box on mount, for a composer the user just opened. */
  focusOnMount?: boolean;
  /** Turns attaching on: a paperclip button, and files pasted or dropped onto
   *  the composer come here instead of into the text. Omitted, none of it renders. */
  onAttachFiles?: (files: File[]) => void;
  /** Files waiting to go out with the message, above the text box. */
  attachments?: PromptBarAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /** An upload is in flight: Send waits for it, the paperclip spins. */
  attaching?: boolean;
};

// The files a paste or drop carried; empty for plain text, so a text paste
// keeps the textarea's own behaviour.
function filesIn(dt: DataTransfer | null): File[] {
  if (dt === null) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files.length > 0 ? files : Array.from(dt.files ?? []);
}

const MIN_ROWS = 1;
const MAX_ROWS = 8;
const LINE_HEIGHT_PX = 18;
const VERTICAL_PADDING_PX = 10;
const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

// `/re` only matches commands whose label starts with "re" (case-insensitive); a
// bare `/` matches everything, and anything not starting with `/` matches nothing —
// this is the sole piece of filtering logic in the composer, so it's kept pure and
// unit-tested.
export function matchCommands(
  commands: PromptBarCommand[],
  value: string
): PromptBarCommand[] {
  if (!value.startsWith('/')) return [];
  const query = value.slice(1).toLowerCase();
  return commands.filter((command) =>
    command.label.toLowerCase().startsWith(query)
  );
}

// Grows the textarea to fit its content, clamped between MIN_ROWS and MAX_ROWS lines,
// so a one-line prompt stays compact and a pasted paragraph scrolls instead of
// pushing the footer off-screen. The module draws an 18px line and 5px of padding
// above and below, which these constants mirror.
function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const minHeight = MIN_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
  const maxHeight = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
  const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

// An IME is composing (a Japanese or Chinese input method turning keys into a
// character): its Enter confirms the character, so the composer leaves every key
// alone until it is done. Safari reports the composing Enter as keyCode 229 only.
function composing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

/**
 * The message composer of the Overseer chat, the Tasks tray, threads and run
 * follow-ups, on @dispatch/ui: a bordered --surface box holding the files waiting
 * to go out and the reference chips (removable Chips), the '/' command list, an
 * auto-growing textarea (one to eight lines) and a footer with the model and
 * effort selects, attach, dictation and Send. Enter submits and Shift+Enter
 * inserts a newline; an IME's composing keys are left alone. Pasted or dropped
 * files go to `onAttachFiles`, never into the text. Typing '/' opens an inline
 * listbox of the matching commands above the textarea (no popover: the caret
 * stays in the text box, which names the list and its active option through
 * aria-controls and aria-activedescendant); ArrowUp and ArrowDown move, Enter or
 * Tab pick (Enter on a command already typed out in full sends it), Escape
 * closes it. Fully controlled: `value`/`onChange` live with the
 * caller.
 */
export function PromptBar({
  value,
  onChange,
  onSubmit,
  references = [],
  onRemoveReference,
  commands = [],
  models = [],
  modelId,
  onModelChange,
  efforts = [],
  effortId,
  onEffortChange,
  onMicClick,
  disabled = false,
  placeholder = 'Write a message…',
  ariaLabel = 'Prompt',
  completion,
  focusOnMount = false,
  onAttachFiles,
  attachments = [],
  onRemoveAttachment,
  attaching = false,
}: PromptBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState(false);
  // The command list's active option, for the value it was moved on: a new
  // value starts again at the first match.
  const [cursor, setCursor] = useState({ value: '', index: 0 });
  // The value the command list was closed on with Escape; it opens again once
  // the value changes.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const listId = `${useId()}-commands`;
  const canAttach = onAttachFiles !== undefined && !disabled;

  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    if (textareaRef.current) autosize(textareaRef.current);
  }, [value]);

  const matches = matchCommands(commands, value);
  const listOpen =
    value.startsWith('/') && commands.length > 0 && closedFor !== value;
  const active =
    matches.length === 0
      ? -1
      : Math.min(cursor.value === value ? cursor.index : 0, matches.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;
  const listing = listOpen && matches.length > 0;

  // Keep the active option in view while the arrows move it through a long list.
  useEffect(() => {
    if (!listing) return;
    const option = listRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]'
    );
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [listing, active]);

  // A pasted screenshot is a whole message; an upload still running is not.
  const canSubmit =
    (value.trim().length > 0 || attachments.length > 0) &&
    !disabled &&
    !attaching;

  // A pick writes the command and a space. The list stays up as the legacy
  // popover did, now saying "No matching commands" for the arguments typed after.
  function pick(command: PromptBarCommand) {
    onChange(`/${command.label} `);
    textareaRef.current?.focus();
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = filesIn(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    onAttachFiles(files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canAttach || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (!canAttach) return;
    const files = filesIn(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    onAttachFiles(files);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing(event)) return;
    if (listOpen && event.key === 'Escape') {
      // The list is the topmost thing Escape can close here: it closes alone,
      // and a sheet or view around the composer keeps its own Escape.
      event.preventDefault();
      event.stopPropagation();
      setClosedFor(value);
      return;
    }
    if (listing) {
      const step =
        event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        const index = (active + step + matches.length) % matches.length;
        setCursor({ value, index });
        return;
      }
      // Enter on a command typed out in full ("/compact") has nothing left to
      // complete, so it sends, as it always has; Tab still picks it.
      const typedOut =
        event.key === 'Enter' && value === `/${matches[active].label}`;
      if (
        (event.key === 'Enter' || event.key === 'Tab') &&
        !event.shiftKey &&
        !typedOut
      ) {
        event.preventDefault();
        pick(matches[active]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  // The caller's own completion list, or the command list while it shows.
  const autocomplete = listing
    ? { listId, activeOptionId: optionId(active) }
    : completion;

  return (
    <div
      data-slot="prompt-bar"
      data-dragging={dragging ? 'true' : undefined}
      className={styles.box}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <ul aria-label="Attachments" className={styles.chips}>
          {attachments.map((attachment) => (
            <li key={attachment.id} className={styles.chipItem}>
              <Chip
                title={attachment.name}
                removeLabel={`Remove ${attachment.name}`}
                onRemove={
                  onRemoveAttachment === undefined
                    ? undefined
                    : () => onRemoveAttachment(attachment.id)
                }
              >
                {attachment.previewUrl !== undefined ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className={styles.thumb}
                  />
                ) : (
                  <span className={styles.file}>
                    <FileText {...ICON} size={12} />
                    <span className={styles.fileName}>{attachment.name}</span>
                  </span>
                )}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {references.length > 0 && (
        <div className={styles.chips}>
          {references.map((reference) => (
            <Chip
              key={reference.id}
              removeLabel={`Remove ${reference.label}`}
              onRemove={
                reference.locked === true || onRemoveReference === undefined
                  ? undefined
                  : () => onRemoveReference(reference.id)
              }
            >
              {reference.icon !== undefined && (
                <span className={styles.referenceIcon} aria-hidden="true">
                  {reference.icon}
                </span>
              )}
              {reference.label}
            </Chip>
          ))}
        </div>
      )}

      {/* Inline, above the text box, never taking focus: the human keeps typing
          while the list follows what they type, and the arrows move its active
          option through aria-activedescendant. */}
      {listOpen &&
        (listing ? (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Commands"
            className={styles.commands}
          >
            {matches.map((command, index) => (
              // The text box owns the keys (aria-activedescendant); a press here
              // picks with the pointer, and its mousedown is held back so focus
              // never leaves the text box.
              // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={command.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={styles.option}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCursor({ value, index })}
                onClick={() => pick(command)}
              >
                <span className={styles.commandLabel}>{command.label}</span>
                {command.description !== undefined && (
                  <span className={styles.commandDescription}>
                    {command.description}
                  </span>
                )}
                {command.hint !== undefined && (
                  <span className={styles.commandHint}>{command.hint}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.noCommands}>No matching commands</p>
        ))}

      <textarea
        ref={textareaRef}
        rows={MIN_ROWS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete={autocomplete === undefined ? undefined : 'list'}
        aria-controls={autocomplete?.listId}
        aria-activedescendant={autocomplete?.activeOptionId}
        className={cx('textarea', styles.textarea)}
      />

      <div className={styles.footer}>
        <div className={styles.group}>
          {/* Native selects, not the library's Select (a PickerPopover): the
              choice is a short plain list, and a native control keeps role
              combobox with every option's text in its textContent, which
              OverseerChat.test and the e2e specs read. */}
          {models.length > 0 && (
            <select
              aria-label="Choose model"
              className={cx('select', styles.select)}
              value={modelId ?? ''}
              onChange={(event) => onModelChange?.(event.target.value)}
            >
              {modelId === undefined && (
                <option value="" disabled>
                  Model
                </option>
              )}
              {/* A model the list does not know (retired, or set in config)
                  still shows as itself; a native select would otherwise show
                  its first option and claim the conversation runs on it. */}
              {modelId !== undefined &&
                !models.some((model) => model.id === modelId) && (
                  <option value={modelId}>{modelId}</option>
                )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          {efforts.length > 0 && (
            <select
              aria-label="Choose effort"
              className={cx('select', styles.select)}
              value={effortId ?? ''}
              onChange={(event) => onEffortChange?.(event.target.value)}
            >
              {effortId === undefined && (
                <option value="" disabled>
                  Effort
                </option>
              )}
              {effortId !== undefined &&
                !efforts.some((effort) => effort.id === effortId) && (
                  <option value={effortId}>{effortId}</option>
                )}
              {efforts.map((effort) => (
                <option key={effort.id} value={effort.id}>
                  {effort.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className={styles.group}>
          {onAttachFiles !== undefined && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  // Cleared so picking the same file again still fires.
                  event.target.value = '';
                  if (files.length > 0) onAttachFiles(files);
                }}
              />
              <Button
                variant="quiet"
                size="sm"
                aria-label="Attach files"
                busy={attaching}
                disabled={!canAttach}
                icon={
                  attaching ? (
                    <Spinner size="sm" label="" />
                  ) : (
                    <Paperclip {...ICON} />
                  )
                }
                onClick={() => fileInputRef.current?.click()}
              />
            </>
          )}
          {onMicClick !== undefined && (
            <Button
              variant="quiet"
              size="sm"
              aria-label="Start dictation"
              aria-pressed={false}
              icon={<Mic {...ICON} />}
              onClick={onMicClick}
            />
          )}
          <Button
            variant="primary"
            size="sm"
            aria-label="Send"
            disabled={!canSubmit}
            icon={<ArrowUp {...ICON} />}
            onClick={onSubmit}
          />
        </div>
      </div>
    </div>
  );
}
