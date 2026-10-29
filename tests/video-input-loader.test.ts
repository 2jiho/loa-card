import test from 'node:test';
import assert from 'node:assert/strict';
import {loadVideoInput,VIDEO_INPUT_LOAD_TIMEOUT_MS,VideoInputLoadTimeoutError} from '../dev/video-input-loader';

const base='https://example.test/dev/scanner.html';
const source=new URL('../input/video.webm',base).href;
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

class FakeVideo extends EventTarget{
  ownerDocument={baseURI:base};
  srcObject:unknown=null;
  preload='metadata';
  currentSrc='';
  readyState=0;
  error:unknown=null;
  assignments=0;
  loads=0;
  pauses=0;
  removals=0;
  attribute:string|null=null;
  loadAction:(()=>void)|undefined;
  pauseAction:(()=>void)|undefined;
  removeAction:(()=>void)|undefined;
  sourceError:unknown;
  readonly listeners=new Map<string,Set<EventListenerOrEventListenerObject>>();
  readonly history=new Map<string,EventListenerOrEventListenerObject[]>();
  get src(){return this.attribute===null?'':new URL(this.attribute,base).href;}
  set src(value:string){
    if(this.sourceError)throw this.sourceError;
    this.assignments++;this.attribute=value;
  }
  getAttribute(name:string){assert.equal(name,'src');return this.attribute;}
  removeAttribute(name:string){assert.equal(name,'src');this.removals++;this.attribute=null;this.removeAction?.();}
  pause(){this.pauses++;this.pauseAction?.();}
  load(){
    this.loads++;this.readyState=0;this.currentSrc='';this.error=null;
    this.loadAction?.();
  }
  override addEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:AddEventListenerOptions|boolean){
    super.addEventListener(type,callback,options);
    if(callback){
      const active=this.listeners.get(type)??new Set();active.add(callback);this.listeners.set(type,active);
      const old=this.history.get(type)??[];old.push(callback);this.history.set(type,old);
    }
  }
  override removeEventListener(type:string,callback:EventListenerOrEventListenerObject|null,options?:EventListenerOptions|boolean){
    super.removeEventListener(type,callback,options);
    if(callback)this.listeners.get(type)?.delete(callback);
  }
  asElement(){return this as unknown as HTMLVideoElement;}
  emit(type:string){this.dispatchEvent(new Event(type));}
  makeReady(url=this.src){this.currentSrc=url;this.readyState=2;this.emit('loadeddata');}
  listenerCount(){return [...this.listeners.values()].reduce((count,items)=>count+items.size,0);}
}

test('current loaded media resolves, leaving the prepared input intact and listeners removed',async()=>{
  const video=new FakeVideo(),controller=new AbortController();
  const result=loadVideoInput(video.asElement(),'../input/video.webm',controller.signal);
  assert.equal(video.src,source);assert.equal(video.preload,'auto');assert.equal(video.loads,1);
  video.makeReady();await result;
  assert.equal(video.listenerCount(),0);assert.equal(video.removals,0);assert.equal(video.src,source);
  controller.abort();await turn();assert.equal(video.pauses,0);assert.equal(video.loads,1);
});

test('stale events and wrong currentSrc cannot stand in for current request readiness',async()=>{
  const video=new FakeVideo();let settled=false;
  const result=loadVideoInput(video.asElement(),source,new AbortController().signal).then(()=>{settled=true;});
  video.emit('loadeddata');video.emit('canplay');await turn();assert.equal(settled,false);
  video.currentSrc='https://example.test/old.webm';video.readyState=2;
  video.emit('loadeddata');await turn();assert.equal(settled,false);
  video.currentSrc=source;video.readyState=1;video.emit('loadedmetadata');await turn();assert.equal(settled,false);
  video.readyState=2;video.emit('canplay');await result;
  assert.equal(settled,true);assert.equal(video.listenerCount(),0);
});

test('already-ready matching current request is accepted without resetting it',async()=>{
  const video=new FakeVideo();video.attribute='../input/video.webm';video.currentSrc=source;video.readyState=4;
  await loadVideoInput(video.asElement(),source,new AbortController().signal);
  assert.equal(video.assignments,0);assert.equal(video.loads,0);assert.equal(video.preload,'metadata');
  assert.equal(video.listenerCount(),0);
});

test('a current media failure rejects, while bare old error and media-abort events do not',async()=>{
  const video=new FakeVideo();let settled=false;
  const result=loadVideoInput(video.asElement(),source,new AbortController().signal);
  const observed=result.catch(error=>{settled=true;throw error;});
  video.emit('error');video.emit('abort');await turn();assert.equal(settled,false);
  video.error={code:4};video.emit('error');await assert.rejects(observed,/불러오지 못했습니다/);
  assert.equal(video.listenerCount(),0);assert.equal(video.removals,0);
});

test('pre-aborted load never reads or mutates the media element',async()=>{
  const controller=new AbortController(),reason=new Error('pre-aborted');controller.abort(reason);
  const video=new Proxy({}, {get(){assert.fail('pre-abort touched the element');}}) as HTMLVideoElement;
  await assert.rejects(loadVideoInput(video,source,controller.signal),error=>error===reason);
});

test('cancellation resets only the owned request and releases its element',async()=>{
  const video=new FakeVideo(),controller=new AbortController(),reason=new Error('cancel this input');
  const result=loadVideoInput(video.asElement(),source,controller.signal);
  controller.abort(reason);await assert.rejects(result,error=>error===reason);
  assert.equal(video.pauses,1);assert.equal(video.removals,1);assert.equal(video.loads,2);
  assert.equal(video.src,'');assert.equal(video.listenerCount(),0);
  const next=loadVideoInput(video.asElement(),source,new AbortController().signal);
  video.makeReady();await next;
});

test('the load deadline is finite and produces a typed timeout after owned reset',async()=>{
  assert.equal(VIDEO_INPUT_LOAD_TIMEOUT_MS,15_000);
  const video=new FakeVideo();
  await assert.rejects(loadVideoInput(video.asElement(),source,new AbortController().signal,{timeoutMs:5}),error=>{
    assert.ok(error instanceof VideoInputLoadTimeoutError);assert.equal(error.timeoutMs,5);return true;
  });
  assert.equal(video.pauses,1);assert.equal(video.removals,1);assert.equal(video.loads,2);
  assert.equal(video.listenerCount(),0);
});

test('overlapping loads reject without touching or releasing the active owner',async()=>{
  const video=new FakeVideo(),controller=new AbortController();
  const active=loadVideoInput(video.asElement(),source,controller.signal);
  const state=[video.src,video.assignments,video.loads,video.listenerCount()];
  await assert.rejects(loadVideoInput(video.asElement(),'other.webm',new AbortController().signal),/이미 진행 중/);
  assert.deepEqual([video.src,video.assignments,video.loads,video.listenerCount()],state);
  video.makeReady();await active;
});

test('a replacement source is not reset by cancellation, timeout, or replacement events',async()=>{
  for(const ending of ['cancel','timeout','event']){
    const video=new FakeVideo(),controller=new AbortController();
    const result=loadVideoInput(video.asElement(),source,controller.signal,{timeoutMs:10});
    video.src='replacement.webm';const replacement=video.src;
    if(ending==='cancel')controller.abort();
    if(ending==='event')video.emit('loadeddata');
    await assert.rejects(result);
    assert.equal(video.src,replacement);assert.equal(video.pauses,0);assert.equal(video.removals,0);assert.equal(video.loads,1);
  }
});

test('old callbacks and old aborts cannot settle or clear the next same-URL request',async()=>{
  const video=new FakeVideo(),firstController=new AbortController();
  const first=loadVideoInput(video.asElement(),source,firstController.signal,{timeoutMs:10});
  const oldCallback=video.history.get('loadeddata')![0] as EventListener;
  video.makeReady();await first;
  video.readyState=0;let settled=false;
  const second=loadVideoInput(video.asElement(),source,new AbortController().signal,{timeoutMs:100}).then(()=>{settled=true;});
  firstController.abort();oldCallback(new Event('loadeddata'));video.emit('loadeddata');await turn();
  assert.equal(settled,false);assert.equal(video.removals,0);assert.equal(video.src,source);
  // The first deadline was also removed; only the second current state can finish it.
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(settled,false);assert.equal(video.removals,0);
  video.makeReady();await second;
});

test('synchronous preload, source and load failures clean listeners and release ownership',async()=>{
  for(const phase of ['preload','source','load']){
    const video=new FakeVideo(),failure=new Error(`synchronous ${phase}`);
    if(phase==='preload')Object.defineProperty(video,'preload',{configurable:true,set(){throw failure;}});
    else if(phase==='source')video.sourceError=failure;
    else video.loadAction=()=>{throw failure;};
    await assert.rejects(loadVideoInput(video.asElement(),source,new AbortController().signal),error=>error===failure);
    assert.equal(video.listenerCount(),0);
    if(phase==='preload')Object.defineProperty(video,'preload',{configurable:true,writable:true,value:'metadata'});
    video.sourceError=undefined;video.loadAction=undefined;
    const next=loadVideoInput(video.asElement(),source,new AbortController().signal);video.makeReady();await next;
  }
});

test('readiness reached synchronously by the current load is checked after load returns',async()=>{
  const video=new FakeVideo();
  video.loadAction=()=>{video.currentSrc=source;video.readyState=2;video.emit('loadeddata');};
  await loadVideoInput(video.asElement(),source,new AbortController().signal);
  assert.equal(video.loads,1);assert.equal(video.listenerCount(),0);assert.equal(video.removals,0);
});

test('synchronous abort during assignment or load resets the owned request',async()=>{
  for(const phase of ['source','load']){
    const video=new FakeVideo(),controller=new AbortController(),reason=new Error(`abort during ${phase}`);
    if(phase==='source')Object.defineProperty(video,'src',{get(){return video.attribute??'';},set(value:string){video.attribute=value;controller.abort(reason);}});
    else video.loadAction=()=>controller.abort(reason);
    await assert.rejects(loadVideoInput(video.asElement(),source,controller.signal),error=>error===reason);
    assert.equal(video.removals,1);assert.equal(video.listenerCount(),0);assert.equal(video.src,'');
  }
});

test('cleanup preserves a source installed synchronously by pause or source removal observers',async()=>{
  for(const phase of ['pause','remove']){
    const video=new FakeVideo(),controller=new AbortController();
    const result=loadVideoInput(video.asElement(),source,controller.signal);
    if(phase==='pause')video.pauseAction=()=>{video.src='replacement.webm';};
    else video.removeAction=()=>{video.src='replacement.webm';};
    controller.abort();await assert.rejects(result);
    assert.equal(video.src,new URL('replacement.webm',base).href);assert.equal(video.loads,1);
  }
});

test('stream-owned elements and invalid deadlines fail without media mutation',async()=>{
  for(const timeoutMs of [0,-1,Number.NaN,Infinity,30_001,null] as number[]){
    const video=new FakeVideo();
    await assert.rejects(loadVideoInput(video.asElement(),source,new AbortController().signal,{timeoutMs}),RangeError);
    assert.equal(video.assignments,0);assert.equal(video.loads,0);assert.equal(video.listenerCount(),0);
  }
  const video=new FakeVideo();video.srcObject={stream:true};
  await assert.rejects(loadVideoInput(video.asElement(),source,new AbortController().signal),/미디어 스트림/);
  assert.equal(video.assignments,0);assert.equal(video.loads,0);assert.equal(video.pauses,0);
  video.srcObject=null;const next=loadVideoInput(video.asElement(),source,new AbortController().signal);video.makeReady();await next;
});
