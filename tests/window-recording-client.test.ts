import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExactRecording} from '../src/features/card-scanner/exact-recording';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';

async function client(run:(workers:any[])=>Promise<void>,ready:any,stats:any){
  const old=Object.getOwnPropertyDescriptor(globalThis,'Worker'),workers:any[]=[];
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
    onmessage:any;onerror:any;messages:any[]=[];terminated=false;
    constructor(){workers.push(this);}
    postMessage(message:any){
      this.messages.push(message);
      if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready',supportsSourceReads:true,...ready}}));
      if(message.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:1,events:0,dropped:0,bytes:0,
        peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:'',...stats}}}));
      if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
    }
    terminate(){this.terminated=true;for(const message of this.messages)if(message.kind==='init')message.port.close();}
  }});
  try{await run(workers);}finally{for(const worker of workers)worker.terminate();if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
}
const ready={codecPolicy:RGBA_WINDOW_POLICY,codec:RGBA_WINDOW_CODEC};
const stats={canonical:true,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};

test('RGBA window is explicit, reaches init, and preserves verified finish tags',async()=>{
  await client(async workers=>{
    const recorder=await createExactRecording({codecPolicy:RGBA_WINDOW_POLICY});
    assert.equal(workers[0].messages[0].codecPolicy,RGBA_WINDOW_POLICY);
    assert.equal(workers[0].messages[0].storageVersion,undefined);
    const done=await recorder.finish();assert.equal(done.stats.complete,true);
    assert.equal(done.stats.codec,RGBA_WINDOW_CODEC);assert.equal(done.stats.policy,RGBA_WINDOW_POLICY);
    assert.equal(done.stats.storageVersion,undefined);await done.dispose();assert.equal(workers[0].terminated,true);
  },ready,stats);
});

test('unknown, native, and compact window option combinations fail before creating a Worker',async()=>{
  await client(async workers=>{
    for(const option of [{codecPolicy:'unknown'},{codecPolicy:RGBA_WINDOW_POLICY,storageVersion:1},
      {codecPolicy:RGBA_WINDOW_POLICY,preparedNativeAttestation:true}])
      await assert.rejects(createExactRecording(option as never),/형식/);
    assert.equal(workers.length,0);
  },ready,stats);
});

test('missing or mismatching window preparation ACK terminates the requested Worker',async()=>{
  for(const response of [{},{codecPolicy:RGBA_WINDOW_POLICY},{codec:RGBA_WINDOW_CODEC},
    {...ready,codec:'lz4'},{...ready,codecPolicy:'other'}]){
    await client(async workers=>{
      await assert.rejects(createExactRecording({codecPolicy:RGBA_WINDOW_POLICY}),/정책.*불일치/);
      assert.equal(workers[0].terminated,true);
    },response,stats);
  }
});

test('legacy client rejects an unsolicited window ACK instead of silently opting in',async()=>{
  await client(async workers=>{
    await assert.rejects(createExactRecording(),/정책.*불일치/);assert.equal(workers[0].terminated,true);
  },ready,stats);
});

test('window result policy mismatch preserves producer bytes as incomplete',async()=>{
  for(const response of [{canonical:true},{...stats,codec:'lz4'},{...stats,policy:'other'},
    {...stats,canonical:undefined},{...stats,storageVersion:1,nativeFrames:0,rgbaFrames:1}]){
    await client(async()=>{
      const recorder=await createExactRecording({codecPolicy:RGBA_WINDOW_POLICY}),done=await recorder.finish();
      assert.equal(done.stats.complete,false);assert.match(done.stats.error,/형식.*불일치|정책.*불일치/);await done.dispose();
    },ready,response);
  }
});

test('default recorder init and final stats remain legacy without window tags',async()=>{
  await client(async workers=>{
    const recorder=await createExactRecording(),done=await recorder.finish();
    assert.equal(Object.hasOwn(workers[0].messages[0],'codecPolicy'),false);
    assert.equal(done.stats.codec,undefined);assert.equal(done.stats.policy,undefined);assert.equal(done.stats.complete,true);await done.dispose();
  },{},{});
});
