import {test} from 'node:test';
import assert from 'node:assert/strict';
import {watchRecordingReadiness} from '../src/features/card-scanner/reproduction/recording-readiness';

function deferred(){let resolve!:()=>void,reject!:(reason:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('journal failure is reported without blocking the active scanner',async()=>{
 const ready=deferred(),events:string[]=[];watchRecordingReadiness(ready.promise,()=>true,()=>events.push('ready'),()=>events.push('failed'));
 events.push('capture');ready.reject(Error('quota'));await turn();assert.deepEqual(events,['capture','failed']);
});
test('late readiness and failure cannot overwrite a newer or stopped scan',async()=>{
 let run=1;const old=deferred(),current=deferred(),events:string[]=[];
 watchRecordingReadiness(old.promise,()=>run===1,()=>events.push('old-ready'),()=>events.push('old-failed'));
 run=2;watchRecordingReadiness(current.promise,()=>run===2,()=>events.push('new-ready'),()=>events.push('new-failed'));
 old.reject(Error('old'));current.resolve();await turn();assert.deepEqual(events,['new-ready']);
 run=3;const stopped=deferred();watchRecordingReadiness(stopped.promise,()=>run===2,()=>events.push('stale'),()=>events.push('stale'));
 stopped.reject(Error('stopped'));await turn();assert.deepEqual(events,['new-ready']);
});
