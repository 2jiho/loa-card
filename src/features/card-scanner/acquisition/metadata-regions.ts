import type { Box, Layout } from './detector';

/** Integer patches preserve native pixels, including fractional crop sampling. */
export function metadataRegions(layout: Layout, width: number, height: number): Box[] {
  return [layout.header, layout.growthPoints, layout.sort, layout.scrollbar].flatMap(box => {
    const x = Math.max(0, Math.floor(box.x) - 1);
    const y = Math.max(0, Math.floor(box.y) - 1);
    const right = Math.min(width, Math.ceil(box.x + box.width) + 1);
    const bottom = Math.min(height, Math.ceil(box.y + box.height) + 1);
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  });
}
