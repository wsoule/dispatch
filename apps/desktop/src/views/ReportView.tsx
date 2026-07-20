import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '../components/ui/Button';
import { StatTile } from '../components/ui/StatTile';
import { agentMeta } from '../lib/agents';
import { exportReport, generateReport, revealInFinder } from '../lib/tauri';
import './ReportView.css';

const RANGE_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

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
    <div className="report-view">
      <div className="report-view-topbar">
        <h1 className="view-topbar-title">Reports</h1>
        <div className="report-range-picker">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              className={`report-range-option${rangeDays === opt.days ? ' active' : ''}`}
              onClick={() => {
                setRangeDays(opt.days);
                setExportState({ status: 'idle' });
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="dashboard-view-status">Building report…</p>}
      {isError && (
        <p className="dashboard-view-status">
          Couldn't build the report. Is the backend running?
        </p>
      )}

      {data && (
        <>
          <div className="dashboard-stats-row">
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

          <div className="report-export-row">
            <Button
              variant="secondary"
              onClick={() => void handleExport()}
              disabled={exportState.status === 'saving'}
            >
              {exportState.status === 'saving'
                ? 'Exporting…'
                : 'Export as Markdown'}
            </Button>
            {exportState.status === 'saved' && (
              <span className="report-export-status">
                Saved to {exportState.path}
                <button
                  className="report-export-reveal"
                  onClick={() => void revealInFinder(exportState.path)}
                >
                  Reveal in Finder
                </button>
              </span>
            )}
            {exportState.status === 'error' && (
              <span className="report-export-status report-export-error">
                {exportState.message}
              </span>
            )}
          </div>

          <div className="dashboard-columns">
            <section className="dashboard-section dashboard-column">
              <h2 className="dashboard-section-title">Spend by project</h2>
              <div className="dashboard-card">
                {data.by_project.length === 0 ? (
                  <p className="dashboard-view-status">
                    No activity in this window.
                  </p>
                ) : (
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th className="report-table-num">Sessions</th>
                        <th className="report-table-num">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_project.map((row) => (
                        <tr key={row.project_id}>
                          <td>{row.project_name}</td>
                          <td className="report-table-num">
                            {row.session_count}
                          </td>
                          <td className="report-table-num">
                            ${row.total_cost_usd.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="dashboard-section dashboard-column">
              <h2 className="dashboard-section-title">Spend by tag</h2>
              <div className="dashboard-card">
                {data.by_tag.length === 0 ? (
                  <p className="dashboard-view-status">
                    No tagged sessions in this window.
                  </p>
                ) : (
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th className="report-table-num">Sessions</th>
                        <th className="report-table-num">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_tag.map((row) => (
                        <tr key={row.tag}>
                          <td>{row.tag}</td>
                          <td className="report-table-num">
                            {row.session_count}
                          </td>
                          <td className="report-table-num">
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

          <section className="dashboard-section">
            <h2 className="dashboard-section-title">Spend by agent</h2>
            <div className="dashboard-card">
              {data.by_agent.length === 0 ? (
                <p className="dashboard-view-status">
                  No activity in this window.
                </p>
              ) : (
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="report-table-num">Sessions</th>
                      <th className="report-table-num">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_agent.map((row) => (
                      <tr key={row.agent}>
                        <td>
                          {agentMeta(row.agent).icon}{' '}
                          {agentMeta(row.agent).label}
                        </td>
                        <td className="report-table-num">
                          {row.session_count}
                        </td>
                        <td className="report-table-num">
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
