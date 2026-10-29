import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLiveVideoInput } from '../dev/live-video-input';
import type {MediaPlaybackFact} from '../dev/media-playback-observer';

class TrackedTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) { const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
class Track extends TrackedTarget {
  readyState = 'live'; clones: Track[] = [];
  constructor(readonly kind: 'video' | 'audio') { super(); }
  stop() { this.readyState = 'ended'; }
  clone() { const result = new Track(this.kind); this.clones.push(result); return result; }
}
class Stream extends TrackedTarget {
  constructor(readonly tracks: Track[] = []) { super(); }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  addTrack(track: Track) { this.tracks.push(track); this.dispatchEvent(new Event('addtrack')); }
}
class Video extends TrackedTarget {
  src = ''; srcObject: Stream | null = null; readyState = 0; videoWidth = 1920; videoHeight = 1080;
  duration = 10; muted = false; defaultMuted = false; playsInline = false; hidden = false;
  preload = ''; loop = false; playbackRate = 1; paused = true; seeking = false; removed = false;
  error: { code: number } | null = null; plays = 0; loads = 0; private time = 0;
  captured = new Stream([new Track('video'), new Track('audio')]);
  loadHook?: () => void; playHook?: () => Promise<void>;
  captureStream: (() => Stream) | undefined = () => this.captured;
  requestVideoFrameCallback?: (callback:VideoFrameRequestCallback)=>number;
  cancelVideoFrameCallback?: (handle:number)=>void;
  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = value; this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  load() {
    this.loads++;
    if (!this.src) { this.readyState = 0; return; }
    if (this.loadHook) { this.loadHook(); return; }
    queueMicrotask(() => { if (this.src) { this.readyState = 2; this.dispatchEvent(new Event('loadeddata')); } });
  }
  play() { this.plays++; this.paused = false; return this.playHook?.() ?? Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name: string) { assert.equal(name, 'src'); this.src = ''; }
  getAttribute(name: string) { assert.equal(name, 'src'); return this.src || null; }
  remove() { this.removed = true; }
}
const nativeVideo = (video: Video) => video as unknown as HTMLVideoElement;

function playbackCallbacks(video:Video) {
  let ordinal=0;const pending=new Map<number,VideoFrameRequestCallback>(),cancelled:number[]=[];
  video.requestVideoFrameCallback=callback=>{const id=++ordinal;pending.set(id,callback);return id;};
  video.cancelVideoFrameCallback=handle=>{cancelled.push(handle);pending.delete(handle);};
  return {pending,cancelled,fire(mediaTime:number,presentedFrames:number){
    assert.equal(pending.size,1);const [id,callback]=pending.entries().next().value!;pending.delete(id);
    callback(100,{mediaTime,presentedFrames,width:1920,height:1080} as VideoFrameCallbackMetadata);return callback;
  }};
}

async function environment(run: (input: { source: Video; target: Video; controller: AbortController; created: Video[] }) => Promise<void>) {
  const source = new Video(), target = new Video(), controller = new AbortController(), created: Video[] = [];
  const values = {
    window: { location: { href: 'http://127.0.0.1:5201/dev/scanner.html', origin: 'http://127.0.0.1:5201' } },
    document: { createElement: (tag: string) => { assert.equal(tag, 'video'); created.push(source); return source; } },
    MediaStream: Stream,
  };
  const prior = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try { await run({ source, target, controller, created }); }
  finally {
    controller.abort();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('visible source experiment mounts only its owned source and releases it on disposal',async()=>{
 await environment(async({source,target,controller})=>{
  const mounted:unknown[]=[];
  const container={append:(node:unknown)=>mounted.push(node)} as unknown as HTMLElement;
  const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{sourceContainer:container});
  assert.deepEqual(mounted,[source]);assert.equal(source.hidden,false);assert.equal(source.plays,0);
  await input.start();input.dispose();assert.equal(source.removed,true);
 });
});

test('prepare holds one source at zero until ready, sends only cloned video tracks, and preserves the final frame until disposal', async () => {
  await environment(async ({ source, target, controller, created }) => {
    const input = await prepareLiveVideoInput('/__corpus/cases/example/input/0', nativeVideo(target), controller.signal);
    assert.equal(created.length, 1); assert.equal(source.plays, 0); assert.equal(source.paused, true);
    assert.equal(target.plays, 0); assert.equal(input.inputSeconds, 0); assert.equal(input.durationSeconds, 10);
    assert.equal(source.hidden, true); assert.equal(source.muted, true);
    const output = target.srcObject!;
    assert.equal(output.getTracks().length, 1); assert.equal(output.getAudioTracks().length, 0);
    assert.notEqual(output.getVideoTracks()[0], source.captured.getVideoTracks()[0]);
    assert.equal(source.captured.getAudioTracks()[0].readyState, 'ended');
    const firstStart = input.start(); assert.equal(input.start(), firstStart); await firstStart;
    assert.equal(source.plays, 1); assert.equal(target.plays, 1);
    source.currentTime = 10; source.dispatchEvent(new Event('ended')); await input.completion;
    assert.equal(input.ended, true); assert.equal(input.inputSeconds, 10);
    assert.equal(output.getVideoTracks()[0].readyState, 'ended'); assert.equal(target.srcObject, output);
    await assert.rejects(input.start(), /종료/);
    input.dispose(); input.dispose();
    assert.equal(target.srcObject, null); assert.equal(source.src, ''); assert.equal(source.removed, true);
    assert.equal(source.listenerCount, 0); assert.equal(target.listenerCount, 0); assert.equal(source.captured.listenerCount, 0);
    assert.equal(target.muted, false); assert.equal(target.playsInline, false); assert.equal(input.inputSeconds, 10);
  });
});

test('late track creation primes off-screen and rewinds before attaching the scanner input', async () => {
  await environment(async ({ source, target, controller }) => {
    source.captured = new Stream();
    source.playHook = async () => {
      if (source.plays === 1) {
        assert.equal(target.srcObject, null); source.currentTime = 0.04;
        source.captured.addTrack(new Track('audio')); source.captured.addTrack(new Track('video'));
      }
    };
    const input = await prepareLiveVideoInput('blob:http://127.0.0.1:5201/local-file', nativeVideo(target), controller.signal);
    assert.equal(source.plays, 1); assert.equal(source.currentTime, 0); assert.equal(source.paused, true);
    assert.equal(input.inputSeconds, 0); assert.equal(target.plays, 0);
    await input.start(); assert.equal(source.plays, 2); input.dispose(); await input.completion;
  });
});

test('unsupported input and foreign URLs fail without claiming unrelated media resources', async () => {
  await environment(async ({ source, target, controller, created }) => {
    for (const url of ['https://example.com/test.mp4', 'data:video/mp4;base64,AAAA', 'file:///C:/test.mp4',
      'blob:https://example.com/file', 'http://user:password@127.0.0.1:5201/video', '/video#t=5'])
      await assert.rejects(prepareLiveVideoInput(url, nativeVideo(target), controller.signal), /URL/);
    assert.equal(created.length, 0);
    const external = new Stream([new Track('video')]); target.srcObject = external;
    await assert.rejects(prepareLiveVideoInput('/video', nativeVideo(target), controller.signal), /다른 입력/);
    assert.equal(external.getVideoTracks()[0].readyState, 'live'); assert.equal(created.length, 0);
    target.srcObject = null; source.captureStream = undefined;
    await assert.rejects(prepareLiveVideoInput('/video', nativeVideo(target), controller.signal), /지원/);
    assert.equal(source.src, ''); assert.equal(source.listenerCount, 0);
  });
});

test('decode failure, absent video dimensions, failed priming and early end release all owned resources', async () => {
  for (const setup of [
    (source: Video) => { source.loadHook = () => { source.error = { code: 3 }; source.dispatchEvent(new Event('error')); }; },
    (source: Video) => { source.videoWidth = 0; },
    (source: Video) => { source.captured = new Stream(); source.playHook = () => Promise.reject(Error('priming failed')); },
    (source: Video) => { source.captured = new Stream(); source.playHook = async () => { source.dispatchEvent(new Event('ended')); }; },
  ]) await environment(async ({ source, target, controller }) => {
    setup(source);
    await assert.rejects(prepareLiveVideoInput('/video', nativeVideo(target), controller.signal));
    assert.equal(source.src, ''); assert.equal(source.paused, true); assert.equal(target.srcObject, null);
    assert.equal(source.listenerCount, 0); assert.equal(target.listenerCount, 0); assert.equal(source.captured.listenerCount, 0);
    assert.ok(source.captured.getTracks().every(track => track.readyState === 'ended') || source.plays === 0,
      'capture tracks, once acquired, must stop on preparation failure');
  });
});

test('abort while loading or priming rejects promptly even when native promises never settle', async () => {
  await environment(async ({ source, target, controller }) => {
    source.loadHook = () => {};
    const pending = prepareLiveVideoInput('/video', nativeVideo(target), controller.signal); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(source.listenerCount, 0); assert.equal(source.src, '');
  });
  await environment(async ({ source, target, controller }) => {
    source.captured = new Stream(); let playStarted!: () => void;
    const began = new Promise<void>(resolve => { playStarted = resolve; });
    source.playHook = () => { playStarted(); return new Promise<void>(() => {}); };
    const pending = prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    await began; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(source.paused, true); assert.equal(source.src, ''); assert.equal(source.captured.listenerCount, 0);
  });
});

test('late play settlements after abort cannot restart the abandoned source or keep capture tracks alive', async () => {
  await environment(async ({ source, target, controller }) => {
    let sourcePlayed!: () => void, targetPlayed!: () => void;
    source.playHook = () => new Promise<void>(resolve => { sourcePlayed = () => { source.paused = false; resolve(); }; });
    target.playHook = () => new Promise<void>(resolve => { targetPlayed = () => { target.paused = false; resolve(); }; });
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    const output = target.srcObject!, starting = input.start(); controller.abort();
    await assert.rejects(starting, { name: 'AbortError' }); await assert.rejects(input.completion, { name: 'AbortError' });
    sourcePlayed(); targetPlayed(); await Promise.resolve();
    assert.equal(source.paused, true); assert.equal(target.paused, true); assert.equal(target.srcObject, null);
    assert.equal(source.src, ''); assert.ok(output.getTracks().every(track => track.readyState === 'ended'));
    assert.equal(source.listenerCount, 0); assert.equal(target.listenerCount, 0);
  });
});

test('media errors after start reject completion and disposal does not stop a replacement target owner', async () => {
  await environment(async ({ source, target, controller }) => {
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal); await input.start();
    const owned = target.srcObject!, replacement = new Stream([new Track('video')]); target.srcObject = replacement;
    source.error = { code: 3 }; source.dispatchEvent(new Event('error'));
    await assert.rejects(input.completion, /영상 재생 실패/); input.dispose();
    assert.equal(target.srcObject, replacement); assert.equal(replacement.getVideoTracks()[0].readyState, 'live');
    assert.ok(owned.getTracks().every(track => track.readyState === 'ended')); assert.equal(source.src, '');
  });
});

test('natural end can complete while a delayed target play is still pending', async () => {
  await environment(async ({ source, target, controller }) => {
    let targetPlayed!: () => void;
    target.playHook = () => new Promise<void>(resolve => { targetPlayed = () => { target.paused = false; resolve(); }; });
    source.playHook = async () => { source.currentTime = 10; source.dispatchEvent(new Event('ended')); };
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    await input.start(); await input.completion;
    assert.equal(input.ended, true); assert.equal(input.inputSeconds, 10);
    input.dispose(); targetPlayed(); await Promise.resolve();
    assert.equal(target.paused, true); assert.equal(target.srcObject, null);
  });
});

test('preparation and playback have bounded waits, while scanner track.stop also pauses source decoding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await environment(async ({ source, target, controller }) => {
    source.loadHook = () => {};
    const pending = prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    t.mock.timers.tick(10_000); await assert.rejects(pending, /시간 초과/);
    assert.equal(source.listenerCount, 0); assert.equal(source.src, '');
  });
  await environment(async ({ source, target, controller }) => {
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    source.playHook = () => new Promise<void>(() => {});
    const starting = input.start(); t.mock.timers.tick(10_000);
    await assert.rejects(starting, /시간 초과/); await assert.rejects(input.completion, /시간 초과/);
    assert.equal(target.srcObject, null); assert.equal(source.paused, true);
  });
  await environment(async ({ source, target, controller }) => {
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal); await input.start();
    source.currentTime = 3; target.srcObject!.getVideoTracks()[0].stop(); t.mock.timers.tick(100);
    await input.completion; assert.equal(source.paused, true); assert.equal(input.inputSeconds, 3);
    assert.equal(input.ended, false, 'scanner early stop is distinct from playing the entire source'); input.dispose();
  });
});

test('an input claimed while source data is loading is never overwritten or paused', async () => {
  for (const replacementKind of ['stream', 'src'] as const) await environment(async ({ source, target, controller }) => {
    const replacement = new Stream([new Track('video')]);
    target.src = '/previous-video'; target.paused = false;
    source.loadHook = () => {
      if (replacementKind === 'stream') target.srcObject = replacement;
      else target.src = '/replacement-video';
      source.readyState = 2; source.dispatchEvent(new Event('loadeddata'));
    };
    await assert.rejects(prepareLiveVideoInput('/video', nativeVideo(target), controller.signal), /다른 입력으로 변경/);
    assert.equal(target.srcObject, replacementKind === 'stream' ? replacement : null);
    assert.equal(target.src, replacementKind === 'src' ? '/replacement-video' : '/previous-video');
    assert.equal(target.paused, false); assert.equal(target.plays, 0); assert.equal(target.loads, 0);
    assert.equal(target.muted, false); assert.equal(target.playsInline, false);
    assert.equal(replacement.getVideoTracks()[0].readyState, 'live');
    assert.equal(source.paused, true); assert.equal(source.src, ''); assert.equal(source.removed, true);
    assert.ok(source.captured.getTracks().every(track => track.readyState === 'ended'));
    assert.ok(source.captured.getVideoTracks()[0].clones.every(track => track.readyState === 'ended'));
    assert.equal(source.listenerCount, 0); assert.equal(target.listenerCount, 0); assert.equal(source.captured.listenerCount, 0);
  });
});

test('start after target ownership changes rejects and cleans only the adapter resources', async () => {
  for (const replacementKind of ['stream', 'src', 'src-with-owned-stream'] as const)
    await environment(async ({ source, target, controller }) => {
      const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
      const owned = target.srcObject!, replacement = new Stream([new Track('video')]);
      if (replacementKind === 'stream') target.srcObject = replacement;
      else {
        if (replacementKind === 'src') target.srcObject = null;
        target.src = '/replacement-video';
      }
      target.paused = false; target.muted = true; target.playsInline = true;
      await assert.rejects(input.start(), /다른 입력으로 변경/);
      await assert.rejects(input.completion, /다른 입력으로 변경/); input.dispose();
      assert.equal(source.plays, 0); assert.equal(target.plays, 0); assert.equal(target.loads, 0); assert.equal(target.paused, false);
      assert.equal(target.srcObject, replacementKind === 'stream' ? replacement : replacementKind === 'src' ? null : owned);
      assert.equal(target.src, replacementKind === 'stream' ? '' : '/replacement-video');
      assert.equal(target.muted, true); assert.equal(target.playsInline, true);
      assert.equal(replacement.getVideoTracks()[0].readyState, 'live');
      assert.ok(owned.getTracks().every(track => track.readyState === 'ended'));
      assert.ok(source.captured.getTracks().every(track => track.readyState === 'ended'));
      assert.equal(source.paused, true); assert.equal(source.src, ''); assert.equal(source.removed, true);
      assert.equal(source.listenerCount, 0); assert.equal(target.listenerCount, 0);
    });
});

test('target replacement during pending play preserves the new owner when old plays settle', async () => {
  await environment(async ({ source, target, controller }) => {
    let sourcePlayed!: () => void, targetPlayed!: () => void;
    source.playHook = () => new Promise<void>(resolve => { sourcePlayed = resolve; });
    target.playHook = () => new Promise<void>(resolve => { targetPlayed = resolve; });
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal);
    const owned = target.srcObject!, starting = input.start();
    const replacement = new Stream([new Track('video')]); target.srcObject = replacement; target.paused = false;
    sourcePlayed(); targetPlayed();
    await assert.rejects(starting, /다른 입력으로 변경/); await assert.rejects(input.completion, /다른 입력으로 변경/);
    assert.equal(target.srcObject, replacement); assert.equal(target.paused, false); assert.equal(target.loads, 0);
    assert.equal(replacement.getVideoTracks()[0].readyState, 'live');
    assert.ok(owned.getTracks().every(track => track.readyState === 'ended'));
    assert.equal(source.paused, true); assert.equal(source.src, ''); assert.equal(source.listenerCount, 0);
  });
});

test('a replaced running target stops owned decoding without modifying replacement playback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await environment(async ({ source, target, controller }) => {
    const input = await prepareLiveVideoInput('/video', nativeVideo(target), controller.signal); await input.start();
    const owned = target.srcObject!, replacement = new Stream([new Track('video')]);
    target.srcObject = replacement; target.paused = false; t.mock.timers.tick(100);
    await assert.rejects(input.completion, /다른 입력으로 변경/);
    assert.equal(target.srcObject, replacement); assert.equal(target.paused, false); assert.equal(target.loads, 0);
    assert.equal(replacement.getVideoTracks()[0].readyState, 'live');
    assert.ok(owned.getTracks().every(track => track.readyState === 'ended'));
    assert.equal(source.paused, true); assert.equal(source.src, ''); assert.equal(source.listenerCount, 0);
  });
});

test('optional telemetry observes the original source before play and retains duplicate callback media times',async()=>{
  await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source),facts:MediaPlaybackFact[]=[];
    target.requestVideoFrameCallback=()=>{throw Error('target must not be observed');};
    source.playHook=async()=>{assert.equal(callbacks.pending.size,1);assert.equal(facts[0]?.type,'start');};
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:fact=>facts.push(fact)});
    assert.equal(facts.length,0);assert.equal(callbacks.pending.size,0);
    await input.start();callbacks.fire(0,18);callbacks.fire(0,20);
    const late=callbacks.pending.values().next().value!;source.dispatchEvent(new Event('ended'));await input.completion;
    assert.deepEqual(facts.map(fact=>fact.type),['start','frame','frame','end']);
    assert.deepEqual(facts.filter(fact=>fact.type==='frame').map(fact=>[fact.callbackOrdinal,fact.mediaTime,fact.presentedFrames]),
      [[1,0,18],[2,0,20]]);
    assert.equal(facts[3].type==='end'&&facts[3].reason,'ended');assert.equal(callbacks.pending.size,0);
    late(200,{mediaTime:1,presentedFrames:99,width:1920,height:1080} as VideoFrameCallbackMetadata);
    input.dispose();assert.equal(facts.length,4);assert.equal(callbacks.cancelled.length,1);
  });
});

test('source observer starts after off-screen priming and rewind, while three-argument use schedules no callbacks',async()=>{
  await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source),facts:MediaPlaybackFact[]=[];
    source.captured=new Stream();source.playHook=async()=>{
      if(source.plays===1){
        assert.equal(callbacks.pending.size,0);source.currentTime=0.04;source.captured.addTrack(new Track('video'));
      }
    };
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:fact=>{
      if(fact.type==='start'){assert.equal(source.plays,1);assert.equal(source.currentTime,0);assert.equal(source.paused,true);}
      facts.push(fact);
    }});
    assert.equal(facts.length,0);await input.start();assert.equal(source.plays,2);input.dispose();await input.completion;
    assert.deepEqual(facts.map(fact=>fact.type),['start','end']);
  });
  await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source);
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal);await input.start();
    assert.equal(callbacks.pending.size,0);input.dispose();assert.equal(callbacks.cancelled.length,0);
  });
});

test('unsupported source callbacks emit an explicit lifecycle without fallback frame facts',async()=>{
  await environment(async({target,controller})=>{
    const facts:MediaPlaybackFact[]=[];
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:fact=>facts.push(fact)});
    await input.start();input.dispose();await input.completion;
    assert.deepEqual(facts.map(fact=>fact.type),['start','end']);
    assert.equal(facts[0].type==='start'&&facts[0].callbackSupported,false);
    assert.equal(facts[1].type==='end'&&facts[1].reason,'disposed');
    assert.equal(facts[1].type==='end'&&facts[1].callbacks,0);
    assert.equal(facts[1].type==='end'&&facts[1].naturalEnd,false);
  });
});

test('telemetry cancels on abort, source failure, scanner stop and disposal without touching replacement ownership',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  for(const reason of ['aborted','error','stopped','disposed'] as const)await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source),facts:MediaPlaybackFact[]=[];
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:fact=>facts.push(fact)});
    await input.start();callbacks.fire(0.1,5);const late=callbacks.pending.values().next().value!;
    const replacement=new Stream([new Track('video')]);
    if(reason==='stopped'){target.srcObject!.getVideoTracks()[0].stop();t.mock.timers.tick(100);}
    else{
      target.srcObject=replacement;target.paused=false;
      if(reason==='aborted')controller.abort();else if(reason==='error')source.dispatchEvent(new Event('error'));else input.dispose();
    }
    if(reason==='aborted'||reason==='error')await assert.rejects(input.completion);else await input.completion;
    assert.equal(callbacks.pending.size,0);assert.equal(callbacks.cancelled.length,1);
    const ending=facts.at(-1)!;assert.equal(ending.type,'end');
    if(ending.type==='end'){assert.equal(ending.reason,reason);assert.equal(ending.naturalEnd,false);assert.equal(ending.callbacks,1);}
    late(100,{mediaTime:2,presentedFrames:50,width:1920,height:1080} as VideoFrameCallbackMetadata);
    assert.equal(facts.length,3);
    if(reason!=='stopped'){
      assert.equal(target.srcObject,replacement);assert.equal(target.paused,false);assert.equal(replacement.getVideoTracks()[0].readyState,'live');
    }
    input.dispose();assert.equal(facts.length,3);
  });
});

test('telemetry sink exceptions report once and do not fail, pause or reorder media input',async()=>{
  for(const stage of ['start','frame','end'] as const)await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source),errors:unknown[]=[];
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:fact=>{
      if(fact.type===stage)throw Error(`observer ${stage}`);
    },onPlaybackError:error=>{errors.push(error);throw Error('error observer');}});
    await input.start();assert.equal(source.plays,1);assert.equal(target.plays,1);
    assert.equal(source.paused,false);assert.equal(target.paused,false);
    if(stage!=='start')callbacks.fire(0.1,1);
    assert.equal(source.paused,false);assert.equal(target.srcObject!.getVideoTracks()[0].readyState,'live');
    source.dispatchEvent(new Event('ended'));await input.completion;input.dispose();
    assert.equal(errors.length,1);assert.equal(callbacks.pending.size,0);assert.equal(input.ended,true);
  });
});

test('async telemetry failure stops observation while adapter cleanup preserves a replacement target owner',async()=>{
  await environment(async({source,target,controller})=>{
    const callbacks=playbackCallbacks(source),errors:unknown[]=[];
    const input=await prepareLiveVideoInput('/video',nativeVideo(target),controller.signal,{onPlayback:async fact=>{
      if(fact.type==='frame')throw Error('async observer failed');
    },onPlaybackError:async error=>{errors.push(error);throw Error('async report failed');}});
    await input.start();const owned=target.srcObject!;
    callbacks.fire(0.1,1);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(errors.length,1);assert.equal(callbacks.pending.size,0);assert.equal(callbacks.cancelled.length,1);
    assert.equal(source.paused,false);assert.equal(target.paused,false);assert.equal(owned.getVideoTracks()[0].readyState,'live');
    const replacement=new Stream([new Track('video')]);target.srcObject=replacement;target.paused=false;
    input.dispose();await input.completion;
    assert.equal(target.srcObject,replacement);assert.equal(target.paused,false);
    assert.equal(replacement.getVideoTracks()[0].readyState,'live');assert.equal(source.paused,true);
    assert.ok(owned.getTracks().every(track=>track.readyState==='ended'));assert.equal(errors.length,1);
  });
});
