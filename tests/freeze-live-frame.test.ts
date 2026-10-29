import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freezeLiveFrame,freezeLiveFrameTimed,type LiveFramePlatform} from '../src/features/card-scanner/freeze-live-frame.ts';
import {createLiveInputAdmission} from '../src/features/card-scanner/live-input-admission';

function video(width=1920,height=1080) {
 return {videoWidth:width,videoHeight:height} as HTMLVideoElement;
}
function frame(width=1920,height=1080) {
 let closed=0;
 const value={displayWidth:width,displayHeight:height,close(){closed++;}} as VideoFrame;
 return {value,closed:()=>closed};
}
function raster(error?:Error) {
 const calls:unknown[][]=[];
 const canvas={width:0,height:0,getContext(...args:unknown[]){calls.push(args);return {drawImage(...input:unknown[]){calls.push(input);if(error)throw error;}};}} as unknown as HTMLCanvasElement;
 return {canvas,calls};
}
const noCanvas=()=>{throw Error('must not allocate a fallback canvas');};

test('snapshot timing excludes earlier diagnostic work and preserves admission cadence',()=>{
 const admission=createLiveInputAdmission(),gates={capturing:true,checkingCompletion:false};
 let clock=1000;
 const stamp=admission.stamp(1,clock);assert.equal(admission.consider(stamp,gates).kind,'freeze');
 clock+=100; // A slow optional diagnostic sink is outside the snapshot effect.
 const copy=frame(),measured=freezeLiveFrameTimed(video(),{
  createFrame:()=>{clock+=2;return copy.value;},createCanvas:noCanvas,
 },()=>clock);
 assert.equal(measured.freezeMs,2);assert.ok(measured.frame);
 admission.frozen(stamp,{succeeded:!!measured.frame,freezeMs:measured.freezeMs});
 assert.equal(admission.snapshot().meanFreezeMs,2);
 // Even a backwards media scroll is independent of wall-time admission.
 clock+=33;
 const next=admission.stamp(.5,clock);assert.equal(admission.consider(next,gates).kind,'freeze');
 admission.frozen(next,{succeeded:false,freezeMs:0});
 measured.frame.close();measured.frame.close();assert.equal(copy.closed(),1);
});

test('video freeze returns an owned frame and releases it only once',()=>{
 const source=video(),copy=frame();let captured:HTMLVideoElement|undefined;
 const frozen=freezeLiveFrame(source,{createFrame:input=>{captured=input;return copy.value;},createCanvas:noCanvas});
 assert.ok(frozen);assert.equal(captured,source);assert.equal(frozen.source,copy.value);
 assert.equal(frozen.width,1920);assert.equal(frozen.height,1080);assert.equal(copy.closed(),0);
 frozen.close();frozen.close();assert.equal(copy.closed(),1);
});

test('borrowed track frames are cloned and their owner keeps the original',()=>{
 const source=frame(),copy=frame();let clones=0;
 source.value.clone=()=>{clones++;return copy.value;};
 const frozen=freezeLiveFrame(source.value,{createFrame:()=>{throw Error('borrowed frames use clone');},createCanvas:noCanvas});
 assert.ok(frozen);assert.equal(clones,1);assert.equal(frozen.source,copy.value);
 frozen.close();frozen.close();assert.equal(copy.closed(),1);assert.equal(source.closed(),0);
});

test('unsupported or failed VideoFrame construction snapshots the source synchronously on a CPU canvas',()=>{
 for(const createFrame of [undefined,()=>{throw Error('unsupported source');}]) {
  const source=video(2560,1440),target=raster();
  const frozen=freezeLiveFrame(source,{createFrame,createCanvas:()=>target.canvas});
  assert.ok(frozen);assert.equal(frozen.source,target.canvas);assert.equal(frozen.width,2560);assert.equal(frozen.height,1440);
  assert.deepEqual(target.calls,[['2d',{willReadFrequently:true}],[source,0,0]],'the source is copied before returning to the caller');
  assert.equal(target.canvas.width,2560);assert.equal(target.canvas.height,1440);
  frozen.close();frozen.close();assert.equal(target.canvas.width,0);assert.equal(target.canvas.height,0);
 }
});

test('failed borrowed clone falls back to a snapshot without closing the borrowed resource',()=>{
 const source=frame(),target=raster();source.value.clone=()=>{throw Error('clone unavailable');};
 const frozen=freezeLiveFrame(source.value,{createCanvas:()=>target.canvas});
 assert.ok(frozen);assert.equal(target.calls[1][0],source.value);frozen.close();assert.equal(source.closed(),0);
});

test('zero or malformed dimensions never allocate or sample an input',()=>{
 const platform:LiveFramePlatform={createFrame:()=>{throw Error('must not freeze invalid input');},createCanvas:noCanvas};
 for(const [width,height]of[[0,1080],[1920,0],[-1,1080],[NaN,1080],[1920,Infinity],[1.5,2]]) {
  assert.equal(freezeLiveFrame(video(width,height),platform),null);
  assert.equal(freezeLiveFrame(frame(width,height).value,platform),null);
 }
});

test('invalid constructed snapshots are released before falling back',()=>{
 const invalid=frame(0,0),target=raster();
 const frozen=freezeLiveFrame(video(),{createFrame:()=>invalid.value,createCanvas:()=>target.canvas});
 assert.ok(frozen);assert.equal(invalid.closed(),1);assert.equal(frozen.source,target.canvas);frozen.close();
});

test('CPU snapshot errors release only the newly allocated canvas',()=>{
 const error=new Error('drawing failed'),source=frame(),target=raster(error);
 source.value.clone=()=>{throw Error('clone failed');};
 assert.throws(()=>freezeLiveFrame(source.value,{createCanvas:()=>target.canvas}),error);
 assert.equal(target.canvas.width,0);assert.equal(target.canvas.height,0);assert.equal(source.closed(),0);
});

test('takeNative moves only the owned clone once and close never touches transferred ownership',()=>{
 const borrowed=frame(),copy=frame();borrowed.value.clone=()=>copy.value;
 const frozen=freezeLiveFrame(borrowed.value,{createCanvas:noCanvas})!;
 assert.equal(frozen.takeNative(),copy.value);assert.equal(frozen.takeNative(),undefined);
 frozen.close();frozen.close();assert.equal(copy.closed(),0);assert.equal(borrowed.closed(),0);
 copy.value.close();assert.equal(copy.closed(),1);
});

test('closed native and canvas snapshots cannot be taken',()=>{
 const copy=frame(),frozen=freezeLiveFrame(video(),{createFrame:()=>copy.value,createCanvas:noCanvas})!;
 frozen.close();assert.equal(frozen.takeNative(),undefined);assert.equal(copy.closed(),1);
 const target=raster(),cpu=freezeLiveFrame(video(),{createCanvas:()=>target.canvas})!;
 assert.equal(cpu.takeNative(),undefined);assert.equal(target.canvas.width,1920);
 cpu.close();assert.equal(target.canvas.width,0);
});
