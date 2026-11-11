import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanGrid } from '../src/features/card-scanner/session/scan-grid';
import { InventoryPosition } from '../src/features/card-scanner/session/inventory-position';

// Exercise the same two objects the scanner uses: reading work is independent
// of whether an absolute inventory row can yet be assigned.
test('middle-first work survives until an overlapping settled top anchors its real rows', () => {
  const grid = new ScanGrid();
  const positions = new InventoryPosition();
  const geometry = (step:number) => ({position:step / 51, pageSpan:4 / 51.6});
  const middle = Array.from({length:40}, (_,slot) => 31 + slot);
  grid.geometry(55);
  grid.begin(true);
  middle.forEach((group,slot) => grid.group(slot,group,1000 + group,true));
  grid.record(1);
  assert.deepEqual(positions.capture(1,middle,geometry(3),true), []);
  const reading = grid.start(1032)!;
  const completed = grid.start(1031)!;
  grid.finish(1031,'read',completed);
  grid.finish(1033,'review');
  let view = grid.snapshot();
  assert.deepEqual(view.recentFrame!.cells.slice(0,4).map(cell => cell.status), ['read','reading','review','waiting']);
  assert.equal(view.inventory!.length,0,'a scrollbar-only guess cannot establish a card row');
  assert.ok(view.recentFrame!.cells.every(cell => cell.row === undefined));

  // The final row of the top viewport overlaps ten same-column cards in the
  // earlier middle viewport. The endpoint anchors the top; overlap then
  // reconnects the previous frame without relying on guessed count or order.
  const top = Array.from({length:40}, (_,slot) => 1 + slot);
  grid.begin(true);
  top.forEach((group,slot) => grid.group(slot,group,1000 + group,group < 31));
  grid.record(2);
  const resolved = positions.capture(2,top,geometry(0),true);
  assert.deepEqual(resolved,[{frame:2,top:1},{frame:1,top:4}]);
  for(const result of resolved) grid.register(result.frame,result.top);
  view = grid.snapshot();
  assert.equal(view.inventory![0].status,'waiting');
  assert.deepEqual(view.inventory!.slice(30,34).map(cell => cell.status), ['read','reading','review','waiting']);
  assert.equal(view.inventory![69].row,7);
  assert.equal(view.inventory!.length,70);
  assert.equal(view.recentFrame!.frame,2);
  assert.equal(view.recentFrame!.cells[30].status,'read');
  grid.finish(1032,'read',reading);
  assert.equal(grid.snapshot().inventory![31].status,'read','late completion belongs to the anchored observation');
  assert.equal(grid.snapshot().inventory![32].status,'review','a neighboring unresolved observation stays unresolved');
});
