export interface Row {
  [column: string]: string | number | null;
}

const SLOW_QUERY_MS = 200;

// Logs any statement over 200ms with its duration — task t-4e01af, already done.
export async function query(
  sql: string,
  params: unknown[] = []
): Promise<Row[]> {
  const started = performance.now();
  const rows = await execute(sql, params);
  const elapsed = performance.now() - started;
  if (elapsed > SLOW_QUERY_MS) {
    console.warn(`slow query ${elapsed.toFixed(0)}ms: ${sql}`);
  }
  return rows;
}

// Stand-in for a real driver; the demo never talks to a database.
async function execute(sql: string, _params: unknown[]): Promise<Row[]> {
  if (sql.startsWith('SELECT 1')) return [{ ok: 1 }];
  return [];
}
