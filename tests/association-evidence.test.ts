import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAssociation} from '../dev/association-evidence';
import type {RunStateTraceSnapshot} from '../dev/run-state-trace';
import {InventoryEvidence,hashInventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';

const source=(frame:number,slot:number)=>({sessionId:'s',observationId:String(frame*100+slot),frameId:frame,
 captureOrder:frame*100+slot,captureTime:frame,phase:'input' as const,slot});
const receipt=(frame:number,slot:number)=>({version:1,sessionId:'s',observationId:String(frame*100+slot),processingFrame:frame,
 acquisitionFrameId:frame,canonicalSourceFrameId:null,captureTime:frame,phase:'input',slot,pixelKey:`${frame}-${slot}`,
 sourceWidth:1920,sourceHeight:1080,cropWidth:120,cropHeight:180,
 nominalBox:{x:10,y:20,width:120,height:180},contentBox:{x:10,y:20,width:120,height:180},previewBox:{x:10,y:20,width:120,height:180},
 capture:{stable:true,stabilitySource:'settled-fields',complete:true,intact:true,labelVisible:true,borderAlignment:.9,borderSides:[1,1,1,1]},
 quality:{usable:true,reason:'',sharpness:10}});
async function sample(reset=false){
 const events:{seq:number;type:string;value:unknown}[]=[],inventory=new InventoryEvidence([]);
 const add=(type:string,value:unknown)=>events.push({seq:events.length+1,type,value});
 add('inventory-seed',{version:1,cards:[]});
 for(const frame of [1,2]){
  if(frame===2&&reset)add('grid-command',{version:1,method:'resetPositions',args:[]});
  add('grid-command',{version:1,method:'begin',args:[true]});
  for(let slot=0;slot<40;slot++){
   add('acquisition-capture',receipt(frame,slot));
   const group=(frame===1&&slot>=23&&slot<=25)?slot:(frame===2&&slot>=13&&slot<=15)?slot+10:100*frame+slot;
   add('grid-command',{version:1,method:'group',args:[slot,group,frame*100+slot,true,null,source(frame,slot)]});
  }
  add('grid-command',{version:1,method:'record',args:[frame]});
 }
 const confirm=(frame:number,slot:number,id:string)=>{
  const s={...source(frame,slot),frame:`f${frame}`};
  for(const kind of ['identity-accepted','name-confirmed'] as const){const fact={version:1 as const,kind,source:s,id};inventory.apply(fact);add('inventory-event',fact);}
 };
 for(let slot=23;slot<=25;slot++)confirm(1,slot,`w${slot}`);
 for(let slot=13;slot<=15;slot++)confirm(2,slot,`w${slot+10}`);
 confirm(2,12,'target');
 add('inventory-checkpoint',{complete:true,hash:await hashInventoryEvidence(inventory.snapshot())});
 return {version:2,complete:true,dropped:0,events} as unknown as RunStateTraceSnapshot;
}
test('same-column movement and source-bound neighbor facts remain context, never target identity proof',async()=>{
 const result=await analyzeAssociation(await sample(),'122','212');
 assert.equal(result.status,'input-scope-only');if(result.status!=='input-scope-only')return;
 assert.equal(result.targetSlotDelta,-10);assert.equal(result.sameColumn,true);assert.equal(result.chronological,true);
 assert.equal(result.matchingWitnesses.length,3);assert.equal(result.matchingWitnesses.every(w=>w.bothDirect),true);
 assert.equal(result.targets[0].directName,null);assert.equal(result.targets[1].directName?.id,'target');
 assert.equal(result.targets[1].fields,null);assert.equal(result.sortFilterEpoch,'unknown');assert.equal(result.associationProven,false);
});
test('missing recording, reset, and nonexistent target are never promoted to a positive association',async()=>{
 const incomplete=await sample();const partial=await analyzeAssociation({...incomplete,complete:false},'122','212');
 assert.equal(partial.status,'unavailable');assert.equal(partial.associationProven,false);
 const reset=await analyzeAssociation(await sample(true),'122','212');if(reset.status!=='input-scope-only')throw Error('fixture incomplete');
 assert.equal(reset.gridResetCommandsBetweenFrames,1);assert.equal(reset.matchingWitnesses.length,0);assert.equal(reset.associationProven,false);
 await assert.rejects(()=>analyzeAssociation(incomplete,'122','9999'),/not unique or not retained/);
 await assert.rejects(()=>analyzeAssociation(incomplete,'122','122'),/distinct/);
});
