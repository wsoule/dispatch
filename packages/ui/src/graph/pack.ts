// Packing helpers for the clustered graph layout (layout.ts, owner decision
// 2026-10-23: "the graph shows every issue"): boxes that touch no arrow go
// into a compact grid inside their cluster, and clusters that touch no
// arrow go onto shelves, so a graph of every issue never becomes one long
// column. Pure arithmetic over sizes, in input order: no DOM, no
// randomness, the same input gives the same output on the server and the
// client.

/** A box's size in CSS pixels. */
export interface PackSize {
  width: number;
  height: number;
}

/** A packed arrangement: each input's top-left corner and the total size. */
export interface Packed {
  positions: { x: number; y: number }[];
  width: number;
  height: number;
}

/**
 * How many columns a grid of `count` cells of about `cell` size gets so
 * that it is about `aspect` times wider than tall, widened while one more
 * column still fits inside `fill` (the width of what sits above it, so the
 * grid uses the room it has), never more columns than cells. Two or more
 * cells always get at least two columns: rounding the aspect rule for two
 * or three wide boxes would otherwise give one, and they would stack in a
 * column under the flow, the pile the grid exists to avoid.
 */
export function gridColumns(
  count: number,
  cell: PackSize,
  gapX: number,
  aspect: number,
  fill = 0
): number {
  if (count <= 0) return 0;
  const width = Math.max(1, cell.width);
  const height = Math.max(1, cell.height);
  let columns = Math.round(Math.sqrt((count * aspect * height) / width));
  columns = Math.min(count, Math.max(count >= 2 ? 2 : 1, columns));
  while (columns < count && (columns + 1) * width + columns * gapX <= fill) {
    columns += 1;
  }
  return columns;
}

/**
 * A table of cells in row-major order: each column as wide as its widest
 * cell and each row as tall as its tallest, every cell centred across its
 * column (so a column shares one centre, like a layout rank) and set at
 * the top of its row.
 */
export function packGrid(
  sizes: readonly PackSize[],
  columns: number,
  gapX: number,
  gapY: number
): Packed {
  if (sizes.length === 0 || columns <= 0) {
    return { positions: [], width: 0, height: 0 };
  }
  const rows = Math.ceil(sizes.length / columns);
  const colWidth = new Array<number>(Math.min(columns, sizes.length)).fill(0);
  const rowHeight = new Array<number>(rows).fill(0);
  sizes.forEach((size, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    colWidth[col] = Math.max(colWidth[col] ?? 0, size.width);
    rowHeight[row] = Math.max(rowHeight[row] ?? 0, size.height);
  });
  const colX: number[] = [];
  let x = 0;
  for (const w of colWidth) {
    colX.push(x);
    x += w + gapX;
  }
  const rowY: number[] = [];
  let y = 0;
  for (const h of rowHeight) {
    rowY.push(y);
    y += h + gapY;
  }
  const positions = sizes.map((size, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    return {
      x: Math.round((colX[col] ?? 0) + ((colWidth[col] ?? 0) - size.width) / 2),
      y: rowY[row] ?? 0,
    };
  });
  return {
    positions,
    width: x - gapX,
    height: y - gapY,
  };
}

/**
 * Next-fit shelves: blocks left to right in input order, a new row when
 * the next one would pass `maxWidth` (a block wider than that gets a row
 * of its own), each row as tall as its tallest block, blocks set at the
 * top of their row.
 */
export function packShelves(
  sizes: readonly PackSize[],
  maxWidth: number,
  gapX: number,
  gapY: number
): Packed {
  const positions: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const size of sizes) {
    if (x > 0 && x + size.width > maxWidth) {
      y += rowHeight + gapY;
      x = 0;
      rowHeight = 0;
    }
    positions.push({ x, y });
    width = Math.max(width, x + size.width);
    rowHeight = Math.max(rowHeight, size.height);
    x += size.width + gapX;
  }
  return { positions, width, height: sizes.length === 0 ? 0 : y + rowHeight };
}

/**
 * The shelf width for `sizes`: wide enough for the widest block and for
 * `fill` (what sits above), else about `aspect` times as wide as the
 * blocks would stand tall in a square of the same area.
 */
export function shelfWidth(
  sizes: readonly PackSize[],
  aspect: number,
  fill = 0
): number {
  let area = 0;
  let widest = 0;
  for (const size of sizes) {
    area += size.width * size.height;
    widest = Math.max(widest, size.width);
  }
  return Math.max(widest, fill, Math.sqrt(area * aspect));
}
