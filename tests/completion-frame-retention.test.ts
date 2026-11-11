import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionFrameRetention,type CompletionFrameMetadata} from '../src/features/card-scanner/session/completion-frame-retention';

type Frame={id:string};
const metadata=(frame=1):CompletionFrameMetadata=>({box:{x:0,y:0,width:4,height:4},geometry:'roi',sourceWidth:4,sourceHeight:4,
 frame,inputId:frame,captureTime:frame});

test('one borrowed immutable frame is owned, replaced, and closed on disposal',()=>{
 const released:string[]=[],created:string[]=[];
 const retention=new CompletionFrameRetention<Frame>(64,frame=>{
  const clone={id:frame.id};created.push(clone.id);return {frame:clone,release:()=>released.push(clone.id)};
 });
 const meta=metadata(),source={id:'one'};retention.replace(source,meta);
 source.id='mutated';meta.box.x=2;
 assert.deepEqual(retention.read((frame,info)=>[frame.id,info.box.x,info.inputId]),['one',0,1]);
 retention.replace({id:'two'},metadata(2));assert.deepEqual(released,['one']);
 assert.deepEqual(retention.read((frame,info)=>[frame.id,info.frame]),['two',2]);
 retention.dispose();retention.dispose();assert.deepEqual(released,['one','two']);
 assert.equal(retention.read(()=>true),undefined);assert.deepEqual(created,['one','two']);
 assert.throws(()=>retention.replace({id:'late'},metadata(3)),/unavailable/);
});

test('bad geometry, source budget or clone failure clears previous proof without creating stale reuse',()=>{
 const released:string[]=[];
 const retention=new CompletionFrameRetention<Frame>(64,frame=>{
  if(frame.id==='bad')throw Error('clone failed');return {frame:{...frame},release:()=>released.push(frame.id)};
 });
 retention.replace({id:'one'},metadata());
 assert.throws(()=>retention.replace({id:'large'},{...metadata(2),sourceWidth:5}),/metadata/);
 assert.deepEqual(released,['one']);assert.equal(retention.available,false);
 retention.replace({id:'two'},metadata(2));assert.throws(()=>retention.replace({id:'bad'},metadata(3)),/clone failed/);
 assert.deepEqual(released,['one','two']);assert.equal(retention.read(()=>true),undefined);
 retention.replace({id:'three'},metadata(4));assert.equal(retention.available,true);
 assert.throws(()=>retention.replace({id:'outside'},{...metadata(5),box:{x:3,y:0,width:2,height:4}}),/metadata/);
 assert.deepEqual(released,['one','two','three']);assert.equal(retention.available,false);
});

test('release failure poisons the boundary instead of reusing or replacing unowned input',()=>{
 let releaseCount=0;
 const retention=new CompletionFrameRetention<Frame>(64,frame=>({frame,release:()=>{releaseCount++;throw Error('close failed');}}));
 retention.replace({id:'one'},metadata());assert.throws(()=>retention.replace({id:'two'},metadata(2)),/close failed/);
 assert.equal(retention.available,false);assert.equal(retention.read(()=>true),undefined);
 assert.throws(()=>retention.replace({id:'three'},metadata(3)),/unavailable/);
 retention.dispose();assert.equal(releaseCount,1);
});

test('holding and replacement never execute the ROI read callback until requested',()=>{
 let reads=0;const retention=new CompletionFrameRetention<Frame>(64,frame=>({frame:{...frame},release(){}}));
 for(let i=1;i<=500;i++)retention.replace({id:String(i)},metadata(i));
 assert.equal(reads,0);const current=retention.read((frame,info)=>{reads++;return [frame.id,info.frame];});
 assert.deepEqual(current,['500',500]);assert.equal(reads,1);retention.dispose();
});
