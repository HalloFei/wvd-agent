/**
 * The frame cropper (the `capture { crop }` counterpart of the snapshot downscaler): pure arithmetic
 * over a top-down BGRA buffer, with no window, no worker and no native call, so the rectangle copy is
 * unit-tested without a game.
 *
 * A QTE sample wants the bar's rectangle, not a whole 1920x1080 JPEG, so the encoder is to crop the
 * native frame before it encodes it. This module owns only the copy: keeping it free of the encoder,
 * its worker and the shared memory that feeds them is what lets the arithmetic be proven on its own.
 */

/**
 * Copy the `rect` out of a `width`×`height` top-down BGRA frame. Returns `{ pixels, width, height }`
 * describing the crop; a rect that covers the whole frame returns the source buffer itself, so a
 * caller that crops to the full frame copies nothing.
 *
 * A rect that is not four integers, has a negative origin or a non-positive size, or reaches past the
 * frame is a caller bug rather than something to clamp, so it throws `RangeError` naming the field.
 */
export function cropBgra(bgra, width, height, rect) {
  const { x, y, width: rectWidth, height: rectHeight } = rect ?? {};
  if (!Number.isInteger(x) || x < 0) {
    throw new RangeError(`crop: rect.x ${x} is not a non-negative integer`);
  }
  if (!Number.isInteger(y) || y < 0) {
    throw new RangeError(`crop: rect.y ${y} is not a non-negative integer`);
  }
  if (!Number.isInteger(rectWidth) || rectWidth <= 0) {
    throw new RangeError(`crop: rect.width ${rectWidth} is not a positive integer`);
  }
  if (!Number.isInteger(rectHeight) || rectHeight <= 0) {
    throw new RangeError(`crop: rect.height ${rectHeight} is not a positive integer`);
  }
  if (x + rectWidth > width || y + rectHeight > height) {
    throw new RangeError(
      `crop: rect ${x},${y} ${rectWidth}x${rectHeight} does not fit the ${width}x${height} frame`,
    );
  }
  if (x === 0 && y === 0 && rectWidth === width && rectHeight === height) {
    return { pixels: bgra, width, height };
  }

  const out = new Uint8Array(rectWidth * rectHeight * 4);
  const rowBytes = rectWidth * 4;
  for (let row = 0; row < rectHeight; row++) {
    const from = ((y + row) * width + x) * 4;
    out.set(bgra.subarray(from, from + rowBytes), row * rowBytes);
  }
  return { pixels: out, width: rectWidth, height: rectHeight };
}
