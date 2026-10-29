import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeMediaPlayback,parseMediaPlaybackFact} from '../dev/media-playback-observer';
import type {MediaPlaybackEndReason,MediaPlaybackFact} from '../dev/media-playback-observer';

const playbackId='58d0f85a-bf60-40a2-92d7-b44ca9437869';
const base={version:1,playbackId,observedAtMs:0};
const start={...base,type:'start',callbackSupported:true};
const frame={...base,type:'frame',callbackOrdinal:1,mediaTime:0,presentedFrames:0,width:1920,height:1080};
const end={...base,type:'end',reason:'ended',naturalEnd:true,callbacks:0};
const metadata=(mediaTime=0,presentedFrames=0)=>({mediaTime,presentedFrames,width:1920,height:1080}) as VideoFrameCallbackMetadata;

class Callbacks {
  next=0;pending=new Map<number,VideoFrameRequestCallback>();cancelled:number[]=[];
  video={
    requestVideoFrameCallback:(callback:VideoFrameRequestCallback)=>{const id=++this.next;this.pending.set(id,callback);return id;},
    cancelVideoFrameCallback:(id:number)=>{this.cancelled.push(id);this.pending.delete(id);},
  } as HTMLVideoElement;
  fire(value=metadata()) {
    assert.equal(this.pending.size,1);const [id,callback]=this.pending.entries().next().value!;
    this.pending.delete(id);callback(500,value);return callback;
  }
}

test('playback facts copy and freeze strict metadata-only v1 schemas',()=>{
  for(const fact of [start,frame,end]){
    const parsed=parseMediaPlaybackFact(fact);assert.deepEqual(parsed,fact);assert.notEqual(parsed,fact);assert.ok(Object.isFrozen(parsed));
  }
  for(const invalid of [null,[],1,{...start,version:2},{...start,playbackId:'source.mp4'},
    {...start,callbackSupported:1},{...start,observedAtMs:-1},{...start,observedAtMs:Infinity},
    {...frame,callbackOrdinal:0},{...frame,callbackOrdinal:1.5},{...frame,mediaTime:NaN},
    {...frame,presentedFrames:-1},{...frame,presentedFrames:Number.MAX_SAFE_INTEGER+1},
    {...frame,width:0},{...frame,height:Infinity},{...frame,width:1.5},
    {...end,reason:'complete'},{...end,naturalEnd:false},{...end,reason:'stopped'},
    {...end,callbacks:0.1},{...start,src:'/source.mp4'},{...end,complete:true},
    {...frame,decodedFrameOrdinal:1},{...frame,pixels:new Uint8Array(1)},
    {version:1,type:'start',playbackId,observedAtMs:0},Object.assign(new Date(),start)])
    assert.throws(()=>parseMediaPlaybackFact(invalid),TypeError);
  for(const reason of ['stopped','disposed','aborted','error'] as const)
    assert.equal(parseMediaPlaybackFact({...end,reason,naturalEnd:false}).type,'end');
});

test('source callbacks retain duplicate media times and independent local ordinals without claiming browser-counter coverage',t=>{
  let now=200;t.mock.method(performance,'now',()=>now);
  const source=new Callbacks(),facts:MediaPlaybackFact[]=[];
  const observer=observeMediaPlayback(source.video,{onPlayback:fact=>facts.push(fact)});
  assert.equal(source.pending.size,1);now=217;source.fire(metadata(0.04,37));now=230;source.fire(metadata(0.04,39));
  now=240;observer.stop('ended');
  assert.deepEqual(facts.map(fact=>fact.type),['start','frame','frame','end']);
  assert.equal(facts[0].observedAtMs,0);assert.equal(facts[1].observedAtMs,17);
  assert.equal(new Set(facts.map(fact=>fact.playbackId)).size,1);
  assert.deepEqual(facts.filter(fact=>fact.type==='frame').map(fact=>[fact.callbackOrdinal,fact.mediaTime,fact.presentedFrames]),
    [[1,0.04,37],[2,0.04,39]]);
  assert.deepEqual(facts[3],{version:1,type:'end',playbackId:facts[0].playbackId,observedAtMs:40,
    reason:'ended',naturalEnd:true,callbacks:2});
  assert.equal(source.pending.size,0);assert.equal(source.cancelled.length,1);
});

test('every observer owns a distinct playback ID and missing native callbacks produce only lifecycle facts',()=>{
  const first:MediaPlaybackFact[]=[],second:MediaPlaybackFact[]=[];
  const a=observeMediaPlayback({} as HTMLVideoElement,{onPlayback:fact=>first.push(fact)});
  const b=observeMediaPlayback({} as HTMLVideoElement,{onPlayback:fact=>second.push(fact)});
  a.stop('stopped');b.stop('disposed');
  assert.notEqual(first[0].playbackId,second[0].playbackId);
  assert.deepEqual(first.map(fact=>fact.type),['start','end']);
  assert.equal(first[0].type==='start'&&first[0].callbackSupported,false);
  assert.equal(first[1].type==='end'&&first[1].callbacks,0);
});

test('end is terminal, cancels its source callback and ignores a late native callback',()=>{
  for(const reason of ['ended','stopped','disposed','aborted','error'] satisfies MediaPlaybackEndReason[]){
    const source=new Callbacks(),facts:MediaPlaybackFact[]=[];
    const observer=observeMediaPlayback(source.video,{onPlayback:fact=>facts.push(fact)});
    const late=source.pending.values().next().value!;observer.stop(reason);observer.stop('disposed');late(0,metadata(0.1,2));
    assert.deepEqual(facts.map(fact=>fact.type),['start','end']);assert.equal(source.pending.size,0);
    assert.equal(source.cancelled.length,1);
    const ending=facts[1];assert.equal(ending.type,'end');
    if(ending.type==='end'){assert.equal(ending.reason,reason);assert.equal(ending.naturalEnd,reason==='ended');assert.equal(ending.callbacks,0);}
  }
});

test('throwing sinks and malformed native metadata disable only telemetry and notify once',()=>{
  for(const failure of ['start','frame','end','metadata'] as const){
    const source=new Callbacks(),facts:MediaPlaybackFact[]=[],errors:unknown[]=[];
    const observer=observeMediaPlayback(source.video,{onPlayback:fact=>{
      facts.push(fact);if(fact.type===failure)throw Error(`sink ${failure}`);
    },onPlaybackError:error=>{errors.push(error);throw Error('error sink failed');}});
    if(failure!=='start'){
      assert.doesNotThrow(()=>source.fire(failure==='metadata'?metadata(-1,1):metadata(0.1,1)));
      observer.stop('ended');
    }
    observer.stop('disposed');
    assert.equal(errors.length,1);assert.equal(source.pending.size,0);
    assert.deepEqual(facts.map(fact=>fact.type),failure==='start'?['start']:failure==='frame'?['start','frame']:
      failure==='metadata'?['start']:['start','frame','end']);
  }
});

test('native registration, cancellation and metadata access exceptions cannot escape the observer',()=>{
  for(const failure of ['request','cancel','metadata'] as const){
    const source=new Callbacks(),errors:unknown[]=[];
    if(failure==='request')source.video.requestVideoFrameCallback=()=>{throw Error('request failed');};
    if(failure==='cancel')source.video.cancelVideoFrameCallback=()=>{throw Error('cancel failed');};
    const observer=observeMediaPlayback(source.video,{onPlayback:()=>{},onPlaybackError:error=>errors.push(error)});
    if(failure==='metadata'){
      const invalid=metadata();Object.defineProperty(invalid,'mediaTime',{get(){throw Error('metadata read failed');}});
      assert.doesNotThrow(()=>source.fire(invalid));
    }
    assert.doesNotThrow(()=>observer.stop('disposed'));assert.equal(errors.length,1);
    assert.doesNotThrow(()=>observer.stop('aborted'));assert.equal(errors.length,1);
  }
});

test('async sink rejections disable telemetry, cancel pending callbacks and suppress async error-handler rejection',async()=>{
  const unhandled:unknown[]=[];
  const captureUnhandled=(error:unknown)=>{unhandled.push(error);};
  process.on('unhandledRejection',captureUnhandled);
  try{
    for(const stage of ['start','frame','end'] as const){
      const source=new Callbacks(),facts:MediaPlaybackFact[]=[],errors:unknown[]=[];
      const observer=observeMediaPlayback(source.video,{onPlayback:async fact=>{
        facts.push(fact);if(fact.type===stage)throw Error(`async ${stage}`);
      },onPlaybackError:async error=>{errors.push(error);throw Error('async error reporting');}});
      if(stage!=='start')source.fire(metadata(0.1,5));
      const late=source.pending.values().next().value!;
      if(stage==='end')observer.stop('ended');
      // A sink's rejection is observed independently of native playback.
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(errors.length,1);assert.equal(source.pending.size,0);assert.equal(source.cancelled.length,1);
      const retained=facts.length;
      late(500,metadata(0.2,8));observer.stop('disposed');
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(facts.length,retained);assert.equal(errors.length,1);assert.equal(source.pending.size,0);
    }
    assert.deepEqual(unhandled,[]);
  }finally{process.removeListener('unhandledRejection',captureUnhandled);}
});

test('pending async sinks do not stall callback delivery and multiple rejections report only once',async()=>{
  const source=new Callbacks(),facts:MediaPlaybackFact[]=[],errors:unknown[]=[];
  const rejectors:((error:unknown)=>void)[]=[];
  const observer=observeMediaPlayback(source.video,{onPlayback:fact=>{
    facts.push(fact);return new Promise<void>((_resolve,reject)=>{rejectors.push(reject);});
  },onPlaybackError:async error=>{errors.push(error);throw Error('report rejected');}});
  source.fire(metadata(0.1,1));source.fire(metadata(0.2,2));
  assert.deepEqual(facts.map(fact=>fact.type),['start','frame','frame']);assert.equal(source.pending.size,1);
  for(const reject of rejectors)reject(Error('sink rejected'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(errors.length,1);assert.equal(source.pending.size,0);assert.equal(source.cancelled.length,1);
  observer.stop('disposed');assert.equal(facts.length,3);
});
