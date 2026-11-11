import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionDrainInputBuffer} from '../src/features/card-scanner/session/completion-drain-input-buffer';
import {CompletionDrainReservation} from '../src/features/card-scanner/session/completion-drain-reservation';
import {drainClockObservationSafe} from '../src/features/card-scanner/session/completion-drain-clock';

function frame(pixel:string,width=100,height=100){let closed=0;return {pixel,width,height,close(){closed++;},get closed(){return closed;}};}
test('every retained callback is checked in order, including a transient change followed by recovery',()=>{
 const a=frame('A'),b=frame('B'),buffer=new CompletionDrainInputBuffer<ReturnType<typeof frame>>(2,80000);
 assert.equal(buffer.add(b,2,2),true);assert.equal(buffer.add(a,3,3),true);
 const checked:number[]=[];
 assert.equal(buffer.verify((f,id)=>{checked.push(id);return f.pixel==='A';},()=>true),false);
 assert.deepEqual(checked,[2]);assert.equal(buffer.size,2,'failure cannot erase unresolved inputs');
 assert.equal(buffer.clear(),true);assert.equal(a.closed,1);assert.equal(b.closed,1);assert.equal(buffer.retainedBytes,0);
});
test('capacity, byte, order and time limits reject without taking ownership',()=>{
 const a=frame('A'),b=frame('B'),buffer=new CompletionDrainInputBuffer<ReturnType<typeof frame>>(1,40000);
 assert.equal(buffer.add(a,2,2),true);assert.equal(buffer.add(b,3,3),false);assert.equal(b.closed,0);
 buffer.clear();assert.equal(buffer.add(b,0,1),false);assert.equal(buffer.add(b,3,1),true);
 const c=frame('C');assert.equal(buffer.add(c,4,2),false);c.close();buffer.clear();
 const tiny=new CompletionDrainInputBuffer<ReturnType<typeof frame>>(2,39999);assert.equal(tiny.add(frame('D'),1,1),false);
});
test('deadline is checked synchronously before and after each comparison even if timers cannot run',()=>{
 let now=0;const released:string[]=[],reservation=new CompletionDrainReservation(reason=>released.push(reason),50,()=>now);
 const id=reservation.start(),buffer=new CompletionDrainInputBuffer<ReturnType<typeof frame>>();buffer.add(frame('A'),1,1);
 assert.equal(buffer.verify(()=>{now=51;return true;},()=>reservation.valid(id)),false);
 assert.equal(reservation.valid(id),false);assert.deepEqual(released,['expired']);buffer.clear();
});
test('release tries every owned frame even if one throws',()=>{
 let closed=0;const buffer=new CompletionDrainInputBuffer<{width:number;height:number;close():void}>();
 buffer.add({width:1,height:1,close(){throw Error('release');}},1,1);
 buffer.add({width:1,height:1,close(){closed++;}},2,2);
 assert.equal(buffer.clear(),false);assert.equal(closed,1);assert.equal(buffer.size,0);
});
test('retained inputs keep detached original timestamps and transfer frame ownership in order',()=>{
 const first=frame('first'),second=frame('second'),buffer=new CompletionDrainInputBuffer<ReturnType<typeof frame>>(2,80000);
 const source={mediaTime:1.25,presentedFrames:17,frameTimestampUs:1250000};
 const original={inputId:4,captureTime:2.5,observedAtMs:2502,source};
 assert.equal(buffer.add(first,4,2.5,original),true);
 assert.equal(buffer.add(second,5,2.5,{inputId:5,captureTime:2.5,observedAtMs:2503}),true);
 source.mediaTime=99;original.observedAtMs=99;
 const moved=buffer.takeNext();assert.ok(moved);
 assert.deepEqual(moved.stamp,{inputId:4,captureTime:2.5,observedAtMs:2502,
  source:{mediaTime:1.25,presentedFrames:17,frameTimestampUs:1250000}});
 assert.ok(Object.isFrozen(moved.stamp));assert.ok(Object.isFrozen(moved.stamp?.source));
 assert.equal(moved.frame,first);assert.equal(buffer.retainedBytes,40000);
 assert.equal(buffer.verify(()=>true,()=>true),false,'transferred input cannot be certified by remaining frames');
 const older=frame('older');assert.equal(buffer.add(older,3,2,{inputId:3,captureTime:2,observedAtMs:2}),false);
 assert.equal(older.closed,0,'a rejected frame remains with its caller');
 assert.equal(buffer.clear(),true);assert.equal(first.closed,0,'moved frame belongs to caller');assert.equal(second.closed,1);
 moved.frame.close();assert.equal(first.closed,1);assert.equal(buffer.takeNext(),undefined);
});
test('inconsistent input metadata or duplicate owned frames are rejected without taking ownership',()=>{
 const buffer=new CompletionDrainInputBuffer<ReturnType<typeof frame>>(2,80000),a=frame('a'),b=frame('b');
 assert.equal(buffer.add(a,1,1,{inputId:2,captureTime:1,observedAtMs:1}),false);
 assert.equal(buffer.add(a,1,1,{inputId:1,captureTime:2,observedAtMs:1}),false);
 assert.equal(buffer.add(a,1,1,{inputId:1,captureTime:1,observedAtMs:1,source:{mediaTime:-1}}),false);
 assert.equal(buffer.add(a,1,1,{inputId:1,captureTime:1,observedAtMs:2}),true);
 assert.equal(buffer.add(a,2,2,{inputId:2,captureTime:2,observedAtMs:3}),false);
 assert.equal(buffer.add(b,2,2,{inputId:2,captureTime:2,observedAtMs:1}),false);
 assert.equal(b.closed,0);assert.equal(buffer.clear(),true);assert.equal(a.closed,1);
});
test('drain fails closed for callback gaps, regression, skipped captures and unsupported timer',()=>{
 const good={kind:'callback',sequence:2,mediaTime:2,presentedFrames:3,mediaRelation:'advance',presentedRelation:'advance',missedFrames:0,captureEligible:true} as const;
 assert.equal(drainClockObservationSafe(good),true);
 assert.equal(drainClockObservationSafe({...good,missedFrames:1}),false);
 assert.equal(drainClockObservationSafe({...good,mediaRelation:'duplicate',captureEligible:false}),false);
 assert.equal(drainClockObservationSafe({...good,presentedRelation:'regression'}),false);
 assert.equal(drainClockObservationSafe({...good,sequence:null}),false);
 assert.equal(drainClockObservationSafe({kind:'timer',sequence:2,mediaTime:2,mediaRelation:'advance',captureEligible:true}),false);
});
