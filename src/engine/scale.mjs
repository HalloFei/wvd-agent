/**
 * The snapshot downscaler (contracts §5 `capture { maxWidth }`): pure functions over a top-down BGRA
 * buffer, with no window and no native call, so the awkward arithmetic is unit-tested without a game.
 *
 * Only the escalation snapshot comes here. The perception loop encodes its frames at the native size
 * and never calls this module, which is why a snapshot can cost the loop nothing.
 */

/**
 * The size a `maxWidth` request produces for a `width`×`height` frame.
 *
 * The width is the request itself, the height is proportional and rounded to the nearest row, and a
 * height that would round to zero is one row. A request at or above the native width returns the
 * native size: the snapshot is never upscaled. `maxWidth` below 1 or not an integer is a caller bug,
 * not something to clamp — the wire codec rejects it first.
 */
export function scaledSize(width, height, maxWidth) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`scale: frame width ${width} is not a positive integer`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError(`scale: frame height ${height} is not a positive integer`);
  }
  if (!Number.isInteger(maxWidth) || maxWidth < 1) {
    throw new RangeError(`scale: maxWidth ${maxWidth} is not a positive integer`);
  }
  if (maxWidth >= width) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/**
 * A box filter: every target pixel averages the source pixels its box covers. The box edges are
 * rounded, so adjacent boxes share an edge and the integer ranges tile the source exactly — a
 * non-integer reduction ratio covers every column and row once, never twice, and the answer at a
 * hard boundary is the true average of the two sides rather than a half-pixel smear.
 *
 * Returns `{ pixels, width, height }`; when the request does not shrink the frame (a too-large
 * `maxWidth`, or an exact match) the source buffer is returned as-is, so nothing is copied.
 */
export function scaleBgra(bgra, width, height, maxWidth) {
  const target = scaledSize(width, height, maxWidth);
  if (target.width === width && target.height === height) return { pixels: bgra, width, height };

  const { width: targetWidth, height: targetHeight } = target;
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const x0 = new Uint32Array(targetWidth);
  const x1 = new Uint32Array(targetWidth);
  const y0 = new Uint32Array(targetHeight);
  const y1 = new Uint32Array(targetHeight);
  for (let x = 0; x < targetWidth; x++) {
    x0[x] = Math.round((x * width) / targetWidth);
    x1[x] = Math.round(((x + 1) * width) / targetWidth);
    if (x1[x] <= x0[x]) x1[x] = Math.min(width, x0[x] + 1); // empty box: never happens while downscaling
  }
  for (let y = 0; y < targetHeight; y++) {
    y0[y] = Math.round((y * height) / targetHeight);
    y1[y] = Math.round(((y + 1) * height) / targetHeight);
    if (y1[y] <= y0[y]) y1[y] = Math.min(height, y0[y] + 1);
  }

  for (let ty = 0; ty < targetHeight; ty++) {
    const rows = y1[ty] - y0[ty];
    for (let tx = 0; tx < targetWidth; tx++) {
      const left = x0[tx];
      const right = x1[tx];
      const count = (right - left) * rows;
      let blue = 0;
      let green = 0;
      let red = 0;
      let alpha = 0;
      for (let sy = y0[ty]; sy < y1[ty]; sy++) {
        let offset = (sy * width + left) * 4;
        for (let sx = left; sx < right; sx++, offset += 4) {
          blue += bgra[offset];
          green += bgra[offset + 1];
          red += bgra[offset + 2];
          alpha += bgra[offset + 3];
        }
      }
      const at = (ty * targetWidth + tx) * 4;
      out[at] = Math.round(blue / count);
      out[at + 1] = Math.round(green / count);
      out[at + 2] = Math.round(red / count);
      out[at + 3] = Math.round(alpha / count);
    }
  }
  return { pixels: out, width: targetWidth, height: targetHeight };
}
