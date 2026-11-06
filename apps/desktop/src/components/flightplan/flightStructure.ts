import { dagWaves } from '../../lib/dagLayout';

// The Flight Plan's geometry: waves as columns left to right, bands (a project's
// milestones) as rows top to bottom, nodes stacked in their (band, wave) cell. It reads
// structure only — ids, blockers, waves, bands — never state, so a node landing or an
// agent starting repaints a card without moving anything.

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 68;
const COLUMN_GAP = 48;
const ROW_GAP = 10;
const PAD_X = 20;
const PAD_Y = 14;
/** The band's title row, above its nodes. */
export const BAND_HEADER_HEIGHT = 36;
const BAND_GAP = 8;
/** A (band, wave) cell taller than this wraps into side-by-side sub-columns. */
export const MAX_ROWS = 10;

export interface FlightLayoutInput {
  id: string;
  created: string;
  blockedBy: readonly string[];
  wave: number;
  /** The band key, or null for a plan without bands. */
  band: string | null;
}

export interface FlightBox {
  id: string;
  x: number;
  y: number;
  wave: number;
  /** Global sub-column index, left to right — what the keyboard walks across. */
  column: number;
}

interface FlightColumn {
  wave: number;
  x: number;
  width: number;
}

interface FlightBandBox {
  key: string;
  /** The band header's top; its nodes start `BAND_HEADER_HEIGHT` below. */
  top: number;
  height: number;
}

interface FlightEdgeGeometry {
  from: string;
  to: string;
  d: string;
}

export interface FlightLayout {
  boxes: ReadonlyMap<string, FlightBox>;
  /** One per wave. */
  columns: FlightColumn[];
  bands: FlightBandBox[];
  edges: FlightEdgeGeometry[];
  width: number;
  height: number;
}

const PITCH_X = NODE_WIDTH + COLUMN_GAP;
const PITCH_Y = NODE_HEIGHT + ROW_GAP;

function byCreatedThenId(
  a: { created: string; id: string },
  b: { created: string; id: string }
): number {
  const byCreated = a.created.localeCompare(b.created);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

/** One node's structure: what the waves and the layout read, and nothing else. */
export interface FlightStructureNode {
  id: string;
  created: string;
  blockedBy: readonly string[];
  band: string | null;
}

type StructureTuple = [
  id: string,
  created: string,
  blockedBy: readonly string[],
  band: string | null,
];

/**
 * The plan's structure as a string: ids, ages, blockers and bands. A status change leaves
 * it equal, so a caller memoizes `flightGeometry` on it and live updates never re-lay out.
 */
export function flightStructureKey(
  nodes: readonly FlightStructureNode[],
  bandOrder: readonly string[] | null
): string {
  const tuples = nodes.map(
    (n): StructureTuple => [n.id, n.created, n.blockedBy, n.band]
  );
  return JSON.stringify({ nodes: tuples, bands: bandOrder });
}

/** The waves and the layout a structure key describes. */
export function flightGeometry(key: string): {
  waves: Map<string, number>;
  layout: FlightLayout;
} {
  const parsed = JSON.parse(key) as {
    nodes: StructureTuple[];
    bands: string[] | null;
  };
  const waves = dagWaves(
    parsed.nodes.map(([id, created, blockedBy]) => ({
      id,
      created,
      blockedBy: [...blockedBy],
      title: '',
      status: '',
    }))
  );
  const layout = flightLayout(
    parsed.nodes.map(([id, created, blockedBy, band]) => ({
      id,
      created,
      blockedBy,
      band,
      wave: waves.get(id) ?? 0,
    })),
    parsed.bands
  );
  return { waves, layout };
}

// A left-to-right edge from the blocker's right side to the dependent's left side, a cubic
// whose handles pull horizontally so it leaves and enters level. A cycle's back edge
// (same or earlier column) runs straight between the facing sides.
function edgePath(from: FlightBox, to: FlightBox): string {
  const y1 = from.y + NODE_HEIGHT / 2;
  const y2 = to.y + NODE_HEIGHT / 2;
  const x1 = from.x + NODE_WIDTH;
  const x2 = to.x;
  if (x2 <= x1) {
    return `M ${from.x} ${y1} L ${to.x + NODE_WIDTH} ${y2}`;
  }
  const pull = Math.min(Math.max((x2 - x1) / 2, 20), 120);
  return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}

/**
 * Lays out a plan. Every (band, wave) cell holds its nodes in one column, or in several
 * side-by-side sub-columns once it passes `MAX_ROWS`; a wave is as wide as its widest
 * cell and a band as tall as its tallest. Within a cell, nodes sit by the mean height of
 * their already-placed blockers (one barycenter pass, waves in order), so an edge mostly
 * runs level; ties and blocker-less nodes go by (created, id). Deterministic.
 */
export function flightLayout(
  nodes: readonly FlightLayoutInput[],
  bandOrder: readonly string[] | null
): FlightLayout {
  const banded = bandOrder !== null;
  const bandKeys = banded ? bandOrder : [''];
  const bandIndex = new Map(bandKeys.map((k, i) => [k, i]));
  const waveCount = nodes.reduce((max, n) => Math.max(max, n.wave + 1), 0);
  const ids = new Set(nodes.map((n) => n.id));

  // cells[band][wave] = the nodes there, unordered for now.
  const cells: FlightLayoutInput[][][] = bandKeys.map(() =>
    Array.from({ length: waveCount }, () => [])
  );
  for (const n of nodes) {
    const b = banded ? (bandIndex.get(n.band ?? '') ?? -1) : 0;
    if (b < 0) continue;
    cells[b]?.[n.wave]?.push(n);
  }

  // Sub-columns per wave and rows per band, from the cell sizes alone.
  const subColumns = Array.from({ length: waveCount }, () => 1);
  const rowsOfCell = (count: number) =>
    count === 0 ? 0 : Math.ceil(count / Math.ceil(count / MAX_ROWS));
  const bandRows = bandKeys.map(() => 0);
  cells.forEach((row, b) => {
    row.forEach((cell, w) => {
      subColumns[w] = Math.max(
        subColumns[w] ?? 1,
        Math.ceil(cell.length / MAX_ROWS)
      );
      bandRows[b] = Math.max(bandRows[b] ?? 0, rowsOfCell(cell.length));
    });
  });

  const columns: FlightColumn[] = [];
  const firstColumnOfWave: number[] = [];
  let x = PAD_X;
  let columnIndex = 0;
  for (let w = 0; w < waveCount; w++) {
    const subs = subColumns[w] ?? 1;
    columns.push({ wave: w, x, width: subs * PITCH_X - COLUMN_GAP });
    firstColumnOfWave.push(columnIndex);
    columnIndex += subs;
    x += subs * PITCH_X;
  }

  const bands: FlightBandBox[] = [];
  const nodeTop: number[] = [];
  let y = PAD_Y;
  bandKeys.forEach((key, b) => {
    const rows = bandRows[b] ?? 0;
    const header = banded ? BAND_HEADER_HEIGHT : 0;
    const body = rows === 0 ? 0 : rows * PITCH_Y - ROW_GAP;
    bands.push({ key, top: y, height: header + body });
    nodeTop.push(y + header);
    y += header + body + (banded ? BAND_GAP + ROW_GAP : 0);
  });

  const boxes = new Map<string, FlightBox>();
  for (let w = 0; w < waveCount; w++) {
    cells.forEach((row, b) => {
      const cell = row[w] ?? [];
      if (cell.length === 0) return;
      const scored = cell.map((n) => {
        let sum = 0;
        let count = 0;
        for (const blocker of n.blockedBy) {
          if (blocker === n.id || !ids.has(blocker)) continue;
          const placed = boxes.get(blocker);
          if (placed === undefined) continue;
          sum += placed.y;
          count++;
        }
        return { n, center: count === 0 ? null : sum / count };
      });
      scored.sort((a, c) => {
        if (a.center !== null && c.center !== null && a.center !== c.center) {
          return a.center - c.center;
        }
        if (a.center !== null && c.center === null) return -1;
        if (a.center === null && c.center !== null) return 1;
        return byCreatedThenId(a.n, c.n);
      });
      const perColumn = rowsOfCell(cell.length);
      const top = nodeTop[b] ?? PAD_Y;
      const baseX = columns[w]?.x ?? PAD_X;
      const baseColumn = firstColumnOfWave[w] ?? 0;
      scored.forEach(({ n }, i) => {
        const sub = Math.floor(i / perColumn);
        boxes.set(n.id, {
          id: n.id,
          x: baseX + sub * PITCH_X,
          y: top + (i % perColumn) * PITCH_Y,
          wave: w,
          column: baseColumn + sub,
        });
      });
    });
  }

  const edges: FlightEdgeGeometry[] = [];
  for (const n of nodes) {
    const to = boxes.get(n.id);
    if (to === undefined) continue;
    for (const blocker of new Set(n.blockedBy)) {
      if (blocker === n.id) continue;
      const from = boxes.get(blocker);
      if (from === undefined) continue;
      edges.push({ from: blocker, to: n.id, d: edgePath(from, to) });
    }
  }

  const width = waveCount === 0 ? 0 : x - COLUMN_GAP + PAD_X;
  const height = y - (banded ? BAND_GAP + ROW_GAP : 0) + PAD_Y;
  return { boxes, columns, bands, edges, width, height };
}
