import type {
  InputHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes,
} from 'react';

import type { PickerOption, SaveResult } from '../edit/types';

// Props of the controls family: general-purpose form and overlay controls.
// Plain data and callbacks; text controls pass native attributes through.

/* ---- popup triggers ---------------------------------------------------- */

/** What Menu and Popover hand their `trigger` render function: spread it
    onto the opening button (Button accepts all of it). */
export interface PopupTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu' | 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/* ---- text -------------------------------------------------------------- */

/** field = Gr8r's bordered input; inline = no box, for in-place editing. */
export type TextFieldVariant = 'field' | 'inline';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  variant?: TextFieldVariant;
  /** sm 26px (toolbars, dense rows), md 30px (the default). */
  size?: 'sm' | 'md';
  /** Leading adornment inside the box (a search icon, a chip). */
  start?: ReactNode;
  /** Trailing adornment inside the box (a count, a clear button). */
  end?: ReactNode;
  /** The red error edge; a surrounding Field with an error sets it too. */
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: TextFieldVariant;
  /** Grows with its content (the default); `rows` stays the minimum. */
  autoGrow?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/* ---- field ------------------------------------------------------------- */

export interface FieldProps {
  /** The visible label, tied to the control inside by id. */
  label: ReactNode;
  /** Quiet help under the control, read as its description. */
  hint?: ReactNode;
  /** The error under the control: marks it invalid and describes it. */
  error?: ReactNode;
  /** The control's id; generated when omitted. */
  id?: string;
  /** One TextField, TextArea or Select (they pick up id and description). */
  children: ReactNode;
  className?: string;
}

/* ---- choices ----------------------------------------------------------- */

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** A quiet line under the label, read as the option's description. */
  hint?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  options: readonly RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Accessible name of the group; or name it by `aria-labelledby`. */
  label?: string;
  'aria-labelledby'?: string;
  /** vertical (default) stacks the options; horizontal sets them in a row. */
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
}

export interface SelectProps {
  /** The setting's name: the trigger reads "Tier: Admin". */
  label: string;
  value: string | null;
  options: readonly PickerOption[];
  onChange: (value: string) => SaveResult;
  /** Face when nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  /** The trigger's id (a Field's label points at it). */
  id?: string;
  className?: string;
}

/* ---- menu -------------------------------------------------------------- */

export interface MenuActionItem {
  kind?: 'item';
  id: string;
  label: ReactNode;
  /** A 14px leading icon. */
  icon?: ReactNode;
  /** Quiet key hint at the end of the row ("G then S"). */
  shortcut?: string;
  /** Red text: an irreversible action ("Discard the run"). */
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

/** One choice of a set, ticked when `checked` (role menuitemradio). */
export interface MenuRadioItem {
  kind: 'radio';
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id?: string;
}

/** A labelled run of items ("Saved views"). */
export interface MenuGroup {
  kind: 'group';
  id: string;
  label: string;
  items: readonly (MenuActionItem | MenuRadioItem)[];
}

/** A row that opens a nested menu to its side ("Switch project"). */
export interface MenuSubmenu {
  kind: 'submenu';
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  items: readonly MenuEntry[];
  /** Printed when `items` is empty. */
  emptyLabel?: string;
}

export type MenuEntry =
  | MenuActionItem
  | MenuRadioItem
  | MenuSeparator
  | MenuGroup
  | MenuSubmenu;

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: readonly MenuEntry[];
  /** Renders the opening button; spread the props onto it. */
  trigger: (props: PopupTriggerProps) => ReactNode;
  /** Which trigger edge the menu lines up with. Default 'start'. */
  align?: 'start' | 'end';
  /** Controlled open state (a host shortcut opens it). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/* ---- popover and tooltip ----------------------------------------------- */

export interface PopoverProps {
  /** Accessible name of the panel (a non-modal dialog). */
  label: string;
  trigger: (props: PopupTriggerProps) => ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Takes focus on open; default the first focusable, else the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** On the panel (its width). */
  className?: string;
}

export interface TooltipProps {
  /** The tip: short text that describes the wrapped control. */
  content: ReactNode;
  /** The control it describes; its first focusable element gets
      aria-describedby. */
  children: ReactNode;
  /** Preferred side; flips when it does not fit. Default 'above'. */
  side?: 'above' | 'below';
  /** On the inline wrapper around the children (layout only). */
  className?: string;
}

/* ---- dialog ------------------------------------------------------------ */

/** sm 420px, md 520px (default), lg 680px, xl 920px, full: a large panel. */
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface DialogProps {
  open: boolean;
  /** Esc, the close button and a click on the scrim call it. */
  onClose: () => void;
  /** Names the dialog. */
  title: ReactNode;
  description?: ReactNode;
  /** Keeps the title and description for assistive tech only. */
  titleHidden?: boolean;
  /** A 40px chrome row above the body ("Team › New issue"); the close
      button moves into it. */
  crumb?: ReactNode;
  /** Adds an Expand / Collapse button to the chrome row. */
  onExpand?: () => void;
  expanded?: boolean;
  /** The action buttons, right-aligned. */
  footer?: ReactNode;
  /** Footer content on the left (an attach button, "Create more"). */
  footerStart?: ReactNode;
  size?: DialogSize;
  /** center (default), or top: a composer that grows downward. */
  placement?: 'center' | 'top';
  /** Default true; false when the footer's Cancel is the way out. */
  closeButton?: boolean;
  /** Takes focus on open; default the first field or control of the body. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  children?: ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  /** Esc and the cancel button. */
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** The confirm button is the red danger fill. */
  destructive?: boolean;
}

/* ---- disclosure and spinner -------------------------------------------- */

export interface DisclosureProps {
  /** The always-visible button's content. */
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** row (default): full width, a leading chevron; button: a small quiet
      button with a trailing chevron ("Details"). */
  variant?: 'row' | 'button';
  className?: string;
}

/** xs 12px, sm 14px (default), md 16px, lg 20px. */
export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Announced as a status ("Loading"); null when words beside it say so. */
  label?: string | null;
  className?: string;
}
