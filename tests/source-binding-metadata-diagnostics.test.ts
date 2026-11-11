import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceBindingMetadataDiagnostics,exactSourceSavedObservation,saveAcquisition,sourceObservationFrame,
  type SavedAcquisition,type SavedObservation} from '../src/features/card-scanner/acquisition/saved-acquisition';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const physical={sourceFrameId:7,captureTime:1,width:100,height:100,hash:'a'.repeat(64)};
const original:ObservationSource={sessionId:'scan',frameId:17,observationId:'original',captureOrder:137,captureTime:1,phase:'input',slot:0};
const recovery:ObservationSource={...original,frameId:99,observationId:'recovery',phase:'recovery'};

function sample(){
 const nominal={x:10,y:10,width:40,height:60},area={x:0,y:0,width:100,height:100};
 const cell={slot:0,content:{...nominal},preview:{x:8,y:8,width:44,height:64},
  intact:true,complete:true,labelVisible:true,alignment:.95,borderSides:[1,1,1,1],quality:{usable:true,reason:'판독 후보',sharpness:1},
  pixelKey:'untrusted-pixel-key',image:{notCloned(){}}} as unknown as Parameters<typeof saveAcquisition>[3][number];
 const saved=saveAcquisition(100,100,{cells:[nominal],area,scale:1} as SavedAcquisition['layout'],[cell],
  {version:1,kind:'measured',...physical,acquisitionFrameId:17});
 const observation:SavedObservation={order:137,frame:sourceObservationFrame('scan',7,17),stable:true};
 saved.observations[0]=observation;
 return {saved,observation,current:{...saved.cells[0],content:{...cell.content},preview:{...cell.preview},
  quality:{...saved.cells[0].quality},borderSides:[...saved.cells[0].borderSides]}};
}


test('queue admission commits original ownership; recovery reports metadata without authority',()=>{
 const {saved,observation,current}=sample(), diag=new SourceBindingMetadataDiagnostics('scan');
 // A rejected queue candidate must never run the post-enqueue commit hook.
 const commit=(accepted:boolean)=>{if(accepted){saved.observations[0]=observation;diag.input(saved,3,original,false);}};
 commit(false);assert.equal(diag.snapshot().inputAttempts,0);
 commit(true);assert.equal(diag.snapshot().inputBound,1);
 const verified=exactSourceSavedObservation(saved,physical,current);
 assert.equal(verified,observation);
 const result=diag.recovery(verified===observation?saved:undefined,physical,current,recovery,'reacquired',true,false);
 assert.ok(result);assert.equal(result.originalGroup,3);assert.deepEqual(result.originalSource,original);
 assert.deepEqual(result.recoverySource,recovery);assert.equal(result.pixelsAuthenticated,false);
 assert.equal(Object.hasOwn(result,'identity'),false);assert.equal(Object.hasOwn(result,'unknownResolved'),false);
 const stats=diag.snapshot();assert.equal(stats.inputJoinedAtAttempt,0);assert.equal(stats.originalJoinedAtMatch,1);
 assert.equal(stats.recoveryJoinedAtMatch,0);assert.equal(stats.reacquiredMatched,1);assert.equal(stats.capabilities,0);
 diag.close();
});

test('cached and reacquired attempts distinguish missing sources and bound limits',()=>{
 const first=sample(),second=sample(),diag=new SourceBindingMetadataDiagnostics('scan',2);
 diag.input(first.saved,3,original,false);
 // A source missing after eviction remains unavailable, not recreated from equal metadata.
 assert.equal(diag.recovery(undefined,physical,first.current,recovery,'cached',false,false),undefined);
 assert.ok(diag.recovery(first.saved,physical,first.current,recovery,'reacquired',true,true));
 const other={...original,observationId:'other'};
 diag.input(second.saved,3,other,true);
 const stats=diag.snapshot();assert.equal(stats.cachedAttempts,1);assert.equal(stats.reacquiredMatched,1);
 assert.equal(stats.inputUnavailableAtLimit,1);assert.equal(stats.remainingBindings,0);assert.equal(stats.recoveryJoinedAtMatch,1);
 diag.close();
});

test('shared observation or wrong session and wrong slot never acquire authority',()=>{
 const first=sample(),other=sample(),diag=new SourceBindingMetadataDiagnostics('scan');
 diag.input(first.saved,3,original,false);
 other.saved.observations[0]=first.observation;
 diag.input(other.saved,4,{...original,observationId:'other'},false);
 assert.equal(diag.recovery(first.saved,physical,first.current,{...recovery,sessionId:'other'},'cached',false,false),undefined);
 assert.equal(diag.recovery(first.saved,physical,first.current,{...recovery,slot:1},'cached',false,false),undefined);
 const stats=diag.snapshot();assert.equal(stats.inputBound,1);assert.equal(stats.inputUnavailable,1);
 assert.equal(stats.recoveryUnavailable,2);assert.equal(stats.recoveryMatched,0);diag.close();
});
