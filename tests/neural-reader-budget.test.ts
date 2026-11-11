import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNeuralReader} from '../src/features/card-scanner/recognition/neural-reader';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/recognition/card-read-budget';
test('card timeout terminates its Worker; the next crop gets a ready fresh Worker and no late reading',{timeout:1500},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=0;
  let began!:()=>void;const firstRequest=new Promise<void>(resolve=>{began=resolve;});
  const workers:FakeWorker[]=[];const previous=globalThis.Worker;
  class FakeWorker {
    onmessage:((e:{data:unknown})=>void)|null=null;onerror:unknown;terminated=false;
    constructor(){workers.push(this);}
    postMessage(message:{id:number;type:string}){
      if(message.type==='ready'||workers.length>1)queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:{text:'정상',confidence:1}}}));
      else if(message.type==='recognize')began();
    }
    terminate(){this.terminated=true;}
  }
  globalThis.Worker=FakeWorker as unknown as typeof Worker;
  const canvas={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray(4)})})} as unknown as HTMLCanvasElement;
  const reader=createNeuralReader();
  try{
    await reader.ready();
    const budget=new CardReadBudget(20,()=>now,true);
    let timeout:unknown;
    const reading=reader.recognize(canvas,false,undefined,budget),rejected=reading.catch(error=>{timeout=error;});
    // Expire only after the Worker actually owns the read. Wall-clock stalls
    // before admission test a different path and do not require termination.
    await firstRequest;now=20;t.mock.timers.tick(20);await rejected;
    assert.equal(workers[0].terminated,true);
    assert.equal(workers[0].onmessage,null);
    assert.ok(budget.ownsTimeout(timeout));
    assert.equal(await budget.waitForQuiescence(20),true);
    assert.equal((await reader.recognize(canvas,false,undefined,new CardReadBudget(500,()=>now))).text,'정상');
  }finally{reader.dispose();globalThis.Worker=previous;}
});
