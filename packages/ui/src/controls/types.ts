import type {
  InputHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from 'react';

import type { PickerOption, SaveResult } from '../edit/types';
import type { TextEditingMode } from '../lib/textEditing';
import type { DataAttributes } from '../types';

// Props of the controls family: general-purpose form controls and Menu.
// Plain data and callbacks; text controls pass native attributes through.

/* ---- menu trigger ------------------------------------------------------ */

/** What Menu hands its `trigger` render function: spread it onto the
    opening button (Button accepts all of it). */
export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-haspopup': 'menu';
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
  /** Opts into editor keys: list continuation, Tab indent and bold/italic for
   *  `markdown`; auto-indent and Tab indent for `code`. The caller's own
   *  onKeyDown runs first and wins by calling preventDefault. */
  editing?: TextEditingMode;
  /** What Tab inserts in `code` mode; two spaces when omitted. */
  indentUnit?: string;
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
  /** Inline after the label's words and inside the label, so it is part
      of the radio's name (a "Recommended" Chip). */
  badge?: ReactNode;
  /** Beside the option, outside its label: buttons here stay valid
      controls, out of the radio's name, and a press on them picks
      nothing. */
  aside?: ReactNode;
  /** Shown under the option only while it is checked, outside its label
      (a follow-up field, such as the reason for a refusal). */
  children?: ReactNode;
  disabled?: boolean;
  /** The radio's name when its visible label is not the whole of it. */
  'aria-label'?: string;
}

/** A host's `data-*` hooks land on the radiogroup. */
export interface RadioGroupProps extends DataAttributes {
  options: readonly RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Accessible name of the group; or name it by `aria-labelledby`. */
  label?: string;
  'aria-labelledby'?: string;
  /** The inputs' shared `name` (a form field's key); generated when
      omitted. */
  name?: string;
  /** vertical (default) stacks the options; horizontal sets them in a row. */
  orientation?: 'vertical' | 'horizontal';
  /** plain (default) = a ring and its words; cards = each option a boxed
      row that picks as a whole, the checked one on the hover fill with an
      accent edge (a decision card's answers). */
  variant?: 'plain' | 'cards';
  /** How an option's `hint` shows. text (default): a quiet line under the
      label. tooltip: no visible line; a Tooltip on the option's label
      (its ring and words) shows the hint on hover and while its radio has
      keyboard focus, and a visually hidden copy stays the radio's
      description (a one-row footer with no room for the lines, such as
      the review verdict bar). */
  hintAs?: 'text' | 'tooltip';
  /** md (default) is the form row; sm a compact 24px row with 12.5px
      words, for a one-row footer. */
  size?: 'sm' | 'md';
  /** auto (default): an arrow key moves and picks, as native radios do.
      manual: an arrow key only moves focus (the change it makes is not
      reported and the checked option stays); Space, Enter or a click
      picks, and on the checked option reports it again (an answer given
      once more, as a button press would be). For choices that act the
      moment they are picked (approve or deny a tool call), where arrowing
      past one must not choose it. */
  activation?: 'auto' | 'manual';
  disabled?: boolean;
}

/** A host's `data-*` hooks go on the open list's layer, as on any
    PickerPopover. */
export interface SelectProps extends DataAttributes {
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

/** A host's `data-*` hooks (`data-testid`) go on the open menu's layer,
    as on a PickerPopover's popover. */
export interface MenuProps extends DataAttributes {
  /** Accessible name of the menu. */
  label: string;
  items: readonly MenuEntry[];
  /** Renders the opening button; spread the props onto it. */
  trigger: (props: MenuTriggerProps) => ReactNode;
  /** Which trigger edge the menu lines up with. Default 'start'. */
  align?: 'start' | 'end';
  /** Controlled open state (a host shortcut opens it). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}
