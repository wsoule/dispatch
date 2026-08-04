import { FolderSearch } from 'lucide-react';
import { useCallback, useState } from 'react';

import { AgentsSection } from '../components/settings/AgentsSection';
import { DaemonSection } from '../components/settings/DaemonSection';
import { GeneralSection } from '../components/settings/GeneralSection';
import { IntegrationsSection } from '../components/settings/IntegrationsSection';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { EmptyState } from '@/ui/chrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';

interface SettingsViewProps {
  /** Just `{ path, name }`, the same minimal shape `App.tsx` derives from
   *  `currentProjectRoot()` — not the full observability-database `ProjectSummary`. */
  activeProject: { path: string; name: string } | null;
  data: DispatchProjectData;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/** Settings for the active project: General / Agents / Integrations / Daemon tabs, each hosting
 *  a section component from `components/settings`, sharing one save indicator between them. */
export function SettingsView({ activeProject, data }: SettingsViewProps) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  // General/Agents already render their own saving/saved state, so this wrapper
  // only goes to sections with no feedback of their own (Integrations).
  const save = useCallback(
    async (patch: Parameters<DispatchProjectData['handleUpdateConfig']>[0]) => {
      setSaveState({ kind: 'saving' });
      try {
        await data.handleUpdateConfig(patch);
        setSaveState({ kind: 'saved' });
      } catch (err) {
        setSaveState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [data]
  );

  if (activeProject === null) {
    return (
      <div className="flex max-w-2xl flex-col gap-5">
        <h1 className="text-foreground text-[15px] font-medium">Settings</h1>
        <EmptyState
          icon={FolderSearch}
          message="Select a project from the sidebar to see its daemon status and tracker config."
        />
      </div>
    );
  }

  // LinearPanel calls `data.handleUpdateConfig` directly, so swap in `save`
  // here to route those writes through the shared indicator.
  const integrationsData: DispatchProjectData = {
    ...data,
    handleUpdateConfig: save,
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-foreground text-[15px] font-medium">Settings</h1>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="daemon">Daemon</TabsTrigger>
        </TabsList>

        <div className="flex h-5 items-center">
          {saveState.kind === 'saving' && (
            <span className="dense-meta">Saving…</span>
          )}
          {saveState.kind === 'saved' && (
            <span className="dense-meta text-state-review">
              Saved to .dispatch/config.yml
            </span>
          )}
          {saveState.kind === 'error' && (
            <span className="text-state-failed text-[12px]">
              {saveState.message}
            </span>
          )}
        </div>

        <TabsContent value="general">
          {data.config !== null && (
            <GeneralSection
              config={data.config}
              onSave={data.handleUpdateConfig}
            />
          )}
        </TabsContent>

        <TabsContent value="agents">
          {data.config !== null && (
            <AgentsSection
              config={data.config}
              onSave={data.handleUpdateConfig}
            />
          )}
        </TabsContent>

        <TabsContent value="integrations">
          <IntegrationsSection data={integrationsData} />
        </TabsContent>

        <TabsContent value="daemon">
          <DaemonSection activeProject={activeProject} data={data} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
