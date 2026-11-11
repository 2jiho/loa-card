import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createListTable,estimateScrollSteps,SLOT_EMPTY,SLOT_UNIDENTIFIED,SLOT_UNUSABLE} from '../src/features/card-scanner/session/list-table';
import type {ListFrame} from '../src/features/card-scanner/session/list-table';

/** A frame showing list rows top..top+3 of a list whose card code is row*10 + column. */
function frame(time:number,top:number,thumb:{row:number|null;settledMs?:number}|null,change:(slots:number[])=>void=()=>{}):ListFrame {
  const slots=Array.from({length:40},(_,slot)=>(top+Math.floor(slot/10))*10+slot%10);
  change(slots);
  return {time,thumbRow:thumb?.row??null,settledMs:thumb?thumb.settledMs??0:null,slots};
}
const cards=(cells:readonly ({card:number|null}|null)[]|undefined)=>cells?.map(cell=>cell?.card??null);

test('a settled thumb anchors a frame; frames that share cards follow it while the thumb is moving', () => {
  const table=createListTable();
  assert.deepEqual(table.observe(frame(0,5,{row:5,settledMs:400})),{basis:'thumb',top:5});
  // Scrolling down: the thumb already says 8, the cards show rows 6..9. The cards decide.
  assert.deepEqual(table.observe(frame(.03,6,{row:8,settledMs:0})),{basis:'overlap',top:6});
  assert.deepEqual(table.observe(frame(.06,7,{row:8,settledMs:30})),{basis:'overlap',top:7});
  const snapshot=table.snapshot();
  assert.deepEqual([...snapshot.rows.keys()],[5,6,7,8,9,10]);
  assert.deepEqual(cards(snapshot.rows.get(10)),[100,101,102,103,104,105,106,107,108,109]);
  assert.equal(snapshot.rows.get(7)![0]!.looks,3);                // rows 7 and 8 were in all three frames
  assert.deepEqual(snapshot.floating,[]);
  assert.deepEqual({conflicts:snapshot.counts.overlapConflicts+snapshot.counts.anchorConflicts+snapshot.counts.cellConflicts,lead:snapshot.counts.leadViolations},
    {conflicts:0,lead:0});
});

test('a moving thumb is not a position: rows stay floating until a settled frame or known rows reach them', () => {
  const table=createListTable();
  assert.deepEqual(table.observe(frame(0,20,{row:22,settledMs:0})),{basis:'new',top:null});
  assert.deepEqual(table.observe(frame(.03,21,{row:23,settledMs:0})),{basis:'overlap',top:null});
  const [island]=table.snapshot().floating;
  assert.deepEqual({rows:island.rows,cards:island.cards,frames:island.frames,likelyTop:island.likelyTop},{rows:5,cards:50,frames:2,likelyTop:null});
  assert.deepEqual(island.cells[4].map(cell=>cell?.card),[240,241,242,243,244,245,246,247,248,249]);
  assert.equal(table.snapshot().rows.size,0);
  // The thumb comes to rest on the rows the cards now show: everything seen so far gets its place.
  assert.deepEqual(table.observe(frame(1,22,{row:22,settledMs:900})),{basis:'overlap',top:22});
  const snapshot=table.snapshot();
  assert.deepEqual([...snapshot.rows.keys()],[20,21,22,23,24,25]);
  assert.deepEqual(snapshot.floating,[]);
});

test('a jump with no shared card starts a second island; a later frame over the gap joins the two', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:500}));
  assert.deepEqual(table.observe(frame(.1,9,{row:12,settledMs:0})),{basis:'new',top:null});
  assert.equal(table.snapshot().floating.length,1);
  // Scrolling back: rows 3..6 share nothing with rows 0..3 beyond row 3, rows 6..9 link to the jump.
  assert.deepEqual(table.observe(frame(.2,3,{row:4,settledMs:0})),{basis:'overlap',top:3});
  assert.deepEqual(table.observe(frame(.3,6,{row:6,settledMs:0})),{basis:'overlap',top:6});
  const snapshot=table.snapshot();
  assert.deepEqual([...snapshot.rows.keys()],[0,1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.deepEqual({merges:snapshot.counts.merges,floating:snapshot.floating.length,anchor:snapshot.counts.anchorConflicts,cell:snapshot.counts.cellConflicts},
    {merges:1,floating:0,anchor:0,cell:0});
});

test('a floating island reports where it probably is from the moving thumb, without becoming a list row', () => {
  const table=createListTable();
  // Five frames while scrolling: the thumb is on the cards' row in three of them and ahead in two.
  [[30,30],[31,33],[32,32],[33,35],[34,34]].forEach(([top,thumb],index)=>table.observe(frame(index*.03,top,{row:thumb,settledMs:0})));
  const snapshot=table.snapshot();
  assert.equal(snapshot.rows.size,0);
  assert.deepEqual(snapshot.floating.map(island=>[island.rows,island.likelyTop,island.hintFrames,island.hintTotal]),[[8,30,3,5]]);
});

test('unusable slots are not recorded, empty and unidentified slots are, and a later frame may name an unidentified card', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:500},slots=>{slots[3]=SLOT_UNIDENTIFIED;slots[4]=SLOT_UNUSABLE;slots[38]=SLOT_EMPTY;slots[39]=SLOT_EMPTY;}));
  let snapshot=table.snapshot();
  assert.deepEqual(snapshot.rows.get(0)!.slice(2,6).map(cell=>cell?.state??null),['card','unidentified',null,'card']);
  assert.deepEqual(snapshot.rows.get(3)!.slice(8).map(cell=>cell?.state),['empty','empty']);
  table.observe(frame(1,0,{row:0,settledMs:500},slots=>{slots[38]=SLOT_EMPTY;slots[39]=SLOT_EMPTY;}));
  snapshot=table.snapshot();
  assert.deepEqual(snapshot.rows.get(0)!.slice(2,6).map(cell=>cell?.card??null),[2,3,4,5]);
  assert.equal(snapshot.counts.cellConflicts,0);
});

test('what does not fit is counted and never overwritten', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:500}));
  // The same rows again, but a settled thumb now says row 2: the first anchor stays.
  assert.deepEqual(table.observe(frame(1,0,{row:2,settledMs:500})),{basis:'overlap',top:0});
  assert.equal(table.snapshot().counts.anchorConflicts,1);
  // A slot shows another card than before (same place, different code).
  table.observe(frame(2,0,{row:0,settledMs:500},slots=>{slots[5]=9999;}));
  assert.equal(table.snapshot().counts.cellConflicts,1);
  assert.equal(table.snapshot().rows.get(0)![5]!.card,5);
  // Half of the frame's cards say one row, half another: the frame is not placed by them.
  const torn=frame(3,0,{row:null},slots=>{for(let slot=20;slot<40;slot++)slots[slot]+=10;});
  assert.equal(table.observe(torn).basis,'new');
  assert.equal(table.snapshot().counts.overlapConflicts,1);
  // A moving thumb far from where the cards are is only noted.
  table.observe(frame(4,1,{row:9,settledMs:0}));
  assert.equal(table.snapshot().counts.leadViolations,1);
});

test('a frame with nothing usable is not placed, and too few shared cards do not join islands', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:500}));
  assert.deepEqual(table.observe({time:1,thumbRow:3,settledMs:0,slots:Array<number>(40).fill(SLOT_UNUSABLE)}),{basis:'none',top:null});
  // Only two cards of row 3 are readable in the next frame: not enough to place it.
  const sparse=frame(2,3,{row:5,settledMs:0},slots=>{for(let slot=2;slot<10;slot++)slots[slot]=SLOT_UNUSABLE;});
  assert.equal(table.observe(sparse).basis,'new');
  assert.equal(table.snapshot().floating.length,1);
  assert.equal(table.snapshot().counts.cellConflicts,0);
});

test('the scroll step count is read from thumb positions and refused when they do not decide it', () => {
  const positions=[0,1,2,3,5,9,14,15,18,27,40,51].map(step=>step/51+(step%2?.0008:-.0006));
  assert.equal(estimateScrollSteps(positions.map(value=>Math.min(1,Math.max(0,value)))),51);
  // Two readings of the top that differ by a pixel do not hide the step.
  assert.equal(estimateScrollSteps([0,.0013,...positions.slice(1)]),51);
  assert.equal(estimateScrollSteps([0,.5,1]),null);                       // too few distinct positions
  assert.equal(estimateScrollSteps([0,.1013,.2291,.3377,.4519,.6113,.7411,.9007],{max:60}),null);   // no step count fits
});
