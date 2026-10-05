// The frozen releases under versions/: their manifest and the rules that pick
// what each alias and extension URI renders. The site and scripts read it.
export interface VersionsManifest {
  // Per version: its release date and each file under versions/<v>/ → sha256 hex.
  versions: Record<string, { date: string; files: Record<string, string> }>;
  // 'latest', 'draft' and '<major>.<minor>' → the version each names.
  aliases: Record<string, string>;
  // 'envelope' | 'gate' | 'work' → the version its extension URI page renders.
  extensions: Record<string, string>;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// Semver order, with numeric pre-release parts compared as numbers (draft.10 > draft.2).
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null)
    throw new Error(`not a version: ${pa === null ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined)
    return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const ca = xa[i];
    const cb = xb[i];
    if (ca === undefined || cb === undefined) return ca === undefined ? -1 : 1;
    const na = /^\d+$/.test(ca) ? Number(ca) : NaN;
    const nb = /^\d+$/.test(cb) ? Number(cb) : NaN;
    const d =
      !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : ca.localeCompare(cb);
    if (d !== 0) return d;
  }
  return 0;
}

export function isVersion(v: string): boolean {
  return SEMVER.test(v);
}

const isPre = (v: string): boolean => v.includes('-');

// `latest` is the newest release (the newest draft before any release),
// `draft` the newest pre-release, and each `<major>.<minor>` its newest release.
export function computeAliases(
  versions: readonly string[]
): Record<string, string> {
  const sorted = [...versions].sort(compareVersions);
  const releases = sorted.filter((v) => !isPre(v));
  const drafts = sorted.filter(isPre);
  const out: Record<string, string> = {};
  const latest = releases.at(-1) ?? drafts.at(-1);
  if (latest !== undefined) out['latest'] = latest;
  const draft = drafts.at(-1);
  if (draft !== undefined) out['draft'] = draft;
  for (const r of releases) out[r.split('.').slice(0, 2).join('.')] = r;
  return out;
}

// The version an extension URI renders: the newest release that has the
// extension, else the newest pre-release that does.
export function extensionSource(
  versions: readonly string[],
  has: (version: string) => boolean
): string | null {
  const sorted = [...versions].filter(has).sort(compareVersions);
  return sorted.filter((v) => !isPre(v)).at(-1) ?? sorted.at(-1) ?? null;
}
