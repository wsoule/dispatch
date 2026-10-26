import {
  ArrowUpIcon,
  FileIcon,
  MicIcon,
  PaperclipIcon,
  XIcon,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Kbd } from '../kbd';
import { cn } from '../lib/utils';
import { Popover, PopoverContent } from '../popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select';
import { Spinner } from '../spinner';
import { IconButton } from './icon-button';
import { Pill } from './pill';

export type PromptBarReference = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown without a remove button, such as a recipient the caller fixes. */
  locked?: boolean;
};

export type PromptBarCommand = {
  id: string;
  label: string;
  hint?: string;
  /** A muted line after the label saying what the command does. */
  description?: string;
};

/** A file waiting to go out with the message. */
export type PromptBarAttachment = {
  id: string;
  name: string;
  /** An image's preview; without one the file shows as a named chip. */
  previewUrl?: string;
};

export type PromptBarModel = {
  id: string;
  label: string;
};

export type PromptBarProps = {
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

// `/re` only matches commands whose label starts with "re" (case-insensitive); a
// bare `/` matches everything, and anything not starting with `/` matches nothing —
// this is the sole piece of logic in the primitive, so it's kept pure and unit-tested.
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
// pushing the footer off-screen.
function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  const minHeight = MIN_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
  const maxHeight = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
  const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/** Message composer: removable reference pills above an auto-growing textarea, and a
 * footer with a model picker, a dictation affordance, and an indigo submit button.
 * Typing `/` opens a filtered command popover; Enter submits, Shift+Enter inserts a
 * newline. Fully controlled — `value`/`onChange` live with the caller. The frame is
 * Linear's comment composer: a quaternary card with a half-pixel border. */
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
  const [dragging, setDragging] = useState(false);
  const canAttach = onAttachFiles !== undefined && !disabled;

  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    if (textareaRef.current) autosize(textareaRef.current);
  }, [value]);

  const matches = matchCommands(commands, value);
  const commandPopoverOpen = value.startsWith('/') && commands.length > 0;
  // A pasted screenshot is a whole message; an upload still running is not.
  const canSubmit =
    (value.trim().length > 0 || attachments.length > 0) &&
    !disabled &&
    !attaching;

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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cn(
        'bg-surface-quaternary rounded-card ease-out-expo flex flex-col gap-1.5 border-[0.5px] border-border-strong p-1.5 transition-[box-shadow] duration-100',
        'focus-within:ring-1 focus-within:ring-ring',
        dragging && 'ring-ring ring-2'
      )}
    >
      {attachments.length > 0 && (
        <ul
          aria-label="Attachments"
          className="flex flex-wrap items-end gap-1.5 px-0.5 pt-0.5"
        >
          {attachments.map((attachment) => (
            <li key={attachment.id} className="relative">
              {attachment.previewUrl !== undefined ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  title={attachment.name}
                  className="rounded-control shadow-hairline size-14 object-cover"
                />
              ) : (
                <Pill className="pr-6">
                  <FileIcon aria-hidden className="size-3" />
                  <span className="max-w-40 min-w-0 truncate">
                    {attachment.name}
                  </span>
                </Pill>
              )}
              {onRemoveAttachment !== undefined && (
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="bg-surface-secondary text-muted-foreground hover:text-foreground shadow-hairline rounded-pill absolute -top-1 -right-1 flex size-4 items-center justify-center"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {references.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">
          {references.map((reference) => (
            <Pill
              key={reference.id}
              className={reference.locked === true ? undefined : 'pr-1'}
            >
              {reference.icon}
              <span className="min-w-0 truncate">{reference.label}</span>
              {reference.locked !== true && (
                <button
                  type="button"
                  aria-label={`Remove ${reference.label}`}
                  onClick={() => onRemoveReference?.(reference.id)}
                  className="text-muted-foreground hover:bg-surface-active hover:text-foreground ease-out-expo rounded-pill flex size-4 shrink-0 items-center justify-center transition-colors duration-100"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              )}
            </Pill>
          ))}
        </div>
      )}

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
        aria-autocomplete={completion === undefined ? undefined : 'list'}
        aria-controls={completion?.listId}
        aria-activedescendant={completion?.activeOptionId}
        className="text-foreground placeholder:text-muted-foreground min-h-7 w-full resize-none bg-transparent px-1 py-[5px] text-[13px] leading-[18px] [overflow-wrap:anywhere] outline-none"
      />
      {/* Anchored to the textarea rather than opened by a trigger of its own,
          and never taking focus: the human keeps typing while the command
          list follows what they type. */}
      <Popover open={commandPopoverOpen}>
        <PopoverContent
          anchor={textareaRef}
          align="start"
          initialFocus={false}
          finalFocus={false}
          className={cn(
            'p-1',
            // Described commands need the room for their one-line description.
            commands.some((c) => c.description !== undefined) ? 'w-96' : 'w-64'
          )}
        >
          {matches.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {matches.map((command) => (
                <li key={command.id}>
                  <button
                    type="button"
                    onClick={() => onChange(`/${command.label} `)}
                    className="hover:bg-surface-hover rounded-control ease-out-expo font-book flex h-10 w-full items-center justify-between gap-3 px-2 text-left text-[13px] transition-colors duration-100"
                  >
                    <span className="text-foreground shrink-0">
                      {command.label}
                    </span>
                    {command.description !== undefined && (
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
                        {command.description}
                      </span>
                    )}
                    {command.hint !== undefined && (
                      <Kbd className="max-w-[60%] truncate">{command.hint}</Kbd>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground font-book px-2 py-1.5 text-[12px]">
              No matching commands
            </p>
          )}
        </PopoverContent>
      </Popover>

      <div className="flex items-center justify-between gap-1 px-0.5 pb-0.5">
        <div className="flex items-center gap-1">
          {models.length > 0 && (
            <Select value={modelId} onValueChange={onModelChange}>
              <SelectTrigger aria-label="Choose model">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {efforts.length > 0 && (
            <Select value={effortId} onValueChange={onEffortChange}>
              <SelectTrigger aria-label="Choose effort">
                <SelectValue placeholder="Effort" />
              </SelectTrigger>
              <SelectContent>
                {efforts.map((effort) => (
                  <SelectItem key={effort.id} value={effort.id}>
                    {effort.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center gap-1">
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
              <IconButton
                label="Attach files"
                disabled={!canAttach || attaching}
                onClick={() => fileInputRef.current?.click()}
              >
                {attaching ? (
                  <Spinner aria-hidden />
                ) : (
                  <PaperclipIcon aria-hidden />
                )}
              </IconButton>
            </>
          )}
          {onMicClick !== undefined && (
            <IconButton
              label="Start dictation"
              aria-pressed="false"
              onClick={onMicClick}
            >
              <MicIcon aria-hidden />
            </IconButton>
          )}
          <IconButton
            label="Send"
            filled
            disabled={!canSubmit}
            onClick={onSubmit}
            className={cn(
              canSubmit &&
                'bg-primary text-primary-foreground hover:bg-[var(--accent-hover)] hover:text-primary-foreground'
            )}
          >
            <ArrowUpIcon aria-hidden />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
