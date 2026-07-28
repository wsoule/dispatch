const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count sized for a glance.
 *
 * Base 1024 with the short unit names, which is what every disk tool a
 * developer already uses shows. One decimal above a megabyte and none below:
 * "1.4 GB" is a number you act on, "1.4 KB" is noise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
