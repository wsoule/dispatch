import { ArrowUpIcon, MicIcon, XIcon } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

import { cn } from '../lib/utils';
import { PopoverContent } from '../popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select';

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

/** Message composer: removable reference chips above an auto-growing textarea, and a
 * footer with a model picker, a dictation affordance, and an accent submit button.
 * Typing `/` opens a filtered command popover; Enter submits, Shift+Enter inserts a
 * newline. Fully controlled — `value`/`onChange` live with the caller. Matches the
 * showcase's "Prompt Bar" primitive. */
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
        'bg-field shadow-inset-field rounded-card ease-out-expo flex flex-col gap-1.5 border border-transparent p-1.5 transition-colors duration-150',
        'focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20'
      )}
    >
      {references.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">
          {references.map((reference) => (
            <span
              key={reference.id}
              className="bg-surface-inset text-foreground rounded-chip inline-flex h-6 max-w-full items-center gap-1 py-0.5 pr-1 pl-2 text-xs"
            >
              {reference.icon}
              <span className="min-w-0 truncate">{reference.label}</span>
              <button
                type="button"
                aria-label={`Remove ${reference.label}`}
                onClick={() => onRemoveReference?.(reference.id)}
                className="text-muted-foreground hover:bg-surface-hover-strong hover:text-foreground ease-out-expo flex size-4 shrink-0 items-center justify-center rounded-full transition-colors duration-100"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <PopoverPrimitive.Root open={commandPopoverOpen}>
        <PopoverPrimitive.Anchor asChild>
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
        </PopoverPrimitive.Anchor>
        <PopoverContent
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="w-64 p-1"
        >
          {matches.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {matches.map((command) => (
                <li key={command.id}>
                  <button
                    type="button"
                    onClick={() => onChange(`/${command.label} `)}
                    className="hover:bg-surface-hover rounded-control ease-out-expo flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left text-[13px] transition-colors duration-100"
                  >
                    <span className="text-foreground font-medium">
                      {command.label}
                    </span>
                    {command.hint !== undefined && (
                      <span className="text-muted-foreground truncate text-[11.5px]">
                        {command.hint}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground px-2 py-1.5 text-[12.5px]">
              No matching commands
            </p>
          )}
        </PopoverContent>
      </PopoverPrimitive.Root>

      <div className="flex items-center justify-between gap-1 px-0.5 pb-0.5">
        {models.length > 0 ? (
          <Select value={modelId} onValueChange={onModelChange}>
            <SelectTrigger
              size="sm"
              aria-label="Choose model"
              className="text-muted-foreground hover:text-foreground h-7 border-none bg-transparent px-1.5 text-[12px] font-medium shadow-none hover:bg-transparent"
            >
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
        ) : (
          <span />
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Start dictation"
            aria-pressed="false"
            onClick={onMicClick}
            className="text-muted-foreground hover:bg-surface-hover hover:text-foreground rounded-control ease-out-expo flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-[0.94] motion-reduce:active:scale-100"
          >
            <MicIcon aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Send"
            disabled={!canSubmit}
            onClick={onSubmit}
            className={cn(
              'ease-out-expo flex size-7 shrink-0 items-center justify-center rounded-control transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] motion-reduce:active:scale-100',
              canSubmit
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-inset text-muted-foreground'
            )}
          >
            <ArrowUpIcon aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
