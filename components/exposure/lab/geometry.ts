// Layout helpers for the lab-results charts: a squarified treemap, log scales, rough text widths and a
// greedy label placer. Pure (no DOM), so the tests can pin them down.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Node<T> {
  item: T;
  a: number;
}

function worst<T>(row: Node<T>[], side: number): number {
  let s = 0;
  let max = 0;
  let min = Infinity;
  for (const n of row) {
    s += n.a;
    if (n.a > max) max = n.a;
    if (n.a < min) min = n.a;
  }
  if (!(s > 0) || !(side > 0) || !(min > 0)) return Infinity;
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

function layoutRow<T>(row: Node<T>[], r: Rect, out: (Rect & { item: T })[]): Rect {
  const s = row.reduce((acc, n) => acc + n.a, 0);
  if (r.w >= r.h) {
    // A column along the left edge, as tall as the rectangle.
    const colW = r.h > 0 ? s / r.h : 0;
    let y = r.y;
    for (const n of row) {
      const h = colW > 0 ? n.a / colW : 0;
      out.push({ x: r.x, y, w: colW, h, item: n.item });
      y += h;
    }
    return { x: r.x + colW, y: r.y, w: Math.max(0, r.w - colW), h: r.h };
  }
  // A row along the top edge, as wide as the rectangle.
  const rowH = r.w > 0 ? s / r.w : 0;
  let x = r.x;
  for (const n of row) {
    const w = rowH > 0 ? n.a / rowH : 0;
    out.push({ x, y: r.y, w, h: rowH, item: n.item });
    x += w;
  }
  return { x: r.x, y: r.y + rowH, w: r.w, h: Math.max(0, r.h - rowH) };
}

/** Squarified treemap (Bruls, Huizing, van Wijk): each item's area is proportional to its share. */
export function squarify<T extends { share: number }>(items: readonly T[], rect: Rect): (Rect & { item: T })[] {
  const valid = items.filter((i) => Number.isFinite(i.share) && i.share > 0);
  const total = valid.reduce((s, i) => s + i.share, 0);
  if (!(total > 0) || !(rect.w > 0) || !(rect.h > 0)) return [];
  const area = rect.w * rect.h;
  const nodes: Node<T>[] = valid.map((item) => ({ item, a: (item.share / total) * area })).sort((a, b) => b.a - a.a);
  const out: (Rect & { item: T })[] = [];
  let r: Rect = { ...rect };
  let row: Node<T>[] = [];
  let i = 0;
  while (i < nodes.length) {
    const side = Math.min(r.w, r.h);
    const next = nodes[i];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      i++;
    } else {
      r = layoutRow(row, r, out);
      row = [];
    }
  }
  if (row.length) layoutRow(row, r, out);
  return out;
}

/** A log scale from [lo, hi] onto [a, b]. */
export function logScale(lo: number, hi: number, a: number, b: number): (v: number) => number {
  const span = Math.log(hi / lo) || 1;
  return (v: number) => a + ((Math.log(Math.max(v, 1e-300) / lo) / span) * (b - a));
}

/** Rough rendered width of `s` in the condensed sans at `size` px (caps + letter-spacing run wider). */
export function textWidth(s: string, size: number, caps = false, spacing = 0): number {
  return s.length * (size * (caps ? 0.6 : 0.5) + spacing);
}

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "end";
}

/**
 * Labels next to vertical lines at `x`: to the right of the line when it fits, else to its left, in the
 * first row (y) where it does not overlap a label already placed. Returns positions in input order.
 */
export function placeLabels(items: readonly { x: number; width: number }[], width: number, rows: readonly number[], gap = 4): PlacedLabel[] {
  const taken: [number, number][][] = rows.map(() => []);
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.x - b.x);
  const out: PlacedLabel[] = new Array(items.length);
  for (const it of order) {
    const right: [number, number] = [it.x + gap, it.x + gap + it.width];
    const left: [number, number] = [it.x - gap - it.width, it.x - gap];
    const candidates: { span: [number, number]; anchor: "start" | "end"; x: number }[] = [];
    if (right[1] <= width - 1) candidates.push({ span: right, anchor: "start", x: it.x + gap });
    if (left[0] >= 1) candidates.push({ span: left, anchor: "end", x: it.x - gap });
    if (!candidates.length) candidates.push(it.x > width / 2 ? { span: left, anchor: "end", x: it.x - gap } : { span: right, anchor: "start", x: it.x + gap });
    let placed = false;
    for (let r = 0; r < rows.length && !placed; r++) {
      for (const c of candidates) {
        if (taken[r].every(([a, b]) => c.span[1] + 6 <= a || c.span[0] >= b + 6)) {
          taken[r].push(c.span);
          out[it.i] = { x: c.x, y: rows[r], anchor: c.anchor };
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      const c = candidates[0];
      out[it.i] = { x: c.x, y: rows[rows.length - 1], anchor: c.anchor };
    }
  }
  return out;
}
