/** Keep stream and observed track references until a fresh observation confirms
 * every known track ended. A removed track can otherwise be lost while live.
 * Track state does not establish native or operating-system resource release. */
export function createShareStreamOwner() {
  type Owned={tracks:Set<MediaStreamTrack>};
  const streams=new Map<MediaStream,Owned>();
  const refresh=(stream:MediaStream,owned:Owned):boolean=>{
    try {for(const track of stream.getTracks())owned.tracks.add(track);return true;}
    catch{return false;}
  };
  const ended=(stream:MediaStream,owned:Owned):boolean=>{
    if(!refresh(stream,owned))return false;
    try {
      const tracks=[...owned.tracks];
      return tracks.some(track=>track.kind==='video')&&tracks.every(track=>track.readyState==='ended');
    } catch {return false;}
  };
  const reconcile=()=>{
    for(const [stream,owned] of streams)if(ended(stream,owned))streams.delete(stream);
    return streams.size===0;
  };
  const stop=(stream:MediaStream)=>{
    const owned=streams.get(stream);
    if(!owned)return true;
    // Observe already-ended tracks before retrying a throwing stop().
    if(ended(stream,owned)){streams.delete(stream);return true;}
    refresh(stream,owned);
    for(const track of owned.tracks)try {track.stop();} catch {/* Continue with every track. */}
    // Even when stop throws, a fresh ended observation can establish that the
    // track is no longer live. Failed enumeration/state reads remain unknown.
    if(ended(stream,owned)){streams.delete(stream);return true;}
    return false;
  };
  const stopAll=()=>{
    for(const stream of [...streams.keys()])stop(stream);
    return {confirmed:streams.size===0,pending:streams.size};
  };
  return {adopt:(stream:MediaStream)=>{
    if(!streams.has(stream)){const owned:Owned={tracks:new Set()};streams.set(stream,owned);refresh(stream,owned);}
  },observe:(stream:MediaStream,track:MediaStreamTrack)=>{streams.get(stream)?.tracks.add(track);},
  has:(stream:MediaStream)=>streams.has(stream),reconcile,stop,stopAll,pending:()=>streams.size,pendingStreams:()=>[...streams.keys()]};
}

/** A pending chooser owns its attempt until it settles, even after a stop.
 * Invalidating the epoch fences late chooser/play completions from starting a
 * scanner; ending an older attempt must not release a newer chooser. */
export function createShareAttemptGuard() {
  let epoch=0,picker:number|undefined;
  return {
    begin(){if(picker!==undefined)return undefined;picker=++epoch;return picker;},
    invalidate(){epoch++;},
    current:(token:number)=>epoch===token,
    finish(token:number){if(picker===token)picker=undefined;},
    picking:()=>picker!==undefined,
  };
}

/** Observe every track, including one later removed from the stream, so an OS
 * stop can be reconciled after multiple tracks end at different times. */
export function watchShareTrackEnds(stream:MediaStream,onEnded:()=>void,onFault:()=>void,onTrack?:(track:MediaStreamTrack)=>void) {
  const watched=new Set<MediaStreamTrack>();let closed=false;
  const onTrackEnded=()=>{if(!closed)onEnded();};
  const watch=(track:MediaStreamTrack)=>{
    if(watched.has(track))return;
    onTrack?.(track);
    track.addEventListener('ended',onTrackEnded);watched.add(track);
  };
  const onAdded=(event:Event)=>{
    try {watch((event as MediaStreamTrackEvent).track);}catch{onFault();}
  };
  const dispose=()=>{
    if(closed)return;closed=true;
    try{stream.removeEventListener('addtrack',onAdded);}catch{/* Best-effort listener cleanup. */}
    for(const track of watched)try{track.removeEventListener('ended',onTrackEnded);}catch{/* Best effort. */}
    watched.clear();
  };
  try {stream.addEventListener('addtrack',onAdded);for(const track of stream.getTracks())watch(track);}
  catch(error){dispose();throw error;}
  return dispose;
}

/** Link a displayed scan result to the stream that actually started it.
 * Pending picker/play streams and late old-stream failures cannot invalidate a
 * different result. `replace` is used for CSV, backup, or reset. */
export function createShareResultOwner() {
  let current:object|undefined;
  const owners=new WeakMap<MediaStream,object>();
  return {
    begin(stream:MediaStream){const token={};owners.set(stream,token);current=token;return token;},
    replace(){current=undefined;},
    owns(token:object){return current===token;},
    ownsStream(stream:MediaStream){const owner=owners.get(stream);return owner!==undefined&&owner===current;},
  };
}

export function csvSaveBlockReason(input:{failed:boolean;warning:boolean;picking:boolean;sharing:boolean;pending:boolean;busy:boolean;count:number;review:number}) {
  if(input.failed)return '스캔 결과를 확인할 수 없습니다. 다시 스캔해 주세요.';
  if(input.warning)return '화면 공유 종료를 확인해 주세요.';
  if(input.picking)return '공유 창 선택이 끝난 뒤 저장할 수 있습니다.';
  if(input.sharing||input.pending)return '화면 공유를 종료한 뒤 저장할 수 있습니다.';
  if(input.busy)return '스캔이 끝난 뒤 저장할 수 있습니다.';
  if(!input.count)return '저장할 카드가 없습니다.';
  if(input.review)return '카드 판독을 확인한 뒤 저장할 수 있습니다.';
  return '';
}

/** Only excludes known bad cases; this is not positive proof of completeness. */
export function canPersistScanResult(input:{backupReady:boolean;hasState:boolean;busy:boolean;error:boolean;failed:boolean;unverified:boolean;sharing:boolean;pending:boolean;interrupted:boolean;unchanged:boolean}){
  return input.backupReady&&input.hasState&&!input.busy&&!input.error&&!input.failed&&!input.unverified&&!input.sharing&&!input.pending&&!input.interrupted&&!input.unchanged;
}
export function retrySeed<T>(failed:boolean,current:T,baseline:T):T { return failed?baseline:current; }
