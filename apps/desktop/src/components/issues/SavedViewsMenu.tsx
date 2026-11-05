import {
  Button,
  ConfirmDialog,
  cx,
  type PickerOption,
  PickerPopover,
  Popover,
  Switch,
} from '@dispatch/ui';
import { ChevronDown, Star } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';

import type { SavedViewsApi } from '../../hooks/useSavedViews';
import { type SavedView, viewMatches } from '../../lib/savedViews';
import type { TaskFilterSet } from '../../lib/taskFilters';
import type { TasksDisplayPrefs } from '../../lib/tasksPrefs';
import { TASKS_PRESETS, type TasksPreset } from '../../lib/tasksPresets';
import styles from './SavedViewsMenu.module.css';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

const STAR_MARK = {
  kind: 'node',
  node: (
    <span className={styles.star}>
      <Star {...ICON} fill="currentColor" />
    </span>
  ),
} as const;

// Option values carry a prefix, because a saved view is listed twice (under
// Starred views and Saved views) and the actions share the list.
const PRESET = 'preset:';
const STARRED = 'starred:';
const VIEW = 'view:';
const ACTION_SAVE = 'action:save';
const ACTION_UPDATE = 'action:update';
const ACTION_RENAME = 'action:rename';
const ACTION_STAR = 'action:star';
const ACTION_DELETE = 'action:delete';
const ACTION_CLOSE = 'action:close';

/** The name form the menu opens: a new view, or a rename of `view`. */
type ViewForm = { mode: 'create' } | { mode: 'rename'; view: SavedView };

export interface SavedViewsMenuProps {
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
  /** Null outside App's provider: the menu then offers the presets alone. */
  savedViews: SavedViewsApi | null;
  /** What the page shows now: what Save view… snapshots and Update writes
      back. */
  filters: TaskFilterSet;
  display: TasksDisplayPrefs;
}

/**
 * The Issues toolbar's `view:` menu: one PickerPopover in action mode (each
 * pick runs and closes; the preset and the saved view showing now are
 * `selected`, aria-selected with a tick) listing the presets (All, Mine,
 * Needs you…), the starred views, every saved view, then Save view…, Update
 * when the open view has drifted, and Rename… / Star / Delete / Close for
 * it. Letters jump through the list (typeahead). Save and Rename open a
 * small name form in a Popover anchored to the trigger, which takes focus
 * back when the form closes (Tab and Shift+Tab included); opening the menu
 * again closes the form. Delete asks first in a ConfirmDialog. Picking a
 * saved view only selects it; the page applies it, as it does the
 * palette's Open view.
 */
export function SavedViewsMenu({
  preset,
  onPreset,
  savedViews,
  filters,
  display,
}: SavedViewsMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [form, setForm] = useState<ViewForm | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const views = savedViews?.views ?? [];
  const activeView = savedViews?.activeView ?? null;
  const isStarred = (id: string) =>
    savedViews?.isFavorite({ kind: 'view', id }) ?? false;
  const starred = views.filter((view) => isStarred(view.id));
  const dirty =
    activeView !== null && !viewMatches(activeView, filters, display);
  const presetLabel =
    TASKS_PRESETS.find((p) => p.id === preset)?.label ?? 'All';
  const label =
    activeView === null
      ? presetLabel
      : [
          activeView.name,
          ...(preset === 'all' ? [] : [presetLabel]),
          ...(dirty ? ['edited'] : []),
        ].join(' · ');
  const faceText = `view: ${label}`;

  const options: PickerOption[] = TASKS_PRESETS.map((p) => ({
    value: `${PRESET}${p.id}`,
    label: p.label,
    group: 'Show',
    selected: p.id === preset ? true : undefined,
  }));
  if (savedViews !== null) {
    for (const view of starred) {
      options.push({
        value: `${STARRED}${view.id}`,
        label: view.name,
        group: 'Starred views',
        mark: STAR_MARK,
      });
    }
    for (const view of views) {
      options.push({
        value: `${VIEW}${view.id}`,
        label: view.name,
        group: 'Saved views',
        selected: view.id === activeView?.id ? true : undefined,
      });
    }
    const actions: { value: string; label: string }[] = [
      { value: ACTION_SAVE, label: 'Save view…' },
    ];
    if (activeView !== null) {
      if (dirty) {
        actions.push({
          value: ACTION_UPDATE,
          label: `Update “${activeView.name}”`,
        });
      }
      actions.push(
        { value: ACTION_RENAME, label: 'Rename…' },
        {
          value: ACTION_STAR,
          label: isStarred(activeView.id) ? 'Remove star' : 'Star view',
        },
        { value: ACTION_DELETE, label: 'Delete view' },
        { value: ACTION_CLOSE, label: 'Close view' }
      );
    }
    for (const action of actions) {
      options.push({ ...action, group: 'Actions', groupTitleHidden: true });
    }
  }

  /** The menu's trigger button: what the name form hangs off, and where
      focus goes back to once the form or the delete question is done. */
  function trigger(): HTMLElement | null {
    return anchorRef.current?.querySelector('button') ?? null;
  }
  // The form's anchor, read live: the trigger button inside the wrapper.
  const formAnchor = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return anchorRef.current?.querySelector('button') ?? null;
      },
    }),
    []
  );

  // Runs one pick. The picker has already closed and put focus back on its
  // trigger, so a form or dialog opened here returns focus there too.
  function pick(value: string | null): void {
    if (value === null) return;
    if (value.startsWith(PRESET)) {
      const next = TASKS_PRESETS.find((p) => `${PRESET}${p.id}` === value);
      if (next !== undefined) onPreset(next.id);
      return;
    }
    if (savedViews === null) return;
    if (value.startsWith(STARRED)) {
      savedViews.selectView(value.slice(STARRED.length));
      return;
    }
    if (value.startsWith(VIEW)) {
      savedViews.selectView(value.slice(VIEW.length));
      return;
    }
    if (value === ACTION_SAVE) {
      setForm({ mode: 'create' });
      return;
    }
    if (activeView === null) return;
    switch (value) {
      case ACTION_UPDATE:
        savedViews.updateView(activeView.id, { filters, display });
        return;
      case ACTION_RENAME:
        setForm({ mode: 'rename', view: activeView });
        return;
      case ACTION_STAR:
        savedViews.toggleFavorite({ kind: 'view', id: activeView.id });
        return;
      case ACTION_DELETE:
        setDeleting(activeView);
        return;
      case ACTION_CLOSE:
        savedViews.clearActiveView();
        return;
      default:
        return;
    }
  }

  function closeForm(): void {
    setForm(null);
    trigger()?.focus({ preventScroll: true });
  }

  function submit(result: { name: string; favorite: boolean }): void {
    if (savedViews === null || form === null) return;
    if (form.mode === 'rename') {
      savedViews.renameView(form.view.id, result.name);
    } else {
      const view = savedViews.saveView({
        name: result.name,
        filters,
        display,
        favorite: result.favorite,
      });
      savedViews.selectView(view.id);
    }
    closeForm();
  }

  return (
    <span ref={anchorRef} className={styles.root}>
      <PickerPopover
        action
        label="View"
        triggerLabel={faceText}
        searchable={false}
        appearance="mono"
        align="end"
        options={options}
        value={null}
        onChange={pick}
        onOpenChange={(open) => {
          // The menu opened over the name form: the form gives way.
          if (open) setForm(null);
        }}
        trigger={
          <>
            <span className={styles.face} data-testid="tasks-preset">
              {faceText}
            </span>
            <ChevronDown {...ICON} className={styles.chevron} />
          </>
        }
      />
      {savedViews !== null ? (
        <Popover
          open={form !== null}
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
          label={form?.mode === 'rename' ? 'Rename view' : 'Save view'}
          anchorRef={formAnchor}
          align="end"
          width={320}
          returnFocus={trigger}
        >
          {form !== null ? (
            <ViewNameForm
              key={form.mode === 'rename' ? `rename:${form.view.id}` : 'create'}
              mode={form.mode}
              initialName={form.mode === 'rename' ? form.view.name : ''}
              onCancel={closeForm}
              onSubmit={submit}
            />
          ) : null}
        </Popover>
      ) : null}
      {savedViews !== null ? (
        <ConfirmDialog
          open={deleting !== null}
          title="Delete view?"
          confirmLabel="Delete view"
          tone="danger"
          onConfirm={() => {
            if (deleting !== null) savedViews.deleteView(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        >
          “{deleting?.name}” is removed from this project’s saved views. The
          filters showing now stay as they are.
        </ConfirmDialog>
      ) : null}
    </span>
  );
}

/**
 * The name form behind Save view… and Rename…: one name field, a Favorite
 * switch when creating, Cancel and Save. Enter in the field and ⌘/Ctrl+Enter
 * anywhere in it submit; a blank (trimmed) name cannot. It mounts per
 * opening, so a reopened form starts from its props.
 */
function ViewNameForm({
  mode,
  initialName,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'rename';
  initialName: string;
  onCancel: () => void;
  onSubmit: (result: { name: string; favorite: boolean }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [favorite, setFavorite] = useState(false);
  const descriptionId = useId();
  const trimmed = name.trim();
  const canSubmit = trimmed !== '';

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({ name: trimmed, favorite: mode === 'create' && favorite });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key !== 'Enter') return;
    const inField = event.target instanceof HTMLInputElement;
    if (inField || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className={styles.form} onKeyDown={onKeyDown}>
      <input
        className={cx('input', styles.name)}
        aria-label="View name"
        aria-describedby={descriptionId}
        placeholder="View name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <p id={descriptionId} className="srOnly">
        {mode === 'rename'
          ? 'Give this saved view a new name.'
          : 'Name the current filters and display as a view.'}
      </p>
      {mode === 'create' ? (
        <Switch label="Favorite" checked={favorite} onChange={setFavorite} />
      ) : null}
      <div className={styles.actions}>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          onClick={submit}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
