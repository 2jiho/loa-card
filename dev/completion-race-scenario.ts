import {AutoCompletionHold,canStopSharing,currentHeaderAvailable} from '../src/features/card-scanner/session/auto-completion';
import type {CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {CompletionRaceGuard} from '../src/features/card-scanner/session/completion-race-guard';
import {createLiveCapturePipeline} from '../src/features/card-scanner/capture/live-capture-pipeline';
import {headerSnapshotMatches,snapshotHeader,type CompletionHeaderInput} from '../src/features/card-scanner/session/completion-header-snapshot';

/** Synthetic boundary harness. This is not scanner.ts, a real media stream,
 * pixel acquisition, OCR, or a measurement of production timing. */
type View={id:number;pixels:Uint8Array;geometry:string;located:boolean;fieldChanged:boolean;headerPixels?:Uint8ClampedArray};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return {promise,resolve,reject};}
export function createCompletionRaceScenario() {
 let live=true,failed=false,located=true,latest=1,confirmed=1,confirmedName=1,fields=0;
 let headerRead=false,headerTotal:number|null=null;
 const hold=new AutoCompletionHold(),reference=new Uint8Array([1,2,3,4]);
 const guard=new CompletionRaceGuard(1,{geometry:'g',pixels:reference});
 let currentHeader:CompletionHeaderInput={width:1,height:1,pixels:new Uint8ClampedArray([1,2,3,4]),captureTime:1,sourceFrame:1};
 const header=snapshotHeader(currentHeader);
 const jobs=new Map<number,ReturnType<typeof deferred<void>>>(),started:number[]=[],released:number[]=[];
 const pipeline=createLiveCapturePipeline<View>({yieldTask:async()=>{},
  async consume(view){
   started.push(view.id);await jobs.get(view.id)!.promise;
   located=view.located;
   currentHeader={...currentHeader,pixels:view.headerPixels??currentHeader.pixels,captureTime:view.id,sourceFrame:view.id};
   if(view.fieldChanged){latest=view.id;confirmedName=view.id;}
  },release:view=>{released.push(view.id);},onError:()=>{failed=true;live=false;}});
 const input=():CaptureCompletion=>({expected:1,finalExpected:headerTotal??1,unresolved:0,dropped:0,
  cards:[{id:'a',name:'카드',awakening:0,extraCopies:fields,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
  latest:new Map([['a',latest]]),confirmedNames:new Map([['a',confirmedName]]),confirmed:new Map([['a',confirmed]]),
  inputSettled:!pipeline.busy,headerAvailable:currentHeaderAvailable(located,300,40,1),fieldChangesSettled:confirmed>=latest});
 if(hold.observe(input(),0)||!hold.observe(input(),1000))throw Error('Synthetic setup failed');
 return {
  arrive(view:View){
   guard.arrival(view.id);guard.measure(view.id,{geometry:view.geometry,pixels:view.pixels});
   jobs.set(view.id,deferred<void>());pipeline.offer(view,view.id);
  },
  async started(){await Promise.resolve();await Promise.resolve();},
  settle(id:number){const job=jobs.get(id);if(!job)throw Error('No input');job.resolve();},
  fail(id:number){const job=jobs.get(id);if(!job)throw Error('No input');job.reject(Error('synthetic acquisition failure'));},
  async flush(){await pipeline.flush();},
  finishHeader(total:number|null){if(!live)return;headerRead=true;headerTotal=total;guard.finishHeader(total!==null&&total===1);},
  confirmField(id:number,newCount:number){confirmed=id;fields=newCount;},
  stop(){live=false;guard.close();pipeline.dispose();},
  result(){return {eligible:live&&!failed&&headerRead&&guard.canCommit(!pipeline.busy,confirmed>=latest)&&
    headerSnapshotMatches(header,currentHeader)&&canStopSharing({...input(),finalExpected:headerTotal}),live,failed,headerRead,headerTotal,
    inputBusy:pipeline.busy,fieldsSettled:confirmed>=latest,located,started:[...started],released:[...released]};},
 };
}
