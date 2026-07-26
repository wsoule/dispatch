import { useQuery } from '@tanstack/react-query';
import { OctagonAlert } from 'lucide-react';
import { useState } from 'react';

import { AgentIcon } from '../components/sessions/AgentIcon';
import { ExportControl } from '../components/sessions/ExportControl';
import { SessionsEmptyState } from '../components/sessions/SessionsEmptyState';
import { SpendTable } from '../components/sessions/SpendTable';
import { StatTile } from '../components/ui/StatTile';
import { agentMeta } from '../lib/agents';
import { exportReport, generateReport } from '../lib/tauri';
import { Skeleton } from '@/ui/skeleton';

const RANGE_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/** "Team spend report" — the manager-facing view: aggregated, exportable spend/usage
 * numbers rather than the Dashboard's live single-user glance. Lives on its own tab rather
 * than folded into Dashboard so it can carry its own date-range control without that state
 * leaking into the always-live Dashboard. */
export function ReportView() {
  const [rangeDays, setRangeDays] = useState(30);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['report', rangeDays],
    queryFn: () => generateReport(rangeDays),
  });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="border-border inline-flex w-fit overflow-hidden rounded-md border">
        {RANGE_OPTIONS.map((opt, i) => (
          <button
            key={opt.days}
            onClick={() => setRangeDays(opt.days)}
            className={`px-3 py-1.5 text-[13px] transition-colors ${
              i > 0 ? 'border-border border-l' : ''
            } ${
              rangeDays === opt.days
                ? 'bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground hover:bg-accent/40'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="grid grid-cols-4 gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {isError && (
        <SessionsEmptyState
          icon={<OctagonAlert className="size-5" />}
          message="Couldn’t build the report. Is the backend running?"
          tone="destructive"
          onRetry={() => void refetch()}
        />
      )}

      {data && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <StatTile
              value={`$${data.totals.total_cost_usd.toFixed(2)}`}
              label="Total spend"
            />
            <StatTile value={data.totals.session_count} label="Sessions" />
            <StatTile
              value={`$${(data.totals.session_count > 0
                ? data.totals.total_cost_usd / data.totals.session_count
                : 0
              ).toFixed(2)}`}
              label="Avg cost / session"
            />
            <StatTile
              value={(
                data.totals.prompt_tokens +
                data.totals.completion_tokens +
                data.totals.cache_read_tokens +
                data.totals.cache_creation_tokens
              ).toLocaleString()}
              label="Total tokens"
            />
          </div>

          <ExportControl
            label="Export as Markdown"
            onExport={() => exportReport(rangeDays)}
          />

          <div className="grid grid-cols-2 gap-5">
            <section className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Spend by project
              </h2>
              <div className="border-border bg-card rounded-lg border p-3">
                <SpendTable
                  columnLabel="Project"
                  emptyMessage="No activity in this window."
                  rows={data.by_project.map((row) => ({
                    key: row.project_id,
                    label: row.project_name,
                    sessionCount: row.session_count,
                    totalCostUsd: row.total_cost_usd,
                  }))}
                />
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Spend by tag
              </h2>
              <div className="border-border bg-card rounded-lg border p-3">
                <SpendTable
                  columnLabel="Tag"
                  emptyMessage="No tagged sessions in this window."
                  rows={data.by_tag.map((row) => ({
                    key: row.tag,
                    label: row.tag,
                    sessionCount: row.session_count,
                    totalCostUsd: row.total_cost_usd,
                  }))}
                />
              </div>
            </section>
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Spend by agent
            </h2>
            <div className="border-border bg-card rounded-lg border p-3">
              <SpendTable
                columnLabel="Agent"
                emptyMessage="No activity in this window."
                rows={data.by_agent.map((row) => ({
                  key: row.agent,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <AgentIcon
                        agentId={row.agent}
                        className="text-muted-foreground size-3.5"
                      />
                      {agentMeta(row.agent).label}
                    </span>
                  ),
                  sessionCount: row.session_count,
                  totalCostUsd: row.total_cost_usd,
                }))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
