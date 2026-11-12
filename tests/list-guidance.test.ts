import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createListTable,SLOT_EMPTY,SLOT_UNIDENTIFIED,SLOT_UNUSABLE} from '../src/features/card-scanner/session/list-table';
import type {ListFrame} from '../src/features/card-scanner/session/list-table';
import {describeListGuidance,listGuidance} from '../src/features/card-scanner/session/list-guidance';

/** A frame showing list rows top..top+3 of a list whose card code is row*10 + column. */
function frame(time:number,top:number,thumb:{row:number|null;settledMs?:number}|null,change:(slots:number[])=>void=()=>{}):ListFrame {
  const slots=Array.from({length:40},(_,slot)=>(top+Math.floor(slot/10))*10+slot%10);
  change(slots);
  return {time,thumbRow:thumb?.row??null,settledMs:thumb?thumb.settledMs??0:null,slots};
}
const none=new Map<number,{name:string;reasons:readonly string[]}>();

test('rows the anchored list does not have are asked for when nothing waits for a place', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:400}));
  table.observe(frame(1,6,{row:6,settledMs:400}));
  const guidance=listGuidance(table.snapshot(),{totalRows:12,unconfirmed:none});
  assert.deepEqual(guidance.missingRows,[{from:4,to:5},{from:10,to:11}]);
  assert.equal(guidance.missingRowsUnseen,true);
  assert.equal(guidance.pieces,2);
  assert.deepEqual(guidance.cells,[]);
  assert.deepEqual(describeListGuidance(guidance,{totalRows:12}),{asks:['아직 보지 못한 줄: 5~6번째 줄, 11~12번째 줄'],
    notes:['목록이 2조각으로 읽혔습니다. 조각 사이에 보지 못한 줄이 있는지는 알 수 없습니다']});
});

test('rows seen while the thumb was moving are counted, not numbered, and missing rows are not called unseen', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:400}));
  // Rows 6..9 pass by without the thumb resting: seen, but where in the list is not known.
  table.observe(frame(1,6,{row:7,settledMs:0}));
  const guidance=listGuidance(table.snapshot(),{totalRows:10,unconfirmed:none});
  assert.deepEqual(guidance.unplaced,{islands:1,rows:4,cards:40,unidentified:0,unread:0});
  assert.deepEqual(guidance.missingRows,[{from:4,to:9}]);
  assert.equal(guidance.missingRowsUnseen,false);
  // Nothing in those rows is unread or unconfirmed: there is nothing to ask for, only to note.
  const {asks,notes}=describeListGuidance(guidance,{totalRows:10});
  assert.deepEqual(asks,[]);
  assert.equal(notes.length,3);
  assert.ok(notes[0].startsWith('위치가 확인된 줄에 없는 줄: 5~10번째 줄'));
  assert.ok(notes[1].startsWith('위치를 모르는 줄이 1조각(카드 40장'));
  assert.ok(notes[2].startsWith('목록이 2조각으로 읽혔습니다'));
});

test('a covered cell and a cell that could not be named are asked for by row and column; empty slots are not', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:400},slots=>{slots[3]=SLOT_UNUSABLE;slots[14]=SLOT_UNIDENTIFIED;slots[39]=SLOT_EMPTY;}));
  const guidance=listGuidance(table.snapshot(),{totalRows:4,unconfirmed:none});
  assert.deepEqual(guidance.cells,[{row:0,column:3,kind:'unread'},{row:1,column:4,kind:'unidentified'}]);
  assert.deepEqual(guidance.missingRows,[]);
  assert.equal(guidance.emptyFromRow,3);
  assert.deepEqual(describeListGuidance(guidance,{totalRows:4}),{asks:[
    '1번째 줄(목록의 약 0% 지점): 4번째 칸은 가려졌거나 온전히 보이지 않음',
    '2번째 줄(목록의 약 33% 지점): 5번째 칸은 이름을 읽지 못함'],notes:[]});
});

test('an unconfirmed card is listed with its place only when its row is anchored', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:400}));
  table.observe(frame(1,8,{row:9,settledMs:0}));
  const unconfirmed=new Map([[12,{name:'가',reasons:['장수 확인']}],[95,{name:'나',reasons:['최신 각성·장수 확인']}],[777,{name:'다',reasons:[]}]]);
  const guidance=listGuidance(table.snapshot(),{totalRows:12,unconfirmed});
  assert.deepEqual(guidance.cards,[
    {code:12,name:'가',reasons:['장수 확인'],row:1,column:2},
    {code:95,name:'나',reasons:['최신 각성·장수 확인'],row:null,column:null},
    {code:777,name:'다',reasons:[],row:null,column:null}]);
  const {asks}=describeListGuidance(guidance,{totalRows:12});
  assert.equal(asks[0],'가: 다시 보여 주세요 (2번째 줄 3번째 칸, 목록의 약 9% 지점) · 장수 확인');
  assert.equal(asks[1],'나: 다시 보여 주세요 (위치 미확인, 그 카드에서 스크롤을 잠깐 멈추면 위치를 알 수 있음) · 최신 각성·장수 확인');
  assert.equal(asks[2],'다: 다시 보여 주세요 (위치 미확인, 그 카드에서 스크롤을 잠깐 멈추면 위치를 알 수 있음)');
});

test('a table with nothing to ask for gives no lines', () => {
  const table=createListTable();
  table.observe(frame(0,0,{row:0,settledMs:400}));
  const guidance=listGuidance(table.snapshot(),{totalRows:4,unconfirmed:none});
  assert.deepEqual(describeListGuidance(guidance,{totalRows:4}),{asks:[],notes:[]});
});

test('rows after the first empty slot are noted, not asked for', () => {
  const table=createListTable();
  // The owned cards end in list row 3; the list has 8 rows.
  table.observe(frame(0,0,{row:0,settledMs:400},slots=>{for(let slot=35;slot<40;slot++)slots[slot]=SLOT_EMPTY;}));
  const guidance=listGuidance(table.snapshot(),{totalRows:8,unconfirmed:none});
  assert.equal(guidance.emptyFromRow,3);
  assert.deepEqual(guidance.missingRows,[{from:4,to:7}]);
  assert.deepEqual(describeListGuidance(guidance,{totalRows:8}),{asks:[],
    notes:['4번째 줄에서 빈 칸이 보였습니다. 그 뒤 5~8번째 줄은 보지 않았습니다(카드가 더 있는지는 알 수 없음)']});
});

test('a cell that could not be named in rows without a place is still asked for', () => {
  const table=createListTable();
  table.observe(frame(0,6,{row:7,settledMs:0},slots=>{slots[12]=SLOT_UNIDENTIFIED;}));
  const guidance=listGuidance(table.snapshot(),{totalRows:10,unconfirmed:none});
  assert.equal(guidance.unplaced.unidentified,1);
  assert.ok(describeListGuidance(guidance,{totalRows:10}).asks[0].includes('이름을 읽지 못한 칸 1개'));
});
