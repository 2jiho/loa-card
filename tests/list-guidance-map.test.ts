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

test('rows no frame showed are drawn to look at, also while pieces wait; not after the first empty slot', () => {
  // Unread cells are drawn too: the piece may hold them, and showing the row again places it.
  const waiting={...base,missingRowsUnseen:false,missingRows:[{from:40,to:42}],
    unplaced:{islands:1,rows:3,cards:20,unidentified:0,unread:2},cells:[{row:7,column:0,kind:'unread' as const}]};
  assert.deepEqual(listGuidanceMap(waiting,{totalRows:55,visibleRows:4,currentRow:0}).targets,[{row:7,kind:'cell'},...[40,41,42].map(row=>({row,kind:'unseen'}))]);
  const ended={...base,emptyFromRow:39,missingRows:[{from:38,to:54}]};
  assert.deepEqual(listGuidanceMap(ended,{totalRows:55,visibleRows:4,currentRow:0}).targets.map(t=>t.row),[38,39]);
});

test('the screen row is kept inside the list', () => {
  const map=listGuidanceMap({...base,cards:[card(0)]},{totalRows:55,visibleRows:4,currentRow:70});
  assert.equal(map.currentRow,51);
  assert.deepEqual(map.direction,{kind:'up',rows:51,row:0});
});

test('a share smaller than 1920x1080 at the interface scale gets the small-screen notice', async () => {
  const {smallScreenNotice}=await import('../src/features/card-scanner/orchestration/row-scanner-state');
  assert.equal(smallScreenNotice(1920,1080,.75),null);
  assert.equal(smallScreenNotice(1922,1106,.75),null);
  assert.equal(smallScreenNotice(2560,1440,1),null);
  assert.equal(smallScreenNotice(1600,900,null),null);
  assert.match(smallScreenNotice(1602,926,.63)!,/1602×926.*1920×1080/);
});

test('the progress window redraws when only the list map or the window changes', async () => {
  const {createScanMonitorStore}=await import('../src/features/card-scanner/ui/scan-monitor-store');
  const store=createScanMonitorStore();let notified=0;store.subscribe(()=>notified++);
  const map=(currentRow:number|null,rows:number[])=>({totalRows:55,visibleRows:4,currentRow,targets:rows.map(row=>({row,kind:'card' as const})),direction:null});
  const base={currentRunRead:10,expected:398,capacity:450,queued:0,activeReadings:0,cards:[]};
  store.publish({...base,located:true,listGuidance:{map:map(0,[5])}});
  const first=notified;
  store.publish({...base,located:true,listGuidance:{map:map(0,[5])}});
  assert.equal(notified,first,'an equal map is not a change');
  store.publish({...base,located:true,listGuidance:{map:map(12,[5])}});
  assert.equal(store.getSnapshot()?.map?.currentRow,12);
  store.publish({...base,located:true,listGuidance:{map:map(12,[5,30])}});
  assert.equal(store.getSnapshot()?.map?.targets.length,2);
  store.publish({...base,located:false,listGuidance:{map:map(12,[5,30])}});
  assert.equal(store.getSnapshot()?.located,false);
});

test('rows past the storage capacity are the locked bar: never missing, never asked for', async () => {
  const {listGuidance,describeListGuidance}=await import('../src/features/card-scanner/session/list-guidance');
  const snapshot={rows:new Map([[0,Array.from({length:10},()=>({state:'card' as const,card:1,looks:1,firstTime:0,lastTime:0}))]]),floating:[],
    counts:{frames:1,placedByThumb:1,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0}};
  const without=listGuidance(snapshot,{totalRows:55,unconfirmed:new Map()});
  assert.deepEqual(without.missingRows,[{from:1,to:54}]);
  const capped=listGuidance(snapshot,{totalRows:55,unconfirmed:new Map(),slotRows:45});
  assert.deepEqual(capped.missingRows,[{from:1,to:44}]);
  assert.match(describeListGuidance(capped,{totalRows:55}).asks.join(' '),/2~45번째 줄/);
});

test('rows after the displayed owned total hold empty slots: not asked for, drawn as bands on the map', async () => {
  const {listGuidance,listGuidanceMap}=await import('../src/features/card-scanner/session/list-guidance');
  const snapshot={rows:new Map([[0,Array.from({length:10},()=>({state:'card' as const,card:1,looks:1,firstTime:0,lastTime:0}))]]),floating:[],
    counts:{frames:1,placedByThumb:1,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0}};
  const guidance=listGuidance(snapshot,{totalRows:55,unconfirmed:new Map(),slotRows:45,cardRows:40});
  assert.deepEqual(guidance.missingRows,[{from:1,to:39}]);
  const map=listGuidanceMap(guidance,{totalRows:55,visibleRows:4,currentRow:null});
  assert.equal(map.emptyFrom,40);
  assert.equal(map.lockedFrom,45);
  const unknown=listGuidanceMap(listGuidance(snapshot,{totalRows:55,unconfirmed:new Map()}),{totalRows:55,visibleRows:4,currentRow:null});
  assert.equal(unknown.emptyFrom,undefined);
  assert.equal(unknown.lockedFrom,undefined);
});

test('seen rows with nothing left to show again are drawn as done; target and empty rows are not', async () => {
  const {listGuidance,listGuidanceMap}=await import('../src/features/card-scanner/session/list-guidance');
  const full=()=>Array.from({length:10},()=>({state:'card' as const,card:1,looks:1,firstTime:0,lastTime:0}));
  const snapshot={rows:new Map([[0,full()],[1,full()],[2,[...full().slice(0,9),null]],[3,full()],[41,full()]]),floating:[],
    counts:{frames:1,placedByThumb:1,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0}};
  const map=listGuidanceMap(listGuidance(snapshot,{totalRows:55,unconfirmed:new Map(),slotRows:45,cardRows:40}),{totalRows:55,visibleRows:4,currentRow:null});
  assert.deepEqual(map.done,[{from:0,to:1},{from:3,to:3}]);
});

test('pieces whose place is only likely are drawn as read; pieces with no likely place are not', async () => {
  const {listGuidance,listGuidanceMap}=await import('../src/features/card-scanner/session/list-guidance');
  const full=()=>Array.from({length:10},()=>({state:'card' as const,card:1,looks:1,firstTime:0,lastTime:0}));
  const piece=(likelyTop:number|null)=>({rows:2,cards:20,frames:4,likelyTop,hintFrames:3,hintTotal:4,cells:[full(),full()]});
  const snapshot={rows:new Map([[0,full()]]),floating:[piece(20),piece(null)],
    counts:{frames:1,placedByThumb:1,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0}};
  const map=listGuidanceMap(listGuidance(snapshot,{totalRows:55,unconfirmed:new Map(),slotRows:45,cardRows:40}),{totalRows:55,visibleRows:4,currentRow:null});
  assert.deepEqual(map.done,[{from:0,to:0},{from:20,to:21}]);
});

test('rows shown in frames read while scrolling are drawn as read, without any anchored row', async () => {
  const {listGuidance,listGuidanceMap}=await import('../src/features/card-scanner/session/list-guidance');
  const snapshot={rows:new Map(),floating:[],
    counts:{frames:1,placedByThumb:0,placedByOverlap:0,started:0,unplaced:0,merges:0,overlapConflicts:0,anchorConflicts:0,cellConflicts:0,leadViolations:0}};
  const map=listGuidanceMap(listGuidance(snapshot,{totalRows:55,unconfirmed:new Map(),slotRows:45,cardRows:40,viewedRows:new Set([30,31,32,33,38,39,40,50])}),{totalRows:55,visibleRows:4,currentRow:null});
  assert.deepEqual(map.done,[{from:30,to:33},{from:38,to:39}]);
});

test('a card highlight is drawn once it has lasted the hold; a moment of it is not', async () => {
  const {holdNewCardTargets}=await import('../src/features/card-scanner/session/list-guidance');
  const map=(rows:number[])=>({totalRows:55,visibleRows:4,currentRow:0,direction:null,targets:rows.map(row=>({row,kind:'card' as const}))});
  const since=new Map<number,number>();
  assert.deepEqual(holdNewCardTargets(map([11]),since,0,800).targets,[]);
  assert.deepEqual(holdNewCardTargets(map([]),since,300,800).targets,[]);
  assert.deepEqual(holdNewCardTargets(map([11]),since,400,800).targets,[]);
  assert.deepEqual(holdNewCardTargets(map([11]),since,1200,800).targets,[{row:11,kind:'card'}]);
});

test('a cell highlight is held like a card highlight', async () => {
  const {holdNewCardTargets}=await import('../src/features/card-scanner/session/list-guidance');
  const map=(rows:number[])=>({totalRows:55,visibleRows:4,currentRow:0,direction:null,targets:rows.map(row=>({row,kind:'cell' as const})),done:[]});
  const since=new Map<number,number>();
  const first=holdNewCardTargets(map([7]),since,0,800);
  assert.deepEqual(first.targets,[]);
  assert.deepEqual(first.done,[{from:7,to:7}]);
  assert.deepEqual(holdNewCardTargets(map([7]),since,900,800).targets,[{row:7,kind:'cell'}]);
});
