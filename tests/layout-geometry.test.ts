import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_LAYOUT, normalizeLayoutGeometry} from '../src/features/card-scanner/acquisition/layout-geometry';

test('reference 1440p anchor yields the fixed 10x4 grid and chrome boxes', () => {
  const layout = normalizeLayoutGeometry({x: 1000, y: 100, scale: 1}, 2560, 1440);
  assert.equal(layout.cells.length, 40);
  assert.deepEqual(layout.cells[0], {x: 338, y: 286, width: 140, height: 210});
  assert.deepEqual(layout.cells[9], {x: 1754, y: 286, width: 140, height: 210});
  assert.deepEqual(layout.cells[39], {x: 1754, y: 1014, width: 140, height: 210});
  assert.deepEqual(layout.header, {x: 1126, y: 98, width: 200, height: 34});
  assert.deepEqual(layout.growthPoints, {x: 1710, y: 94, width: 230, height: 34});
  assert.deepEqual(layout.sort, {x: 1718, y: 201, width: 210, height: 40});
  assert.deepEqual(layout.scrollbar, {x: 1910, y: 286, width: 16, height: 942});
  assert.deepEqual(layout.area, {x: 338, y: 286, width: 1562, height: 942});
  assert.equal(layout.geometry?.visibleCells, 40);
  assert.equal(layout.geometry?.source, 'anchor-default');
  assert.equal(layout.geometry?.columns, DEFAULT_LAYOUT.columns);
  assert.equal(layout.geometry?.rows, DEFAULT_LAYOUT.rows);
  assert.equal(layout.geometry?.cardAspect, 2 / 3);
  assert.deepEqual(layout.geometry?.bounds, {x: 338, y: 286, width: 1556, height: 938});
});

test('the card grid has the measured pitch: columns 472/3 and rows 728/3 apart', () => {
  // The anchor of the 2560x1440 share the pitch was measured on (docs/card-image-structure.md).
  const layout = normalizeLayoutGeometry({x: 800, y: 206, scale: 1}, 2560, 1440);
  assert.deepEqual(layout.cells.slice(0, 10).map(cell => cell.x), [138, 295, 453, 610, 767, 925, 1082, 1239, 1397, 1554]);
  assert.deepEqual([0, 10, 20, 30].map(index => layout.cells[index].y), [392, 635, 877, 1120]);
  // The chrome around the grid keeps its place.
  assert.deepEqual(layout.scrollbar, {x: 1710, y: 392, width: 16, height: 942});
  assert.deepEqual(layout.area, {x: 138, y: 392, width: 1562, height: 942});
});

test('1080p, 720p and 4K holdout scales keep the same relative grid', () => {
  const cases = [
    {scale: .75, x: 750, y: 75, width: 1920, height: 1080, first: {x: 254, y: 215, width: 105, height: 157.5}},
    {scale: .5, x: 500, y: 50, width: 1280, height: 720, first: {x: 169, y: 143, width: 70, height: 105}},
    {scale: 1.5, x: 1500, y: 150, width: 3840, height: 2160, first: {x: 507, y: 429, width: 210, height: 315}},
  ];
  for (const item of cases) {
    const layout = normalizeLayoutGeometry({x: item.x, y: item.y, scale: item.scale}, item.width, item.height);
    assert.deepEqual(layout.cells[0], item.first, `${item.width}x${item.height} first cell`);
    assert.equal(layout.cells.length, 40);
    assert.equal(layout.geometry?.visibleCells, 40, `${item.width}x${item.height} visible cells`);
    assert.equal(layout.geometry?.gridScale, item.scale);
    assert.equal(layout.geometry?.cardAspect, 2 / 3);
  }
});

test('uniform scaling preserves the reference cell positions within rounding', () => {
  const reference = normalizeLayoutGeometry({x: 1000, y: 100, scale: 1}, 2560, 1440);
  for (const factor of [.75, .5, 1.5]) {
    const scaled = normalizeLayoutGeometry(
      {x: 1000 * factor, y: 100 * factor, scale: factor},
      2560 * factor,
      1440 * factor,
    );
    for (const index of [0, 9, 39]) {
      assert.ok(Math.abs(scaled.cells[index].x - Math.round(reference.cells[index].x * factor)) <= 1,
        `cell ${index} x at ${factor}`);
      assert.ok(Math.abs(scaled.cells[index].y - Math.round(reference.cells[index].y * factor)) <= 1,
        `cell ${index} y at ${factor}`);
      assert.equal(scaled.cells[index].width, reference.cells[index].width * factor);
      assert.equal(scaled.cells[index].height, reference.cells[index].height * factor);
    }
  }
});

test('observed grid can differ from the header anchor without breaking card aspect', () => {
  const layout = normalizeLayoutGeometry(
    {x: 1000, y: 100, scale: 1},
    2560,
    1440,
    {cardWidth: 154, cardHeight: 231, columnStep: 173.25, rowStep: 267.3},
  );
  assert.deepEqual(layout.cells[0], {x: 272, y: 305, width: 154, height: 231});
  assert.equal(layout.geometry?.source, 'observed-grid');
  assert.equal(layout.geometry?.anchorScale, 1);
  assert.equal(layout.geometry?.gridScale, 1.1);
  assert.equal(layout.geometry?.cardAspect, 2 / 3);
  assert.deepEqual(layout.header, {x: 1126, y: 98, width: 200, height: 34});
});

test('observed column and row steps actually move the cells', () => {
  const layout = normalizeLayoutGeometry({x: 1000, y: 100, scale: 1}, 2560, 1440, {
    cardWidth: 140, cardHeight: 210, columnStep: 170, rowStep: 250, gridX: -662, gridY: 186,
  });
  assert.deepEqual(layout.cells[0], {x: 338, y: 286, width: 140, height: 210});
  assert.deepEqual(layout.cells[1], {x: 508, y: 286, width: 140, height: 210});
  assert.deepEqual(layout.cells[10], {x: 338, y: 536, width: 140, height: 210});
  assert.equal(layout.geometry?.columnStep, 170);
  assert.equal(layout.geometry?.rowStep, 250);
});

test('invalid origin, media size and observed grid are rejected', () => {
  assert.throws(() => normalizeLayoutGeometry({x: 0, y: 0, scale: 0}, 1920, 1080), /배율/u);
  assert.throws(() => normalizeLayoutGeometry({x: 0, y: 0, scale: 1}, 0, 1080), /화면 크기/u);
  assert.throws(() => normalizeLayoutGeometry({x: 0, y: 0, scale: 1}, 1920, 1080,
    {cardWidth: 140, cardHeight: 210, columnStep: 100, rowStep: 243}), /간격/u);
  assert.throws(() => normalizeLayoutGeometry({x: 0, y: 0, scale: 1}, 1920, 1080,
    {cardWidth: 140, cardHeight: 280, columnStep: 157.5, rowStep: 300}), /2:3/u);
});
