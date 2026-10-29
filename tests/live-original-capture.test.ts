import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveOriginalCapture} from '../src/features/card-scanner/live-original-capture';
import {createLiveCapturePipeline} from '../src/features/card-scanner/live-capture-pipeline';

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(yes=>{resolve=yes;});
  return {promise,resolve};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('original capture accepts the first input and shares one exact interval across sources',()=>{
  const calls:{source:string;time:number;elapsed:number}[]=[];
  const originals=createLiveOriginalCapture<string>((source,time,elapsed)=>{calls.push({source,time,elapsed});return calls.length;});
  assert.equal(originals.capture('first frozen',0),1);
  assert.equal(originals.capture('background',0),undefined);
  assert.equal(originals.capture('too early',249.999),undefined);
  assert.equal(originals.capture('background',250),2);
  assert.equal(originals.capture('next frozen',499.999),undefined);
  assert.equal(originals.capture('next frozen',500),3);
  assert.deepEqual(calls,[{source:'first frozen',time:0,elapsed:0},{source:'background',time:.25,elapsed:250},{source:'next frozen',time:.5,elapsed:500}]);
});

test('invalid and backdated timestamps never reach the encoder or change its submission clock',()=>{
  const times:number[]=[];
  const originals=createLiveOriginalCapture<string>((_,time)=>{times.push(time);return times.length;},0);
  for(const invalid of [NaN,Infinity,-Infinity,-1])assert.equal(originals.capture('invalid',invalid),undefined);
  assert.equal(originals.capture('first',1000),1);
  assert.equal(originals.capture('older',999),undefined);
  assert.equal(originals.capture('next',1001),2);
  assert.deepEqual(times,[1,1.001]);
  assert.throws(()=>createLiveOriginalCapture(()=>1,-1),RangeError);
  assert.throws(()=>createLiveOriginalCapture(()=>1,NaN),RangeError);
});

test('selected inputs cover the same backup interval, while delayed old inputs cannot rewind it',()=>{
  const sources:string[]=[];
  const originals=createLiveOriginalCapture<string>(source=>{sources.push(source);return sources.length;});
  assert.equal(originals.capture('initial',0),1);originals.remember(200);
  assert.equal(originals.capture('redundant backup',250),undefined);
  assert.equal(originals.capture('unseen interval',450),2);
  originals.remember(300);assert.equal(originals.capture('still covered',600),undefined);
  assert.equal(originals.capture('next unseen',700),3);
  assert.deepEqual(sources,['initial','unseen interval','next unseen']);
  for(const invalid of [NaN,Infinity,-1])assert.throws(()=>originals.remember(invalid),RangeError);
  assert.equal(originals.capture('invalid times did not change it',950),4);
});

test('a rejected or thrown submission can retry without consuming the interval',()=>{
  const calls:number[]=[];let reject=true,throwNext=false;
  const originals=createLiveOriginalCapture<null>((_,__,elapsed)=>{
    calls.push(elapsed);if(throwNext){throwNext=false;throw new Error('temporary failure');}
    return reject?undefined:calls.length;
  });
  assert.equal(originals.capture(null,0),undefined);reject=false;
  assert.equal(originals.capture(null,0),2);
  reject=true;assert.equal(originals.capture(null,250),undefined);reject=false;
  assert.equal(originals.capture(null,251),4);
  throwNext=true;assert.throws(()=>originals.capture(null,501),/temporary failure/);
  assert.equal(originals.capture(null,501),6);
  assert.deepEqual(calls,[0,0,250,251,501,501]);
});

test('a per-capture submit override runs only when due and shares the existing successful backup clock',()=>{
  const ordinary:{source:string;time:number;elapsed:number}[]=[],overrides:typeof ordinary=[];
  const originals=createLiveOriginalCapture<string>((source,time,elapsed)=>{ordinary.push({source,time,elapsed});return ordinary.length;});
  const override=(source:string,time:number,elapsed:number)=>{overrides.push({source,time,elapsed});return 40+overrides.length;};
  assert.equal(originals.capture('initial',0),1);
  for(const elapsed of [-1,NaN,Infinity,0,249.999])assert.equal(originals.capture('not due',elapsed,override),undefined);
  assert.deepEqual(overrides,[]);
  assert.equal(originals.capture('leased backup',250,override),41);
  assert.equal(originals.capture('same interval',250),undefined);assert.equal(originals.capture('early override',499.999,override),undefined);
  assert.equal(originals.capture('ordinary next',500),2);
  originals.remember(700);assert.equal(originals.capture('backdated override',600,override),undefined);
  assert.equal(originals.capture('after remembered input',950,override),42);
  assert.deepEqual(ordinary,[{source:'initial',time:0,elapsed:0},{source:'ordinary next',time:.5,elapsed:500}]);
  assert.deepEqual(overrides,[{source:'leased backup',time:.25,elapsed:250},{source:'after remembered input',time:.95,elapsed:950}]);
});

test('failed overrides neither consume the interval nor fall back to an unrelated submission',()=>{
  let ordinary=0,rejected=0,thrown=0;
  const originals=createLiveOriginalCapture<null>(()=>++ordinary);
  assert.equal(originals.capture(null,0,()=>{rejected++;return undefined;}),undefined);
  assert.equal(ordinary,0);assert.equal(rejected,1);
  assert.throws(()=>originals.capture(null,0,()=>{thrown++;throw Error('lease commit failed');}),/lease commit failed/);
  assert.equal(ordinary,0);assert.equal(thrown,1);
  assert.equal(originals.capture(null,0),1);
  assert.equal(originals.capture(null,250,()=>undefined),undefined);
  assert.equal(originals.capture(null,250),2);
});

test('a delayed acquisition retains its own saved ID after a newer background snapshot',async()=>{
  const held=deferred(),saved:{id:number;source:string;time:number}[]=[],attached:{source:string;id:number|undefined}[]=[],errors:unknown[]=[];
  const originals=createLiveOriginalCapture<string>((source,time)=>{const id=saved.length+1;saved.push({id,source,time});return id;});
  const pipeline=createLiveCapturePipeline<{source:string;savedId:number|undefined}>({
    yieldTask:()=>held.promise,
    consume:input=>{attached.push({source:input.source,id:input.savedId});},release:()=>{},onError:error=>{errors.push(error);},
  });
  const source='frozen A',savedId=originals.capture(source,0);
  pipeline.offer({source,savedId},0);
  assert.equal(savedId,1);assert.equal(originals.capture('background at A',0),undefined);
  await turn();assert.equal(originals.capture('background later',250),2);
  held.resolve();await pipeline.flush();
  assert.deepEqual(saved,[{id:1,source:'frozen A',time:0},{id:2,source:'background later',time:.25}]);
  assert.deepEqual(attached,[{source:'frozen A',id:1}]);assert.deepEqual(errors,[]);
});

test('replacing pending frames never attaches a newer saved ID to active or discarded pixels',async()=>{
  const active=deferred(),saved:{id:number;source:string}[]=[],attached:{source:string;id:number|undefined}[]=[],released:string[]=[],errors:unknown[]=[];
  const originals=createLiveOriginalCapture<string>(source=>{const id=saved.length+1;saved.push({id,source});return id;});
  const pipeline=createLiveCapturePipeline<{source:string;savedId:number|undefined}>({
    maxPendingFrames:1,
    yieldTask:()=>Promise.resolve(),consume:async input=>{if(input.source==='A')await active.promise;attached.push({source:input.source,id:input.savedId});},
    release:input=>{released.push(input.source);},onError:error=>{errors.push(error);},
  });
  const offer=(source:string,elapsed:number)=>pipeline.offer({source,savedId:originals.capture(source,elapsed)},elapsed/1000);
  offer('A',0);await turn();offer('B',250);offer('C',500);
  assert.deepEqual(released,['B']);assert.deepEqual(attached,[]);
  active.resolve();await pipeline.flush();
  assert.deepEqual(saved,[{id:1,source:'A'},{id:2,source:'B'},{id:3,source:'C'}]);
  assert.deepEqual(attached,[{source:'A',id:1},{source:'C',id:3}]);
  assert.deepEqual(released,['B','A','C']);assert.deepEqual(errors,[]);
});

test('an unsaved replacement keeps no receipt instead of borrowing the discarded frame receipt',async()=>{
  const held=deferred(),attached:{source:string;id:number|undefined}[]=[],errors:unknown[]=[];
  const originals=createLiveOriginalCapture<string>(()=>1);
  const pipeline=createLiveCapturePipeline<{source:string;savedId:number|undefined}>({maxPendingFrames:1,yieldTask:()=>held.promise,
    consume:input=>{attached.push({source:input.source,id:input.savedId});},release:()=>{},onError:error=>{errors.push(error);}});
  pipeline.offer({source:'A',savedId:originals.capture('A',0)},0);
  pipeline.offer({source:'B',savedId:originals.capture('B',33)},.033);
  held.resolve();await pipeline.flush();
  assert.deepEqual(attached,[{source:'B',id:undefined}]);assert.deepEqual(errors,[]);
});

test('two pending representatives retain their own original receipts across a middle replacement',async()=>{
  const active=deferred(),saved:string[]=[],attached:{source:string;id:number|undefined}[]=[],released:string[]=[];
  const originals=createLiveOriginalCapture<string>(source=>{saved.push(source);return saved.length;});
  const pipeline=createLiveCapturePipeline<{source:string;savedId:number|undefined}>({
    yieldTask:()=>Promise.resolve(),consume:async input=>{if(input.source==='A')await active.promise;attached.push({source:input.source,id:input.savedId});},
    release:input=>{released.push(input.source);},onError:assert.fail,
  });
  const offer=(source:string,elapsed:number)=>pipeline.offer({source,savedId:originals.capture(source,elapsed)},elapsed/1000);
  offer('A',0);await turn();offer('B',250);offer('C',500);offer('D',750);
  assert.deepEqual(released,['C']);active.resolve();await pipeline.flush();
  assert.deepEqual(attached,[{source:'A',id:1},{source:'B',id:2},{source:'D',id:4}]);
  assert.deepEqual(saved,['A','B','C','D']);assert.equal(new Set(released).size,4);
});
