// `<ms>.<counter>.<replica>`, compared numerically, since the counter can
// outgrow its four-digit padding.
const HLC = /^(\d{13})\.(\d{4,})\.(.+)$/;

export interface ParsedHlc {
  ms: number;
  counter: number;
  replica: string;
}

export function parseOpHlc(hlc: string): ParsedHlc | null {
  const m = HLC.exec(hlc);
  if (m === null) return null;
  return { ms: Number(m[1]), counter: Number(m[2]), replica: m[3] ?? '' };
}

export function compareHlc(a: ParsedHlc, b: ParsedHlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

export function hlcWallMs(hlc: string): number | null {
  return parseOpHlc(hlc)?.ms ?? null;
}
