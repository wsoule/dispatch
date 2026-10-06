import type { TaskListItem } from '@dispatch-foo/core/browser';
import { useMemo, useState } from 'react';

import type { TaskTab } from '../../lib/appNav';
import {
  type ContainerStatus,
  containerStatus,
} from '../../lib/containerStatus';
import { dagTaskFromDoc } from '../../lib/dagLayout';
import type { ListGroup } from '../../lib/listGrouping';
import { milestonesToMermaid, tasksToMermaid } from '../../lib/mermaidExport';
import { milestoneMap } from '../../lib/milestoneMap';
import type { TaskBucket } from '../../lib/taskStatus';
import { DependencyGraph } from './DependencyGraph';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

type GraphMode = 'milestones' | 'tasks';

const NODE = { width: 240, height: 92 };
const WRAP = 6;

// Remembered per project; storage that throws just means it is not remembered.
function storedMode(key: string): GraphMode {
  try {
    return localStorage.getItem(key) === 'tasks' ? 'tasks' : 'milestones';
  } catch {
    return 'milestones';
  }
}

function storeMode(key: string, mode: GraphMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Kept for this session only.
  }
}

function MilestoneNode({
  title,
  status,
  onOpen,
}: {
  title: string;
  status: ContainerStatus;
  onOpen: () => void;
}) {
  const pct = status.total === 0 ? 0 : (status.done / status.total) * 100;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open the flight plan for ${title}`}
      data-testid="milestone-node"
      className={cn(
        'bg-surface-quaternary rounded-card shadow-card hover:bg-surface-hover flex h-full w-full flex-col gap-1.5 p-3 text-left transition-colors duration-100',
        status.health === 'attention' && 'ring-1 ring-(--state-waiting-fg)'
      )}
    >
      <span className="line-clamp-1 text-[13px] font-semibold">{title}</span>
      <span className="bg-surface-secondary h-1 w-full overflow-hidden rounded-full">
        <span
          className="block h-1 rounded-full bg-(--state-review-fg)"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-muted-foreground flex gap-2 text-[12px] tabular-nums">
        <span>
          {status.done}/{status.total} landed
        </span>
        {status.asks > 0 && (
          <span className="font-semibold text-(--state-waiting-fg)">
            ● {status.asks}
          </span>
        )}
        {status.working > 0 && (
          <span className="text-(--state-working-fg)">◐ {status.working}</span>
        )}
        {status.failed > 0 && (
          <span className="text-(--state-failed-fg)">✕ {status.failed}</span>
        )}
      </span>
    </button>
  );
}

export interface MilestoneMapViewProps {
  groups: readonly ListGroup[];
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the remembered Milestones | Tasks choice. */
  projectKey: string;
  onOpenTask: (taskId: string, tab?: TaskTab) => void;
}

/** The milestone map: milestones as nodes, waits between them as counted edges. */
export function MilestoneMapView({
  groups,
  bucketOf,
  asksByTask,
  projectKey,
  onOpenTask,
}: MilestoneMapViewProps) {
  const storageKey = `dispatch:graph-mode:${projectKey}`;
  const [mode, setMode] = useState<GraphMode>(() => storedMode(storageKey));
  const [copied, setCopied] = useState(false);
  const map = useMemo(() => milestoneMap(groups), [groups]);
  const statusOf = useMemo(() => {
    const out = new Map<string, ContainerStatus>();
    for (const [id, children] of map.childrenOf) {
      out.set(id, containerStatus(children, { bucketOf, asksByTask }));
    }
    return out;
  }, [map, bucketOf, asksByTask]);
  const titleOf = new Map(map.nodes.map((n) => [n.id, n.title]));

  const pick = (next: GraphMode) => {
    setMode(next);
    storeMode(storageKey, next);
  };

  const copy = () => {
    const text =
      mode === 'milestones'
        ? milestonesToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              done: statusOf.get(n.id)?.done ?? 0,
              total: statusOf.get(n.id)?.total ?? 0,
            })),
            map.edges
          )
        : tasksToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              tasks: (map.childrenOf.get(n.id) ?? []).map((doc) => ({
                id: doc.meta.id,
                title: doc.meta.title,
                blockedBy: doc.meta.blockedBy,
              })),
            }))
          );
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div data-testid="milestone-map" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 py-2">
        <div
          role="radiogroup"
          aria-label="Graph of"
          className="rounded-control border-border-chip bg-surface-secondary flex gap-0.5 border-[0.5px] p-0.5"
        >
          {(['milestones', 'tasks'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => pick(m)}
              className={cn(
                'rounded-[6px] px-2.5 py-0.5 text-[12px] capitalize',
                mode === m
                  ? 'bg-background shadow-card font-medium'
                  : 'text-muted-foreground'
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Mermaid'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {mode === 'milestones' ? (
          <DependencyGraph
            tasks={map.nodes}
            direction="LR"
            wrap={WRAP}
            nodeSize={NODE}
            ariaLabel="Milestone map"
            edgeLabel={(edge) => {
              const found = map.edges.find(
                (e) => e.from === edge.from && e.to === edge.to
              );
              return found === undefined ? undefined : String(found.count);
            }}
            edgeTone={(edge) =>
              statusOf.get(edge.from)?.health === 'attention'
                ? 'attention'
                : 'default'
            }
            renderNode={(node) => (
              <MilestoneNode
                title={node.title}
                status={
                  statusOf.get(node.id) ??
                  containerStatus([], { bucketOf, asksByTask })
                }
                onOpen={() => onOpenTask(node.id, 'plan')}
              />
            )}
            empty={{
              heading: 'No milestones yet',
              description:
                'Group tasks under milestones to see how they wait on each other.',
            }}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {map.nodes.map((node) => (
              <section key={node.id} aria-label={titleOf.get(node.id)}>
                <h3 className="py-2 text-[13px] font-semibold">{node.title}</h3>
                <DependencyGraph
                  tasks={(map.childrenOf.get(node.id) ?? []).map(
                    dagTaskFromDoc
                  )}
                  direction="LR"
                  wrap={WRAP}
                  refFor={(id) => id}
                  onOpenNode={(id) => onOpenTask(id)}
                  ariaLabel={`Tasks in ${node.title}`}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
