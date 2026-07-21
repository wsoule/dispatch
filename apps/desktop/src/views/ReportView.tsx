import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Asterisk,
  Bot,
  Diamond,
  Download,
  FolderOpen,
  Gem,
  Triangle,
} from 'lucide-react';
import { useState } from 'react';

import { StatTile } from '../components/ui/StatTile';
import { agentMeta } from '../lib/agents';
import { exportReport, generateReport, revealInFinder } from '../lib/tauri';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

const RANGE_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/** Maps an agent id to a lucide icon — the legacy `agentMeta().icon` is a unicode glyph
 * (`✳`/`◆`/`◈`/`▲`) which this view replaces with an equivalent lucide icon rather than
 * rendering raw unicode. Kept local to this file (and duplicated in `SessionDetailModal`)
 * rather than added to `lib/agents.ts`, which is out of scope for this pass. */
function AgentIcon({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  switch (agentId) {
    case 'claude':
      return <Asterisk className={className} />;
    case 'codex':
      return <Diamond className={className} />;
    case 'gemini':
      return <Gem className={className} />;
    case 'cursor':
      return <Triangle className={className} />;
    default:
      return <Bot className={className} />;
  }
}

/** "Team spend report" — the manager-facing view: aggregated, exportable spend/usage
 * numbers rather than the Dashboard's live single-user glance. Lives on its own nav item
 * rather than folded into Dashboard so it can carry its own date-range control without
 * that state leaking into the always-live Dashboard. */
export function ReportView() {
  const [rangeDays, setRangeDays] = useState(30);
  const [exportState, setExportState] = useState<
    | { status: 'idle' }
    | { status: 'saving' }
    | { status: 'saved'; path: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['report', rangeDays],
    queryFn: () => generateReport(rangeDays),
  });

  async function handleExport() {
    setExportState({ status: 'saving' });
    try {
      const path = await exportReport(rangeDays);
      setExportState({ status: 'saved', path });
    } catch (e) {
      setExportState({ status: 'error', message: String(e) });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-foreground text-[15px] font-medium">Reports</h1>
        <div className="border-border inline-flex overflow-hidden rounded-md border">
          {RANGE_OPTIONS.map((opt, i) => (
            <button
              key={opt.days}
              onClick={() => {
                setRangeDays(opt.days);
                setExportState({ status: 'idle' });
              }}
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
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <AlertCircle className="text-destructive size-5" />
          <p className="text-muted-foreground text-[13px]">
            Couldn&rsquo;t build the report. Is the backend running?
          </p>
        </div>
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

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleExport()}
              disabled={exportState.status === 'saving'}
            >
              <Download className="size-3.5" />
              {exportState.status === 'saving'
                ? 'Exporting…'
                : 'Export as Markdown'}
            </Button>
            {exportState.status === 'saved' && (
              <span className="text-muted-foreground inline-flex items-center gap-2 text-[13px]">
                Saved to {exportState.path}
                <button
                  className="text-primary inline-flex items-center gap-1 text-[11px] hover:underline"
                  onClick={() => void revealInFinder(exportState.path)}
                >
                  <FolderOpen className="size-3" />
                  Reveal in Finder
                </button>
              </span>
            )}
            {exportState.status === 'error' && (
              <span className="text-destructive text-[13px]">
                {exportState.message}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-5">
            <section className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Spend by project
              </h2>
              <div className="border-border bg-card rounded-lg border p-3">
                {data.by_project.length === 0 ? (
                  <p className="text-muted-foreground text-[13px]">
                    No activity in this window.
                  </p>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr>
                        <th className="border-border text-muted-foreground border-b pb-2 text-left text-[11px] font-medium tracking-wide uppercase">
                          Project
                        </th>
                        <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                          Sessions
                        </th>
                        <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                          Spend
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_project.map((row) => (
                        <tr key={row.project_id}>
                          <td className="border-border text-foreground border-b py-2 last:border-b-0">
                            {row.project_name}
                          </td>
                          <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                            {row.session_count}
                          </td>
                          <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                            ${row.total_cost_usd.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Spend by tag
              </h2>
              <div className="border-border bg-card rounded-lg border p-3">
                {data.by_tag.length === 0 ? (
                  <p className="text-muted-foreground text-[13px]">
                    No tagged sessions in this window.
                  </p>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr>
                        <th className="border-border text-muted-foreground border-b pb-2 text-left text-[11px] font-medium tracking-wide uppercase">
                          Tag
                        </th>
                        <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                          Sessions
                        </th>
                        <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                          Spend
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_tag.map((row) => (
                        <tr key={row.tag}>
                          <td className="border-border text-foreground border-b py-2 last:border-b-0">
                            {row.tag}
                          </td>
                          <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                            {row.session_count}
                          </td>
                          <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                            ${row.total_cost_usd.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Spend by agent
            </h2>
            <div className="border-border bg-card rounded-lg border p-3">
              {data.by_agent.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">
                  No activity in this window.
                </p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr>
                      <th className="border-border text-muted-foreground border-b pb-2 text-left text-[11px] font-medium tracking-wide uppercase">
                        Agent
                      </th>
                      <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                        Sessions
                      </th>
                      <th className="border-border text-muted-foreground border-b pb-2 text-right text-[11px] font-medium tracking-wide uppercase">
                        Spend
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_agent.map((row) => (
                      <tr key={row.agent}>
                        <td className="border-border text-foreground border-b py-2 last:border-b-0">
                          <span className="inline-flex items-center gap-1.5">
                            <AgentIcon
                              agentId={row.agent}
                              className="text-muted-foreground size-3.5"
                            />
                            {agentMeta(row.agent).label}
                          </span>
                        </td>
                        <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                          {row.session_count}
                        </td>
                        <td className="border-border text-muted-foreground border-b py-2 text-right font-mono last:border-b-0">
                          ${row.total_cost_usd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
