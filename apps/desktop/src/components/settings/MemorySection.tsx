import type { ApiClient, MemoryIngestProblem } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import type { ConfigPatch, DispatchConfig } from '@dispatch/core/browser';
import { DEFAULT_MEMORY } from '@dispatch/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { formatBytes } from '../../lib/formatBytes';
import type { MemorySettingsModel } from '../../lib/memory';
import {
  memoryQueryKey,
  memoryQueryRootKey,
  memorySettingsModel,
} from '../../lib/memory';
import { ChoiceSetting, NumberSetting } from './fields';
import { SettingsSearchable } from './search';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';
import { PanelRow } from '@/ui/chrome';
import { Input } from '@/ui/input';

interface MemorySectionProps {
  data: DispatchProjectData;
  /** Null until config loads; only the run settings wait for it. */
  config: DispatchConfig | null;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
}

type MemoryClient = Pick<
  ApiClient,
  | 'memoryHealth'
  | 'memoryIdentity'
  | 'listIngestProblems'
  | 'importClaude'
  | 'acceptIngestProblem'
  | 'startMemoryLink'
  | 'completeMemoryLink'
>;

// One button's action at a time: `pending` names the running one, `error` the
// last failure, and a success refetches every memory query.
function useMemoryAction(port: number | undefined) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(key: string, act: () => Promise<unknown>) {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await act();
      await queryClient.invalidateQueries({
        queryKey: memoryQueryRootKey(port),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }
  return { pending, error, run };
}

// An action's failure, under the rows of the group it belongs to.
function ActionError({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <PanelRow data-settings-row="" className="py-2">
      <span role="alert" className="text-red text-[12px]">
        {error}
      </span>
    </PanelRow>
  );
}

/** Settings → Memory: the store's health and warnings, the ledger import's
 *  parity report, the owner's Claude-notes import, Claude files a scan
 *  skipped, the caller's identity and links, and memory's run settings. */
export function MemorySection({ data, config, onSave }: MemorySectionProps) {
  const { client, port } = data;
  const enabled = client !== null;
  const need = (): MemoryClient => {
    if (client === null) throw new Error('dispatchd client not ready');
    return client;
  };
  const health = useQuery({
    queryKey: memoryQueryKey(port, 'health'),
    queryFn: () => need().memoryHealth(),
    enabled,
    retry: false,
  });
  const model =
    health.data === undefined ? null : memorySettingsModel(health.data);

  return (
    <>
      <StoreGroup
        model={model}
        error={health.error?.message ?? null}
        connected={enabled}
      />
      {model !== null && model.status === 'ok' && (
        <ParityGroup parityText={model.parityText} />
      )}
      {client !== null &&
        model !== null &&
        model.claudeImport !== 'unknown' && (
          <ClaudeImportGroup client={client} port={port} model={model} />
        )}
      {client !== null && <SkippedFilesGroup client={client} port={port} />}
      {client !== null && <IdentityGroup client={client} port={port} />}
      {config !== null && <RunSettingsGroup config={config} onSave={onSave} />}
    </>
  );
}

function StoreGroup({
  model,
  error,
  connected,
}: {
  model: MemorySettingsModel | null;
  error: string | null;
  connected: boolean;
}) {
  const store =
    model?.store ??
    (error !== null
      ? `Couldn’t read memory’s health: ${error}`
      : connected
        ? 'Loading…'
        : 'Dispatch is not running for this project.');
  return (
    <SettingsGroup
      title="Store"
      hint="Lessons, conventions and facts runs read from, kept in this project's memory.db."
      keywords="memory health status"
      requires="none"
    >
      <SettingsRow title="Memory" subtitle={store} />
      {model !== null && model.personalUnavailable !== null && (
        <SettingsRow
          title="Your personal memory"
          subtitle={model.personalUnavailable}
        />
      )}
      {model?.pinnedOverflow === true && (
        <SettingsRow
          title="Pinned entries alone exceed the index budget"
          subtitle="Runs see only your highest-ranked pins. Unpin some, or raise the index budget below."
        />
      )}
      {model?.warnings.map((warning) => (
        <SettingsRow key={warning} title="Config warning" subtitle={warning} />
      ))}
    </SettingsGroup>
  );
}

function ParityGroup({ parityText }: { parityText: string | null }) {
  return (
    <SettingsGroup
      title="Ledger import"
      hint="What moving the ledger's lessons into memory counted, checked on both sides."
      keywords="parity ledger migrate"
      requires="none"
    >
      {parityText === null ? (
        <SettingsRow
          title="No import yet"
          subtitle="The daemon imports the ledger's lessons when it starts."
        />
      ) : (
        <SettingsSearchable text="ledger import parity report rows read">
          <PanelRow className="py-3">
            <pre className="text-muted-foreground overflow-x-auto font-mono text-[12px] leading-[17px]">
              {parityText}
            </pre>
          </PanelRow>
        </SettingsSearchable>
      )}
    </SettingsGroup>
  );
}

// What the Claude import's state means to the person whose notes they are.
function claudeStateText(model: MemorySettingsModel): string {
  switch (model.claudeImport) {
    case 'complete':
      return model.claudeSource === null
        ? 'Imported.'
        : `Imported from ${model.claudeSource}`;
    case 'failed':
      return 'The last import failed. Try it again.';
    case 'running':
      return 'Importing…';
    default:
      return 'No Claude notes were found where they usually are. Pick where yours are, or say you have none.';
  }
}

function ClaudeImportGroup({
  client,
  port,
  model,
}: {
  client: MemoryClient;
  port: number | undefined;
  model: MemorySettingsModel;
}) {
  const action = useMemoryAction(port);
  const busy = action.pending !== null || model.claudeImport === 'running';
  return (
    <SettingsGroup
      title="Claude notes"
      hint="Your own Claude Code memory, imported once as personal memory so runs keep seeing it."
      keywords="claude import memory.md auto memory"
      requires="none"
    >
      <SettingsRow
        title="Import"
        subtitle={claudeStateText(model)}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void action.run('again', () => client.importClaude())
            }
          >
            {action.pending === 'again' ? 'Importing…' : 'Import again'}
          </Button>
        }
      />
      {model.claudeImport === 'unconfirmed' && (
        <>
          {model.candidates.map((candidate) => (
            <SettingsRow
              key={candidate}
              title={candidate}
              subtitle="Claude notes may be here."
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void action.run(candidate, () =>
                      client.importClaude({ from: candidate })
                    )
                  }
                >
                  Import from here
                </Button>
              }
            />
          ))}
          <SettingsRow
            title="None of these"
            subtitle="Runs then use Dispatch memory alone."
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void action.run('none', () =>
                    client.importClaude({ none: true })
                  )
                }
              >
                I have no Claude notes
              </Button>
            }
          />
        </>
      )}
      <ActionError error={action.error} />
    </SettingsGroup>
  );
}

// A skipped file's reason, where it came from, and its size, on one line.
function problemLine(problem: MemoryIngestProblem): string {
  return `${problem.reason} · ${problem.lineage} · ${formatBytes(problem.size)}`;
}

function SkippedFilesGroup({
  client,
  port,
}: {
  client: MemoryClient;
  port: number | undefined;
}) {
  const action = useMemoryAction(port);
  const problems = useQuery({
    queryKey: memoryQueryKey(port, 'ingest-problems'),
    queryFn: () => client.listIngestProblems(),
    retry: false,
  });
  const rows = problems.data?.problems ?? [];
  if (rows.length === 0) return null;
  return (
    <SettingsGroup
      title="Skipped Claude files"
      hint="Files Claude wrote to memory that a scan left out. Accept saves one to your memory as an agent note."
      keywords="ingest problems claude files"
      requires="none"
    >
      {rows.map((problem) => (
        <SettingsRow
          key={problem.id}
          title={problem.file}
          subtitle={problemLine(problem)}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending !== null}
              onClick={() =>
                void action.run(problem.id, () =>
                  client.acceptIngestProblem(problem.id)
                )
              }
            >
              {action.pending === problem.id ? 'Accepting…' : 'Accept'}
            </Button>
          }
        />
      ))}
      <ActionError error={action.error} />
    </SettingsGroup>
  );
}

function IdentityGroup({
  client,
  port,
}: {
  client: MemoryClient;
  port: number | undefined;
}) {
  const action = useMemoryAction(port);
  const identity = useQuery({
    queryKey: memoryQueryKey(port, 'identity'),
    queryFn: () => client.memoryIdentity(),
    retry: false,
  });
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const me = identity.data;
  // A 409 means this handle was bound to someone else: link, or start fresh.
  const rebound =
    identity.error instanceof ApiError && identity.error.status === 409;

  function link() {
    const trimmed = code.trim();
    if (trimmed === '') return;
    void action.run('link', async () => {
      await client.completeMemoryLink(trimmed);
      setCode('');
    });
  }

  function getCode() {
    void action.run('code', async () => {
      const out = await client.startMemoryLink();
      if ('code' in out) setIssued(out);
    });
  }

  return (
    <SettingsGroup
      title="Identity"
      hint="Your personal memory is yours alone, and follows you to every project you link."
      keywords="link code personal handle"
      requires="none"
    >
      {identity.error !== null ? (
        <SettingsRow
          title="Your identity"
          subtitle={identity.error.message}
          control={
            rebound ? (
              <Button
                variant="outline"
                size="sm"
                disabled={action.pending !== null}
                onClick={() =>
                  void action.run('fresh', () =>
                    client.startMemoryLink({ fresh: true })
                  )
                }
              >
                Start fresh
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SettingsRow
          title="Your identity"
          subtitle={
            me === undefined
              ? 'Loading…'
              : me.identity === 'self'
                ? 'You run this Dispatch, so every project on this machine shares your memory.'
                : me.identity
          }
        />
      )}
      {me?.placeholderEmail === true && (
        <SettingsRow
          title="Placeholder email"
          subtitle="Your email in this project's roster is local@localhost, so Dispatch cannot tell whether this handle is still you. Set a real git email."
        />
      )}
      {me?.aliases.map((alias) => (
        <SettingsRow
          key={`${alias.projectKey}:${alias.handle}`}
          title={alias.projectKey}
          subtitle={`Linked as ${alias.handle}`}
        />
      ))}
      {me !== undefined && (
        <SettingsRow
          title="Link another project"
          subtitle="Get a one-time code here and enter it in the other project's Settings → Memory. It lasts 10 minutes."
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending !== null}
              onClick={getCode}
            >
              Get a link code
            </Button>
          }
        >
          {issued !== null && (
            <SettingsHint>
              <span className="text-foreground font-mono">{issued.code}</span>{' '}
              until {new Date(issued.expiresAt).toLocaleTimeString()}
            </SettingsHint>
          )}
        </SettingsRow>
      )}
      <SettingsRow
        title="Use a code from another project"
        subtitle="Moves this project's personal entries into the identity that issued the code."
        htmlFor="memory-link-code"
        control={
          <>
            <Input
              id="memory-link-code"
              aria-label="Link code"
              value={code}
              spellCheck={false}
              className="w-32 font-mono"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') link();
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={action.pending !== null || code.trim() === ''}
              onClick={link}
            >
              Link
            </Button>
          </>
        }
      />
      <ActionError error={action.error} />
    </SettingsGroup>
  );
}

function RunSettingsGroup({
  config,
  onSave,
}: {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
}) {
  const memory = config.memory ?? DEFAULT_MEMORY;
  return (
    <SettingsGroup
      title="Runs"
      hint="How much of memory each run's prompt carries, and whether Claude's own memory joins in."
      keywords="memory index tokens claude auto memory"
    >
      <ChoiceSetting
        id="memory-claude-auto"
        title="Claude’s memory in runs"
        subtitle="Export hands Claude your memory as its own and reads back what it saves. Off keeps Claude's own memory out of runs."
        keywords="claudeAutoMemory export"
        value={memory.claudeAutoMemory}
        choices={[
          { value: 'off', label: 'Off' },
          { value: 'export', label: 'Export to Claude' },
        ]}
        onSave={(claudeAutoMemory) =>
          void onSave({ memory: { claudeAutoMemory } })
        }
      />
      <NumberSetting
        id="memory-index-tokens"
        title="Index budget"
        subtitle="The most memory lines a prompt carries, in tokens (200 to 4000)."
        keywords="indexTokens"
        value={memory.indexTokens}
        min={200}
        max={4000}
        suffix="tokens"
        onSave={(indexTokens) => void onSave({ memory: { indexTokens } })}
      />
    </SettingsGroup>
  );
}
