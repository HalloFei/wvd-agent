/**
 * The numerals reader: a **general** reader for the game's coordinate font — no per-digit templates.
 *
 * The map's readout (`X: 16  Y: 4`) is one line of the game's numeral font on a dark band. Reading it
 * used to mean a committed 8x12 template per digit, so every readout that first reached a digit the
 * atlas lacked refused the whole map (2026-11-07: `X: 16` stalled the farm for 45 s and stopped the
 * run because no `6` had ever been committed). A pile of shapes is not a reader: it knows only the
 * digits somebody already met (operator, 2026-11-07).
 *
 * This module reads the **shape of the numeral** instead: a glyph is classified from what every digit
 * of any font must carry — its holes, where they sit, and how its ink is distributed over the
 * columns and rows:
 *
 * | digit | what it is | how it is told |
 * | --- | --- | --- |
 * | 8 | two counters | two enclosed holes |
 * | 0, 6, 9 | one counter | one hole: centred / lower / upper |
 * | 4 | a closed triangle over a stem | one small upper hole and a full right stem |
 * | 1 | a stem | narrow, one column band, no bar rows |
 * | 7 | a bar and a diagonal | top bar, no bottom bar |
 * | 3 | two right bowls | no hole, bottom bar, ink on the right half only |
 * | 5 | a top bar and a lower bowl | no hole, bottom bar, upper-left ink, lower-right ink |
 * | 2 | a top bar, a diagonal, a base | no hole, bottom bar, lower-left ink, upper-right ink |
 *
 * A glyph the rules cannot place answers `null` — the caller refuses the number rather than guessing,
 * and a *new* digit needs rules, not another committed shape. The sign is read the same way: a short
 * horizontal bar on the middle rows is `-`.
 */

/** One numeral glyph: a binarised mask, row-major, ink true. */
export interface GlyphMask {
  readonly width: number;
  readonly height: number;
  /** `width * height` entries, row-major. */
  readonly ink: readonly boolean[];
}

/** The number a run of glyphs spells; `null` when any glyph cannot be named. */
export interface ReadInteger {
  readonly value: number;
  readonly digits: string;
}

interface Features {
  readonly width: number;
  readonly height: number;
  readonly holes: number;
  /** The single hole's centre, 0 (top) to 1 (bottom); 0.5 when there is no hole. */
  readonly holeY: number;
  readonly topBar: number;
  readonly bottomBar: number;
  /** The fullest row in the middle third: a crossbar (4, 5) or a bowl's edge (3, 2). */
  readonly midBar: number;
  readonly leftInk: number;
  readonly rightInk: number;
  readonly upperLeft: number;
  readonly lowerRight: number;
  readonly lowerLeft: number;
  readonly upperRight: number;
  readonly stemRight: boolean;
}

/** A run of glyphs read left to right; an empty run is not a number. */
export function readInteger(glyphs: readonly GlyphMask[]): ReadInteger | null {
  if (glyphs.length === 0) return null;
  let sign = 1;
  let from = 0;
  const first = glyphs[0]!;
  if (isMinus(first)) {
    sign = -1;
    from = 1;
  }
  const digits: string[] = [];
  for (let index = from; index < glyphs.length; index += 1) {
    const digit = readDigit(glyphs[index]!);
    if (digit === null) return null;
    digits.push(digit);
  }
  if (digits.length === 0) return null;
  const value = Number(digits.join(''));
  if (!Number.isInteger(value)) return null;
  return { value: sign * value, digits: digits.join('') };
}

/** One glyph to its digit, from the shape a numeral must have. */
export function readDigit(glyph: GlyphMask): string | null {
  const f = features(glyph);
  if (f === null) return null;
  if (f.holes >= 2) return '8';
  if (f.holes === 1) {
    // 4's counter is the triangle over the stem's top; 9's is its bowl. The two are told apart by
    // which half the ink leaves empty: 4 has no upper left, 9 no lower left (measured 2026-11-07).
    if (f.stemRight && f.upperLeft > f.lowerLeft) return '9';
    if (f.stemRight && f.upperLeft <= f.lowerLeft) return '4';
    if (f.holeY >= 0.55) return '6';
    if (f.holeY <= 0.45) return '9';
    return '0';
  }
  // No hole: the bar-and-stroke shapes, from the corpus's own measurements.
  if (f.width <= 5) return '1';
  if (f.midBar >= f.width * 0.6 && f.stemRight && f.topBar < f.width * 0.6) return '4';
  if (f.midBar >= f.width * 0.55 && !f.stemRight) return '5';
  if (f.bottomBar >= f.width * 0.5 && f.lowerLeft > f.upperLeft && f.rightInk <= f.leftInk * 1.35) return '2';
  if (f.bottomBar >= f.width * 0.5 && f.rightInk > f.leftInk * 1.25 && f.topBar >= f.width * 0.45) return '3';
  if (f.topBar < f.width * 0.5 && f.rightInk > f.leftInk * 1.5) return '7';
  return null;
}

/** A short horizontal bar on the middle rows: the sign. */
function isMinus(glyph: GlyphMask): boolean {
  if (glyph.width < 2 || glyph.width > 6) return false;
  let ink = 0;
  for (const value of glyph.ink) if (value) ink += 1;
  if (ink < 3) return false;
  const rows = new Array<number>(glyph.height).fill(0);
  for (let y = 0; y < glyph.height; y += 1) {
    for (let x = 0; x < glyph.width; x += 1) if (glyph.ink[y * glyph.width + x] === true) rows[y] += 1;
  }
  const lit = rows.filter((count) => count >= 2).length;
  return lit >= 1 && lit <= 3 && ink >= glyph.width * lit * 0.6;
}

/** The measurements every rule above reads, or null for an empty or full glyph. */
export function describeGlyph(glyph: GlyphMask): Features | null {
  return features(glyph);
}

/** The glyph cut down to its own ink: the band's empty rows are not the numeral's shape. */
function cropToInk(glyph: GlyphMask): GlyphMask | null {
  const { width, height, ink } = glyph;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (ink[y * width + x] !== true) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const bits: boolean[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) bits.push(ink[y * width + x] === true);
  }
  return { width: w, height: h, ink: bits };
}

function features(glyph: GlyphMask): Features | null {
  const cropped = cropToInk(glyph);
  if (cropped === null) return null;
  const { width, height, ink } = cropped;
  if (width < 2 || height < 6) return null;
  let total = 0;
  for (const value of ink) if (value) total += 1;
  if (total === 0 || total >= width * height * 0.9) return null;

  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && ink[y * width + x] === true;

  // Holes: background cells not reachable from the border, 4-connected.
  const seen = new Uint8Array(width * height);
  const holes: Array<{ sumX: number; sumY: number; count: number }> = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (at(x, y) || seen[start] === 1) continue;
      const stack = [start];
      seen[start] = 1;
      let border = false;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      while (stack.length > 0) {
        const index = stack.pop()!;
        const cx = index % width;
        const cy = (index - cx) / width;
        count += 1;
        sumX += cx;
        sumY += cy;
        if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) border = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (seen[next] === 0 && !at(nx, ny)) { seen[next] = 1; stack.push(next); }
        }
      }
      if (!border && count >= 1) holes.push({ sumX, sumY, count });
    }
  }

  const topBar = rowInk(0) + rowInk(1);
  const bottomBar = rowInk(height - 1) + rowInk(height - 2);
  const third = Math.max(1, Math.floor(height / 3));
  let midBar = 0;
  for (let y = third; y < height - third; y += 1) midBar = Math.max(midBar, rowInk(y));
  const upperLeft = blockInk(0, width / 2, 0, third);
  const upperRight = blockInk(width / 2, width, 0, third);
  const lowerLeft = blockInk(0, width / 2, height - third, height);
  const lowerRight = blockInk(width / 2, width, height - third, height);
  const leftInk = blockInk(0, width / 2, 0, height);
  const rightInk = blockInk(width / 2, width, 0, height);
  // The right stem: the last two columns lit over most of the glyph.
  let stem = 0;
  for (let y = 0; y < height; y += 1) if (at(width - 1, y) || at(width - 2, y)) stem += 1;

  const hole = holes.length === 1 ? holes[0]! : null;
  return {
    width,
    height,
    holes: holes.length,
    holeY: hole === null ? 0.5 : hole.sumY / hole.count / Math.max(1, height - 1),
    topBar,
    bottomBar,
    midBar,
    leftInk,
    rightInk,
    upperLeft,
    lowerRight,
    lowerLeft,
    upperRight,
    stemRight: stem >= height * 0.6,
  };

  function rowInk(y: number): number {
    let count = 0;
    for (let x = 0; x < width; x += 1) if (at(x, y)) count += 1;
    return count;
  }

  function blockInk(x0: number, x1: number, y0: number, y1: number): number {
    let count = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) if (at(x, y)) count += 1;
    }
    return count;
  }
}
