import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listGuidanceMap} from '../src/features/card-scanner/session/list-guidance';
import type {ListGuidance} from '../src/features/card-scanner/session/list-guidance';

const base:ListGuidance={missingRows:[],missingRowsUnseen:true,emptyFromRow:null,conflicts:0,pieces:1,
  unplaced:{islands:0,rows:0,cards:0,unidentified:0,unread:0},cells:[],cards:[]};
const card=(row:number|null,name='카드')=>({code:row??-1,name,reasons:['장수 확인'],row,column:row===null?null:0});

test('the map lists each row to show again once, a card before a cell before an unseen row', () => {
  const map=listGuidanceMap({...base,cards:[card(5),card(null)],cells:[{row:5,column:2,kind:'unidentified'},{row:9,column:1,kind:'unread'}],
    missingRows:[{from:9,to:11}]},{totalRows:55,visibleRows:4,currentRow:null});
  assert.deepEqual(map.targets,[{row:5,kind:'card'},{row:9,kind:'cell'},{row:10,kind:'unseen'},{row:11,kind:'unseen'}]);
  assert.equal(map.direction,null);   // no screen row known
});

test('the direction points to the nearest row to show again, counted from the screen edge', () => {
  const guidance={...base,cards:[card(3),card(30)]};
  assert.deepEqual(listGuidanceMap(guidance,{totalRows:55,visibleRows:4,currentRow:20}).direction,{kind:'down',rows:7,row:30});
  assert.deepEqual(listGuidanceMap(guidance,{totalRows:55,visibleRows:4,currentRow:8}).direction,{kind:'up',rows:5,row:3});
  assert.deepEqual(listGuidanceMap(guidance,{totalRows:55,visibleRows:4,currentRow:28}).direction,{kind:'here',rows:0,row:30});
});

test('rows the guidance does not ask for are not drawn', () => {
  // Unseen rows while some rows have no place yet, rows after the first empty slot, and unread
  // cells while rows wait for a place are notes, not asks.
  const waiting={...base,missingRowsUnseen:false,missingRows:[{from:40,to:42}],
    unplaced:{islands:1,rows:3,cards:20,unidentified:0,unread:2},cells:[{row:7,column:0,kind:'unread' as const}]};
  assert.deepEqual(listGuidanceMap(waiting,{totalRows:55,visibleRows:4,currentRow:0}).targets,[]);
  const ended={...base,emptyFromRow:39,missingRows:[{from:38,to:54}]};
  assert.deepEqual(listGuidanceMap(ended,{totalRows:55,visibleRows:4,currentRow:0}).targets.map(t=>t.row),[38,39]);
});

test('the screen row is kept inside the list', () => {
  const map=listGuidanceMap({...base,cards:[card(0)]},{totalRows:55,visibleRows:4,currentRow:70});
  assert.equal(map.currentRow,51);
  assert.deepEqual(map.direction,{kind:'up',rows:51,row:0});
});
