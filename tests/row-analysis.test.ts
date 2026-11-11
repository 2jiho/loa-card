import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeRows,EMPTY,UNIDENTIFIED,UNUSABLE} from '../dev/row-analysis';
import type {RowFrame} from '../dev/row-analysis';

const LIST_ROWS=8;                                   // a list of 8 rows: card id = row*10 + column
/** A frame showing list rows top..top+3. `spoil` marks slots unusable; keys change with `shift`. */
function frame(time:number,top:number,options:{spoil?:number[];unknown?:number[];shift?:number;position?:number|null}={}):RowFrame {
  const slots=Array.from({length:40},(_,slot)=>(top+Math.floor(slot/10))*10+slot%10);
  for(const slot of options.spoil??[])slots[slot]=UNUSABLE;
  for(const slot of options.unknown??[])slots[slot]=UNIDENTIFIED;
  const keys=slots.map((code,slot)=>code===UNUSABLE?-1:(top*100+slot)*10+(options.shift??0));
  const position=options.position===undefined?top/(LIST_ROWS-4):options.position;
  return {time,position,pageSpan:position===null?null:4/(LIST_ROWS-4),slots,keys};
}

test('frames are chained by shared cards and a scrollbar that tracks the rows is read as exact', () => {
  const result=analyzeRows([frame(0,0),frame(1,0),frame(2,1),frame(3,2),frame(4,4),frame(5,4)]);
  assert.deepEqual({placed:result.placedFrames,segments:result.segments,conflicts:result.conflicts,rows:result.listRows,cards:result.cards},
    {placed:6,segments:1,conflicts:0,rows:8,cards:80});
  assert.deepEqual({exact:result.scrollbar.exact,max:result.scrollbar.maxError,rows:result.scrollbar.rowsFromThumb},{exact:1,max:0,rows:8});
  // Row 0 was shown by two frames, both clean; the second had the pixels of the first.
  assert.deepEqual(result.rows[0],{row:0,shown:2,clean:2,rest:1,firstCleanTime:0,cards:10});
  // Rows 4..7 were shown twice at the end, clean both times, at rest once.
  assert.deepEqual(result.rows[7],{row:7,shown:2,clean:2,rest:1,firstCleanTime:4,cards:10});
  assert.deepEqual(result.rowSummary.neverClean,[]);
});

test('a row whose only looks had an unusable slot is never clean; unidentified and empty slots do not spoil a row', () => {
  const frames=[
    frame(0,0,{spoil:[35]}),                               // row 3 has an unusable slot
    frame(1,1,{spoil:[25],unknown:[3]}),                   // row 3 again unusable; row 1 has an unidentified card
    frame(2,4),
  ];
  // Row 7's last two slots are empty slots of a partial last row.
  const last={...frames[2],slots:frames[2].slots.map((code,slot)=>slot>=38?EMPTY:code)};
  const result=analyzeRows([frames[0],frames[1],last]);
  assert.deepEqual(result.rowSummary.neverClean,[3]);
  assert.equal(result.rows[1].clean,2);                    // the unidentified card did not spoil row 1
  assert.equal(result.rows[7].clean,1);                    // empty slots did not spoil the last row
  assert.equal(result.rows[4].shown,2);                    // rows 4 shown by frames 1 and 2
  assert.equal(result.cards,77);                           // 80 minus the never-usable card and the two empty slots
});

test('a scrollbar that is off by a row is reported, and pixels that moved are not a rest', () => {
  // The thumb says row 1 while the cards say row 2.
  // Frames 10 ms apart: no thumb reading is old enough to be taken as settled.
  const result=analyzeRows([frame(0,0),frame(.01,1),frame(.02,2,{position:1/(LIST_ROWS-4)}),frame(.03,2,{shift:1,position:2/(LIST_ROWS-4)})]);
  assert.equal(result.scrollbar.maxError,1);
  assert.equal(result.scrollbar.exact,.75);
  assert.equal(result.scrollbar.withinOne,1);
  assert.equal(result.rows[5].rest,0);                     // same rows twice, but the pixels differed
  assert.equal(result.rows[5].clean,2);
  // The thumb was one row behind the cards in one frame.
  assert.deepEqual(result.scrollbar.lead,[{rows:-1,frames:1},{rows:0,frames:3}]);
});

test('the list offset comes from frames whose thumb has not moved for a while; a moving thumb leads the cards', () => {
  // Scrolling down: the thumb reaches row 2 while the cards still show rows 0 and 1, then everything settles.
  const result=analyzeRows([frame(0,0),frame(1,0),frame(1.03,0,{position:2/(LIST_ROWS-4)}),frame(1.06,1,{position:2/(LIST_ROWS-4)}),
    frame(1.09,2,{position:2/(LIST_ROWS-4)}),frame(2,2,{position:2/(LIST_ROWS-4)})]);
  assert.deepEqual(result.scrollbar.lead,[{rows:0,frames:4},{rows:1,frames:1},{rows:2,frames:1}]);
  assert.deepEqual(result.scrollbar.bySettle.map(bucket=>[bucket.untilMs,bucket.frames,bucket.exact]),
    [[50,3,1],[100,1,1],[200,0,0],[400,0,0],[null,2,2]]);
});

test('a jump of four rows shares no card, so the scrollbar places the second chain in the list', () => {
  const result=analyzeRows([frame(0,0),frame(1,4),frame(2,4),{...frame(3,2),slots:Array<number>(40).fill(UNUSABLE)}]);
  assert.deepEqual({segments:result.segments,placed:result.placedFrames,rows:result.listRows,cards:result.cards,cross:result.crossConflicts},
    {segments:2,placed:3,rows:8,cards:80,cross:0});
  assert.equal(result.rows[4].clean,2);
});

test('a frame that overlaps two chains joins them by their cards; the wrong thumb reading is then only a scrollbar error', () => {
  // The jump lands on rows 4..7 but the thumb says 3..6; later frames overlap both chains.
  const result=analyzeRows([frame(0,0),frame(1,4,{position:3/(LIST_ROWS-4)}),frame(2,1),frame(3,2)]);
  assert.deepEqual({segments:result.segments,conflicts:result.conflicts,cross:result.crossConflicts,rows:result.listRows,cards:result.cards},
    {segments:1,conflicts:0,cross:0,rows:8,cards:80});
  assert.equal(result.scrollbar.maxError,1);
});
