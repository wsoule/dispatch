import { Star } from 'lucide-react';
import { useState } from 'react';

import type { SavedViewsApi } from '../../hooks/useSavedViews';
import { viewMatches } from '../../lib/savedViews';
import type { TaskFilterSet } from '../../lib/taskFilters';
import type { TasksDisplayPrefs } from '../../lib/tasksPrefs';
import { TASKS_PRESETS, type TasksPreset } from '../../lib/tasksPresets';
import { SaveViewDialog } from './SaveViewDialog';
import { SelectPill } from '@/ui/ai/pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

/** The name prompt the menu opens: a new view, or a rename of the active one. */
type ViewDialog = { mode: 'create' } | { mode: 'rename' };

export interface TasksViewMenuProps {
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
  /** Null outside App's provider: the menu then offers the presets alone. */
  savedViews: SavedViewsApi | null;
  /** What the page shows now: what Save view… snapshots and Update writes back. */
  filters: TaskFilterSet;
  display: TasksDisplayPrefs;
}

/**
 * The Tasks header's `view:` pill: the presets (All, Mine, Needs you…), the starred saved
 * views, every saved view, then Save view…, Update when the
 * open view has drifted, and Rename… / Star / Delete / Close for it. Picking a saved view
 * only selects it; the page applies it, as it does the palette's Open view.
 */
export function TasksViewMenu({
  preset,
  onPreset,
  savedViews,
  filters,
  display,
}: TasksViewMenuProps) {
  const [dialog, setDialog] = useState<ViewDialog | null>(null);
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="tasks-preset"
          render={<SelectPill className="max-w-[200px]" />}
        >
          view: {label}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={preset}
              onValueChange={(value) => {
                const next = TASKS_PRESETS.find((p) => p.id === value);
                if (next !== undefined) onPreset(next.id);
              }}
            >
              {TASKS_PRESETS.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {savedViews !== null && (
            <>
              <DropdownMenuSeparator />
              {starred.length > 0 && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Starred views</DropdownMenuLabel>
                  {starred.map((view) => (
                    <DropdownMenuItem
                      key={view.id}
                      onClick={() => savedViews.selectView(view.id)}
                    >
                      <Star aria-hidden fill="currentColor" />
                      {view.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </DropdownMenuGroup>
              )}
              {views.length > 0 && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Saved views</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={activeView?.id ?? ''}
                    onValueChange={(id) => savedViews.selectView(id as string)}
                  >
                    {views.map((view) => (
                      <DropdownMenuRadioItem key={view.id} value={view.id}>
                        {view.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </DropdownMenuGroup>
              )}
              <DropdownMenuItem onClick={() => setDialog({ mode: 'create' })}>
                Save view…
              </DropdownMenuItem>
              {activeView !== null && (
                <>
                  {dirty && (
                    <DropdownMenuItem
                      onClick={() =>
                        savedViews.updateView(activeView.id, {
                          filters,
                          display,
                        })
                      }
                    >
                      Update “{activeView.name}”
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => setDialog({ mode: 'rename' })}
                  >
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      savedViews.toggleFavorite({
                        kind: 'view',
                        id: activeView.id,
                      })
                    }
                  >
                    {isStarred(activeView.id) ? 'Remove star' : 'Star view'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => savedViews.deleteView(activeView.id)}
                  >
                    Delete view
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => savedViews.clearActiveView()}
                  >
                    Close view
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {savedViews !== null && (
        <SaveViewDialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          mode={dialog?.mode ?? 'create'}
          initialName={dialog?.mode === 'rename' ? activeView?.name : undefined}
          onSubmit={({ name, favorite }) => {
            if (dialog?.mode === 'rename') {
              if (activeView !== null)
                savedViews.renameView(activeView.id, name);
              return;
            }
            const view = savedViews.saveView({
              name,
              filters,
              display,
              favorite,
            });
            savedViews.selectView(view.id);
          }}
        />
      )}
    </>
  );
}
