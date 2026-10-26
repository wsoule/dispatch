'use client';

import { ChevronsUpDown, Plus } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

import { PickerPopover } from '../edit/picker-popover';
import { saveErrorMessage, useLatest } from '../edit/save-state';
import { initials } from '../edit/shared';
import type { EditLabels, PickerOption, SaveResult } from '../edit/types';
import styles from './app-shell.module.css';
import { cx } from './render';
import { useOptionalToast } from './toast';
import type { ShellWorkspace, ShellWorkspaceSwitcher } from './types';

/** The action's default words (ShellWorkspaceSwitcher.label). */
export const SWITCH_WORKSPACE_LABEL = 'Switch workspace';

/** The menu's heading over the workspace rows (the CSS uppercases it). */
const WORKSPACES_GROUP = 'Workspaces';
/** The connect row's group: its title is hidden, so only the divider
    shows (Gr8r's menu separator), but it still names the group. */
const CONNECT_GROUP = 'Connect';
/** The connect row's option value; never handed to onSwitch (the row is
    a link out, see PickerOption.href). */
const CONNECT_VALUE = 'workspace-switcher:connect';

const LABELS = {
  saving: 'Switching',
  notSaved: 'Not switched',
  saveFailed: 'Try again.',
} satisfies Partial<EditLabels>;

/** The rows in name order, ties by id, so the list is the same on every
    page and never reshuffles after a switch. */
function byName(a: ShellWorkspace, b: ShellWorkspace): number {
  const byWords = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (byWords !== 0) return byWords;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The menu's options: one per workspace under "Workspaces" (a 20px tile
 * with its initials, the current one in the brand tile's colours; the
 * name; the hint), then the connect row under a bare divider.
 */
function workspaceOptions(switcher: ShellWorkspaceSwitcher): PickerOption[] {
  const options: PickerOption[] = [...switcher.workspaces]
    .sort(byName)
    .map((workspace) => ({
      value: workspace.id,
      label: workspace.name,
      hint: workspace.hint,
      group: WORKSPACES_GROUP,
      mark: {
        kind: 'node',
        node: (
          <span
            className={cx(
              styles.workspaceTile,
              workspace.current === true && styles.workspaceTileCurrent
            )}
            aria-hidden="true"
          >
            {initials(workspace.name)}
          </span>
        ),
      },
    }));
  if (switcher.connect !== undefined) {
    options.push({
      value: CONNECT_VALUE,
      label: switcher.connect.label,
      href: switcher.connect.href,
      group: CONNECT_GROUP,
      groupTitleHidden: true,
      mark: {
        kind: 'node',
        node: <Plus size={15} strokeWidth={1.8} aria-hidden="true" />,
      },
    });
  }
  return options;
}

/** "switch workspace" from "Switch workspace": the action as the end of a
    sentence (the trigger's name). */
function midSentence(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The words the rail tooltip shows for the switcher ("Acme · Switch
    workspace"); AppShell puts them on the brand row's data-tip. */
export function switcherTip(
  switcher: ShellWorkspaceSwitcher,
  workspaceName: string | undefined
): string {
  const label = switcher.label ?? SWITCH_WORKSPACE_LABEL;
  const name = currentName(switcher, workspaceName);
  return name === '' ? label : `${name} · ${label}`;
}

/** The current workspace's name: its row's, else the shell's
    workspaceName, else none. */
function currentName(
  switcher: ShellWorkspaceSwitcher,
  workspaceName: string | undefined
): string {
  const current = switcher.workspaces.find((w) => w.current === true);
  return current?.name ?? workspaceName ?? '';
}

/**
 * The brand row as Gr8r's workspace switcher: a PickerPopover menu
 * (searchable={false}, single choice, the 'brand' appearance) whose
 * trigger keeps the brand link's face (the product's initials tile, the
 * product and workspace names) plus a chevrons-up-down mark on the
 * right. Picking another workspace calls onSwitch through the picker's
 * save contract: while it runs the workspace line reads "Switching to
 * <name>" (in place of the picker's "Switching" note, which would squeeze
 * the names; the polite status still speaks "Switching Workspace"), and a
 * rejection prints "Not switched …" under the row. The current row does
 * nothing; the connect row is a full page load. On the collapsed rail
 * there is no room for the error line, so a failure also goes to a toast
 * when a ToastProvider is mounted (the line is then hidden there; without
 * a provider it stays for assistive tech and in the menu's foot).
 */
export function WorkspaceSwitcher({
  switcher,
  appName,
  workspaceName,
  railActive,
  onOpenChange,
}: {
  switcher: ShellWorkspaceSwitcher;
  appName: string;
  workspaceName: string | undefined;
  /** The sidebar is the collapsed rail (desktop). */
  railActive: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  const toaster = useOptionalToast();
  // Read when a switch fails, which may be after the rail was toggled.
  const rail = useLatest(railActive);
  // The latest failure went to a toast: the rail hides the inline line.
  const [toasted, setToasted] = useState(false);
  // The name of the workspace a running switch goes to ('' when the list
  // does not know it), shown on the workspace line; null when idle.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const attempt = useRef(0);
  const label = switcher.label ?? SWITCH_WORKSPACE_LABEL;
  const current = switcher.workspaces.find((w) => w.current === true);
  const name = currentName(switcher, workspaceName);
  const triggerLabel =
    name === ''
      ? `${appName}, ${midSentence(label)}`
      : `${appName} ${name}, ${midSentence(label)}`;

  function onChange(id: string | null): SaveResult {
    if (id === null || id === CONNECT_VALUE || id === current?.id) {
      return undefined;
    }
    setToasted(false);
    attempt.current += 1;
    const mine = attempt.current;
    setSwitchingTo(switcher.workspaces.find((w) => w.id === id)?.name ?? '');
    // Only the latest switch's end clears the line.
    const settle = (): void => {
      if (attempt.current === mine) setSwitchingTo(null);
    };
    let result: SaveResult;
    try {
      result = switcher.onSwitch(id);
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    return Promise.resolve(result).then(settle, (error: unknown) => {
      settle();
      if (toaster !== null && rail.current) {
        toaster.toast({
          kind: 'error',
          label: LABELS.notSaved,
          message: saveErrorMessage(error, LABELS.saveFailed),
        });
        setToasted(true);
      }
      throw error;
    });
  }

  return (
    <PickerPopover
      className={cx(styles.switcher, toasted && styles.switcherToasted)}
      label="Workspace"
      options={workspaceOptions(switcher)}
      value={current?.id ?? null}
      searchable={false}
      appearance="brand"
      triggerLabel={triggerLabel}
      labels={LABELS}
      onOpenChange={onOpenChange}
      onChange={onChange}
      trigger={
        <>
          <span className={styles.logo} aria-hidden="true">
            {initials(appName)}
          </span>
          <span className={styles.brandText} aria-hidden="true">
            <span className={styles.appName}>{appName}</span>
            {switchingTo !== null ? (
              <span className={styles.workspace}>
                {switchingTo === ''
                  ? LABELS.saving
                  : `${LABELS.saving} to ${switchingTo}`}
              </span>
            ) : name !== '' ? (
              <span className={styles.workspace}>{name}</span>
            ) : null}
          </span>
          <ChevronsUpDown
            className={styles.brandChevron}
            size={13}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </>
      }
    />
  );
}
