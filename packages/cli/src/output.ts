export function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = rows[0].map((_, col) => Math.max(...rows.map(r => r[col].length)));
  return rows
    .map(r => r.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd())
    .join('\n');
}
