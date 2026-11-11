export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedGeometry {
  version: 'anchor-relative-v1';
  source: 'anchor-default' | 'observed-grid';
  mediaWidth: number;
  mediaHeight: number;
  anchorScale: number;
  gridScale: number;
  columns: number;
  rows: number;
  cardAspect: number;
  columnStep: number;
  rowStep: number;
  visibleCells: number;
  bounds: Box;
}

export interface Layout {
  cells: Box[];
  header: Box;
  growthPoints: Box;
  sort: Box;
  growthScore: number;
  area: Box;
  scrollbar: Box;
  score: number;
  scale: number;
  geometry?: NormalizedGeometry;
}

export interface LayoutOrigin {
  x: number;
  y: number;
  scale: number;
}

/** Optional grid measurements from a later acquisition stage. The header
 * anchor defines the UI scale; these define the card grid independently. */
export interface ObservedGrid {
  cardWidth: number;
  cardHeight: number;
  columnStep: number;
  rowStep: number;
  /** Optional grid origin relative to the anchor, before gridScale. */
  gridX?: number;
  gridY?: number;
}

export const DEFAULT_LAYOUT = Object.freeze({
  columns: 10,
  rows: 4,
  gridX: -662,
  gridY: 186,
  columnStep: 157.5,
  rowStep: 243,
  cardWidth: 140,
  cardHeight: 210,
  growthPoints: Object.freeze({x: 710, y: -6, width: 230, height: 34}),
  sort: Object.freeze({x: 718, y: 101, width: 210, height: 40}),
  scrollbar: Object.freeze({x: 910, y: 186, width: 16, height: 942}),
  header: Object.freeze({x: 126, y: -2, width: 200, height: 34}),
  area: Object.freeze({x: -662, y: 186, width: 1562, height: 942}),
});

const CARD_ASPECT = 2 / 3;
const ASPECT_TOLERANCE = 0.03;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function scaled(origin: LayoutOrigin, scale: number, x: number, y: number, width: number, height: number): Box {
  return {
    x: origin.x + x * scale,
    y: origin.y + y * scale,
    width: width * scale,
    height: height * scale,
  };
}

function validateOrigin(origin: LayoutOrigin): void {
  if (!finite(origin.x) || !finite(origin.y) || !positive(origin.scale)) {
    throw new Error('레이아웃 원점과 배율이 올바르지 않습니다.');
  }
}

function validateObserved(observed: ObservedGrid): number {
  if (!positive(observed.cardWidth) || !positive(observed.cardHeight) ||
      !positive(observed.columnStep) || !positive(observed.rowStep) ||
      (observed.gridX !== undefined && !finite(observed.gridX)) ||
      (observed.gridY !== undefined && !finite(observed.gridY))) {
    throw new Error('관측 격자 값이 올바르지 않습니다.');
  }
  if (observed.columnStep < observed.cardWidth || observed.rowStep < observed.cardHeight) {
    throw new Error('관측 격자 간격이 카드 크기보다 작습니다.');
  }
  const aspect = observed.cardWidth / observed.cardHeight;
  if (Math.abs(aspect - CARD_ASPECT) > ASPECT_TOLERANCE) {
    throw new Error('관측 카드 비율이 2:3이 아닙니다.');
  }
  return observed.cardWidth / DEFAULT_LAYOUT.cardWidth;
}

/** Convert the detected anchor into the fixed 10x4 card grid. The header
 * anchor is authoritative for UI chrome; an optional observed grid can
 * override card size/spacing when the game uses a non-uniform UI scale. */
export function normalizeLayoutGeometry(
  origin: LayoutOrigin,
  mediaWidth: number,
  mediaHeight: number,
  observed?: ObservedGrid,
) {
  validateOrigin(origin);
  if (!positive(mediaWidth) || !positive(mediaHeight)) throw new Error('입력 화면 크기가 올바르지 않습니다.');
  const gridScale = observed ? validateObserved(observed) : origin.scale;
  const anchorScale = origin.scale;
  const cardWidth = observed?.cardWidth ?? DEFAULT_LAYOUT.cardWidth * gridScale;
  const cardHeight = observed?.cardHeight ?? DEFAULT_LAYOUT.cardHeight * gridScale;
  const columnStep = observed?.columnStep ?? DEFAULT_LAYOUT.columnStep * gridScale;
  const rowStep = observed?.rowStep ?? DEFAULT_LAYOUT.rowStep * gridScale;
  const gridX = observed?.gridX ?? DEFAULT_LAYOUT.gridX;
  const gridY = observed?.gridY ?? DEFAULT_LAYOUT.gridY;
  const cells: Box[] = [];
  for (let row = 0; row < DEFAULT_LAYOUT.rows; row++) {
    for (let column = 0; column < DEFAULT_LAYOUT.columns; column++) {
      cells.push({
        x: Math.round(origin.x + gridX * gridScale + column * columnStep),
        y: Math.round(origin.y + gridY * gridScale + row * rowStep),
        width: cardWidth,
        height: cardHeight,
      });
    }
  }
  const visibleCells = cells.filter(box =>
    box.x >= 0 && box.y >= 0 && box.x + box.width <= mediaWidth && box.y + box.height <= mediaHeight).length;
  const left = Math.min(...cells.map(box => box.x));
  const top = Math.min(...cells.map(box => box.y));
  const right = Math.max(...cells.map(box => box.x + box.width));
  const bottom = Math.max(...cells.map(box => box.y + box.height));
  const geometry: NormalizedGeometry = {
    version: 'anchor-relative-v1',
    source: observed ? 'observed-grid' : 'anchor-default',
    mediaWidth,
    mediaHeight,
    anchorScale,
    gridScale,
    columns: DEFAULT_LAYOUT.columns,
    rows: DEFAULT_LAYOUT.rows,
    cardAspect: cardWidth / cardHeight,
    columnStep,
    rowStep,
    visibleCells,
    bounds: {x: left, y: top, width: right - left, height: bottom - top},
  };
  return {
    cells,
    growthPoints: scaled(origin, anchorScale, DEFAULT_LAYOUT.growthPoints.x, DEFAULT_LAYOUT.growthPoints.y,
      DEFAULT_LAYOUT.growthPoints.width, DEFAULT_LAYOUT.growthPoints.height),
    sort: scaled(origin, anchorScale, DEFAULT_LAYOUT.sort.x, DEFAULT_LAYOUT.sort.y,
      DEFAULT_LAYOUT.sort.width, DEFAULT_LAYOUT.sort.height),
    scrollbar: scaled(origin, anchorScale, DEFAULT_LAYOUT.scrollbar.x, DEFAULT_LAYOUT.scrollbar.y,
      DEFAULT_LAYOUT.scrollbar.width, DEFAULT_LAYOUT.scrollbar.height),
    header: scaled(origin, anchorScale, DEFAULT_LAYOUT.header.x, DEFAULT_LAYOUT.header.y,
      DEFAULT_LAYOUT.header.width, DEFAULT_LAYOUT.header.height),
    area: scaled(origin, anchorScale, DEFAULT_LAYOUT.area.x, DEFAULT_LAYOUT.area.y,
      DEFAULT_LAYOUT.area.width, DEFAULT_LAYOUT.area.height),
    geometry,
  };
}
