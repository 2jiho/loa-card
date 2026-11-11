import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CandidateQueue} from '../src/features/card-scanner/acquisition/candidate-queue';
import {RetainedRasterBudget,retainSupersededCandidate} from '../dev/retained-candidate-experiment';

function make(n:number){
 const source={sessionId:'synthetic',frameId:n,observationId:`observation-${n}`,captureOrder:n*100,
  captureTime:n,phase:'input' as const,slot:0,frame:`frame-${n}`};
 return {group:1,source,order:source.captureOrder,stable:true,borderAlignment:1,
  image:{width:140,height:210},previewCanvas:{width:142,height:214} as HTMLCanvasElement,
  savedObservation:{id:n},knownIdentity:{id:'must-not-transfer'},verifiedVisual:{old:true},
  fieldTarget:{id:'must-not-transfer',order:source.captureOrder},needsIdentity:false};
}

test('retained canvas credit bounds both estimated rasters and is released once',()=>{
 const budget=new RetainedRasterBudget(300_000),a=make(1),b=make(2);
 assert.equal(budget.reserve(a.image,a.previewCanvas),'reserved');
 assert.equal(budget.snapshot().estimatedBytes,140*210*4+142*214*4);
 assert.equal(budget.reserve(a.image,a.previewCanvas),'ownership-conflict');
 assert.equal(budget.reserve(b.image,b.previewCanvas),'full');
 assert.equal(budget.release(a.image),true);assert.equal(budget.release(a.image),false);
 assert.equal(budget.snapshot().estimatedBytes,0);assert.equal(budget.snapshot().peakEstimatedBytes,239152);
 assert.equal(budget.reserve({width:0,height:210}),'invalid');
 assert.throws(()=>new RetainedRasterBudget(8*1024*1024+1),/limit/);
});

test('retained raster reservations reject shared previews and cross-role canvas aliases',()=>{
 const budget=new RetainedRasterBudget(),a=make(1),b=make(2);
 assert.equal(budget.reserve(a.image,a.previewCanvas),'reserved');
 const allocated=budget.snapshot().estimatedBytes;
 assert.equal(budget.reserve(b.image,a.previewCanvas),'ownership-conflict','same preview');
 assert.equal(budget.reserve(a.previewCanvas,b.previewCanvas),'ownership-conflict','preview reused as image');
 assert.equal(budget.reserve(b.image,a.image),'ownership-conflict','image reused as preview');
 assert.equal(budget.snapshot().estimatedBytes,allocated);
 assert.equal(budget.release(a.image),true);
 assert.equal(budget.reserve(b.image,a.previewCanvas),'reserved','both ownership guards release with the reservation');
 assert.equal(budget.release(b.image),true);
 assert.equal(budget.snapshot().estimatedBytes,0);
});

test('prototype retains original source and requires a new identity read',()=>{
 const a=make(1),b=make(2),budget=new RetainedRasterBudget(),deferred:ReturnType<typeof make>[]=[],other:ReturnType<typeof make>[]=[];
 assert.equal(retainSupersededCandidate(a,b,deferred,other,2,budget),'queued');
 assert.equal(deferred.length,1);assert.equal(deferred[0].image,a.image);assert.equal(deferred[0].source,a.source);
 assert.equal(deferred[0].order,100);assert.equal(deferred[0].needsIdentity,true);
 assert.equal(deferred[0].fieldTarget,undefined);assert.equal(deferred[0].knownIdentity,undefined);
 assert.equal(deferred[0].verifiedVisual,undefined);assert.equal(a.image.width,140);
 assert.equal(budget.release(deferred[0].image),true);assert.equal(budget.snapshot().active,0);
});

test('full target or byte budget rejects retention without changing target ownership',()=>{
 const a=make(1),b=make(2),occupant=make(3),target=[occupant],budget=new RetainedRasterBudget();
 assert.equal(retainSupersededCandidate(a,b,target,[],1,budget),'full');
 assert.deepEqual(target,[occupant]);assert.equal(budget.snapshot().active,0);assert.equal(a.image.width,140);
 const narrow=new RetainedRasterBudget(100);
 assert.equal(retainSupersededCandidate(a,b,[],[],5,narrow),'full');assert.equal(narrow.snapshot().active,0);
});

test('shared image, preview, observation, or active preview cannot be handed off',()=>{
 for(const alias of ['image','previewCanvas','savedObservation'] as const){
  const a=make(1),b=make(2),budget=new RetainedRasterBudget();
  (b as any)[alias]=a[alias];
  assert.equal(retainSupersededCandidate(a,b,[],[],5,budget),'ownership-conflict',alias);
  assert.equal(budget.snapshot().active,0);assert.equal(a.image.width,140);
 }
 const a={...make(1),previewTask:Promise.resolve('')},b=make(2),budget=new RetainedRasterBudget();
 assert.equal(retainSupersededCandidate(a,b,[],[],5,budget),'ownership-conflict');
});

test('handoff rejects cross-role raster aliases in both pending retry lanes',()=>{
 for(const lane of ['target','other'] as const)for(const direction of ['image-to-preview','preview-to-image'] as const){
  const a=make(1),replacement=make(2),pending=make(3),budget=new RetainedRasterBudget();
  if(direction==='image-to-preview')pending.previewCanvas=a.image as unknown as HTMLCanvasElement;
  else pending.image=a.previewCanvas;
  const target=lane==='target'?[pending]:[],other=lane==='other'?[pending]:[];
  assert.equal(retainSupersededCandidate(a,replacement,target,other,5,budget),'ownership-conflict',`${lane} ${direction}`);
  assert.equal(target.length,lane==='target'?1:0);assert.equal(other.length,lane==='other'?1:0);
  assert.equal(a.image.width,140);assert.equal(budget.snapshot().active,0);
 }
});

test('a throwing replacement release leaves the original candidate in its original queue',()=>{
 const a=make(1),b=make(2),queue=new CandidateQueue(1,()=>{throw Error('cannot transfer');});
 assert.equal(queue.pushDetailed(a),'queued');assert.throws(()=>queue.pushDetailed(b),/cannot transfer/);
 assert.equal(queue.shift(),a);assert.equal(a.image.width,140);
});
