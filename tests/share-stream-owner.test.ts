import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createShareAttemptGuard,createShareStreamOwner,watchShareTrackEnds,createShareResultOwner,csvSaveBlockReason,canPersistScanResult,retrySeed} from '../src/features/card-scanner/capture/share-stream-owner';

function fakeTrack(kind:'video'|'audio'='video') {
  return {kind,readyState:'live',calls:0,fail:false,stop(){this.calls++;if(this.fail)throw Error('stop');this.readyState='ended';}};
}
const stream=(getTracks:()=>unknown[])=>({getTracks}) as unknown as MediaStream;

test('stops every track and retains an uncertain stream until a successful retry',()=>{
  const owner=createShareStreamOwner(),video=fakeTrack(),audio=fakeTrack('audio');video.fail=true;
  const source=stream(()=>[video,audio]);owner.adopt(source);
  assert.deepEqual(owner.stopAll(),{confirmed:false,pending:1});
  assert.equal(video.calls,1);assert.equal(audio.calls,1);assert.equal(audio.readyState,'ended');
  assert.equal(owner.has(source),true);video.fail=false;
  assert.deepEqual(owner.stopAll(),{confirmed:true,pending:0});
  assert.equal(video.readyState,'ended');assert.equal(owner.has(source),false);
});

test('retains and stops a previously observed track removed from its stream',()=>{
  const owner=createShareStreamOwner(),video=fakeTrack();let tracks:unknown[]=[video];
  const source=stream(()=>tracks);owner.adopt(source);tracks=[];
  assert.equal(owner.reconcile(),false);
  assert.deepEqual(owner.stopAll(),{confirmed:true,pending:0});
  assert.equal(video.calls,1);assert.equal(video.readyState,'ended');
});

test('getter failure does not discard a known track or skip its stop',()=>{
  const owner=createShareStreamOwner(),video=fakeTrack();let fail=false;
  const source=stream(()=>{if(fail)throw Error('getTracks');return [video];});owner.adopt(source);fail=true;
  assert.deepEqual(owner.stopAll(),{confirmed:false,pending:1});assert.equal(video.calls,1);
  assert.equal(owner.has(source),true);fail=false;
  assert.equal(owner.reconcile(),true);assert.equal(owner.pending(),0);
});

test('a track still live after stop and a stream with no video remain uncertain',()=>{
  const owner=createShareStreamOwner();
  const video={kind:'video',readyState:'live',stop(){}};
  const source=stream(()=>[video]);owner.adopt(source);
  assert.deepEqual(owner.stopAll(),{confirmed:false,pending:1});assert.equal(owner.reconcile(),false);
  video.readyState='ended';assert.equal(owner.reconcile(),true);
  const empty=stream(()=>[]);owner.adopt(empty);
  assert.deepEqual(owner.stopAll(),{confirmed:false,pending:1});assert.equal(owner.has(empty),true);
});

test('failure on one stream does not prevent stopping or confirming other streams',()=>{
  const owner=createShareStreamOwner(),one=fakeTrack(),two=fakeTrack();one.fail=true;
  const first=stream(()=>[one]),second=stream(()=>[two]);owner.adopt(first);owner.adopt(second);
  assert.deepEqual(owner.stopAll(),{confirmed:false,pending:1});
  assert.equal(owner.has(first),true);assert.equal(owner.has(second),false);assert.equal(two.calls,1);
});

test('a pending chooser blocks another and invalidation fences delayed play or chooser results',()=>{
  const guard=createShareAttemptGuard(),first=guard.begin()!;
  assert.equal(guard.begin(),undefined);assert.equal(guard.current(first),true);
  guard.invalidate();assert.equal(guard.current(first),false);assert.equal(guard.picking(),true);
  assert.equal(guard.begin(),undefined,'invalidating does not release a still-pending chooser');
  guard.finish(first);const second=guard.begin()!;
  assert.equal(guard.current(second),true);
  guard.finish(first);assert.equal(guard.picking(),true,'an old completion cannot release the new chooser');
  assert.equal(guard.current(second),true);guard.finish(second);assert.equal(guard.picking(),false);
});

test('fresh ended state confirms a stop that ended its track before throwing',()=>{
  const owner=createShareStreamOwner(),video={kind:'video',readyState:'live',stop(){this.readyState='ended';throw Error('after end');}};
  const source=stream(()=>[video]);owner.adopt(source);
  assert.deepEqual(owner.stopAll(),{confirmed:true,pending:0});assert.equal(owner.has(source),false);
});

test('a stale attempt stops only its own track, leaving a newer stream live',()=>{
  const owner=createShareStreamOwner(),old=fakeTrack(),current=fakeTrack();
  const oldStream=stream(()=>[old]),newStream=stream(()=>[current]);owner.adopt(oldStream);owner.adopt(newStream);
  assert.equal(owner.stop(oldStream),true);assert.equal(current.calls,0);assert.equal(current.readyState,'live');
  assert.equal(owner.has(newStream),true);assert.equal(owner.pending(),1);
});

test('all observed and subsequently added tracks notify until disposed, including removed tracks',()=>{
  class Track extends EventTarget {constructor(public kind:'video'|'audio',public readyState='live'){super();}stop(){this.readyState='ended';}}
  class Source extends EventTarget {tracks:Track[]=[];getTracks(){return this.tracks;}}
  const owner=createShareStreamOwner(),source=new Source(),video=new Track('video'),audio=new Track('audio');source.tracks=[video];
  const media=source as unknown as MediaStream;owner.adopt(media);let notifications=0,faults=0;
  const dispose=watchShareTrackEnds(media,()=>notifications++,()=>faults++,track=>owner.observe(media,track));
  source.tracks.push(audio);const added=new Event('addtrack');Object.defineProperty(added,'track',{value:audio});source.dispatchEvent(added);
  source.tracks=[video];video.readyState='ended';video.dispatchEvent(new Event('ended'));
  assert.equal(owner.reconcile(),false,'a removed but previously observed audio track remains live');
  audio.readyState='ended';audio.dispatchEvent(new Event('ended'));assert.equal(owner.reconcile(),true);
  assert.equal(notifications,2);assert.equal(faults,0);dispose();audio.dispatchEvent(new Event('ended'));assert.equal(notifications,2);
});


test('result ownership excludes unstarted and late streams and replacement results',()=>{
  const owner=createShareResultOwner(),old=stream(()=>[]),pending=stream(()=>[]),newer=stream(()=>[]);
  const first=owner.begin(old);assert.equal(owner.ownsStream(pending),false);assert.equal(owner.owns(first),true);
  const next=owner.begin(newer);assert.equal(owner.ownsStream(old),false);assert.equal(owner.owns(first),false);assert.equal(owner.owns(next),true);
  owner.replace();assert.equal(owner.owns(next),false);assert.equal(owner.ownsStream(newer),false);
});
test('CSV policy blocks pending, picking, failed and busy with consistent reason',()=>{
  const safe={failed:false,warning:false,picking:false,sharing:false,pending:false,busy:false,count:1,review:0};
  assert.equal(csvSaveBlockReason(safe),'');
  for(const field of ['failed','warning','picking','sharing','pending','busy'] as const)assert.notEqual(csvSaveBlockReason({...safe,[field]:true}),'');
  assert.equal(csvSaveBlockReason({...safe,pending:true}),csvSaveBlockReason({...safe,sharing:true}));
  assert.notEqual(csvSaveBlockReason({...safe,review:1}),'');assert.notEqual(csvSaveBlockReason({...safe,count:0}),'');
});


test('known failed or interrupted results cannot replace backup even after error is dismissed',()=>{
  const safe={backupReady:true,hasState:true,busy:false,error:false,failed:false,unverified:false,sharing:false,pending:false,interrupted:false,unchanged:false};
  assert.equal(canPersistScanResult(safe),true);
  for(const flag of ['busy','error','failed','unverified','sharing','pending','interrupted','unchanged'] as const)assert.equal(canPersistScanResult({...safe,[flag]:true}),false);
});
test('a failed scan cannot seed its partial cards into the next attempt',()=>{
  const baseline=[{name:'기존'}],partial=[{name:'부분'}];
  assert.equal(retrySeed(true,partial,baseline),baseline);assert.equal(retrySeed(false,partial,baseline),partial);
});

