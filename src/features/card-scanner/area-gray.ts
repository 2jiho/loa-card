/** Area integration, matching the atlas preparation instead of the browser's
 * implementation-dependent canvas downscaler. Every source pixel contributes
 * according to its overlap with an output bin, including fractional edges. */
export function areaGray(rgba: ArrayLike<number>, width: number, height: number, columns = 24, rows = 32) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < columns || height < rows ||
      rgba.length !== width * height * 4) throw new Error("Invalid portrait dimensions");
  const result = new Float32Array(columns * rows);
  const sx = width / columns, sy = height / rows;
  // Horizontal overlap is independent of the output row. Keep full Number
  // precision and the original multiplication/addition order at each pixel.
  const horizontal = Array.from({ length: columns }, (_, x) => {
    const left = x * sx, right = (x + 1) * sx, start = Math.floor(left);
    const end = Math.min(width, Math.ceil(right));
    return { start, weights: Array.from({ length: end - start }, (_, offset) => {
      const px = start + offset;
      return Math.min(right, px + 1) - Math.max(left, px);
    }) };
  });
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const top = y * sy, bottom = (y + 1) * sy, column = horizontal[x];
    let sum = 0;
    for (let py = Math.floor(top); py < Math.min(height, Math.ceil(bottom)); py++) {
      const wy = Math.min(bottom, py + 1) - Math.max(top, py);
      for (let offset = 0; offset < column.weights.length; offset++) {
        const px = column.start + offset;
        const weight = wy * column.weights[offset], i = (py * width + px) * 4;
        sum += weight * (.299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2]);
      }
    }
    result[y * columns + x] = sum / (sx * sy);
  }
  return result;
}
