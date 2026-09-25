import { ArrowUpIcon, MicIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

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
import { IconButton } from './icon-button';
import { Pill } from './pill';

export type PromptBarReference = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type PromptBarCommand = {
  id: string;
  label: string;
  hint?: string;
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
  /** Mic is affordance-only — dictation isn't wired up here, so this is optional. */
  onMicClick?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the textarea. Defaults to "Prompt" — override when a caller embeds
   * more than one `PromptBar` on a page, or needs its own label for test/assistive-tech
   * lookup. */
  ariaLabel?: string;
};

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
}: PromptBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) autosize(textareaRef.current);
  }, [value]);

  const matches = matchCommands(commands, value);
  const commandPopoverOpen = value.startsWith('/') && commands.length > 0;
  const canSubmit = value.trim().length > 0 && !disabled;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div
      className={cn(
        'bg-surface-quaternary rounded-card ease-out-expo flex flex-col gap-1.5 border-[0.5px] border-border-strong p-1.5 transition-[box-shadow] duration-100',
        'focus-within:ring-1 focus-within:ring-ring'
      )}
    >
      {references.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">
          {references.map((reference) => (
            <Pill key={reference.id} className="pr-1">
              {reference.icon}
              <span className="min-w-0 truncate">{reference.label}</span>
              <button
                type="button"
                aria-label={`Remove ${reference.label}`}
                onClick={() => onRemoveReference?.(reference.id)}
                className="text-muted-foreground hover:bg-surface-active hover:text-foreground ease-out-expo rounded-pill flex size-4 shrink-0 items-center justify-center transition-colors duration-100"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
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
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
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
          className="w-64 p-1"
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
                    <span className="text-foreground">{command.label}</span>
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
          <IconButton
            label="Start dictation"
            aria-pressed="false"
            onClick={onMicClick}
          >
            <MicIcon aria-hidden />
          </IconButton>
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
