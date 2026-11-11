import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionDrainInputBuffer} from '../src/features/card-scanner/session/completion-drain-input-buffer';
import {CompletionDrainReservation} from '../src/features/card-scanner/session/completion-drain-reservation';
import {InputDecisionReplay} from '../src/features/card-scanner/reproduction/live-input-decision-replay';

// Exercises the real buffer, reservation and input replay reducer together.
// It does not run scanner.ts, decode pixels, or prove live-share performance.
function setup(){
 const replay=new InputDecisionReplay(new AbortController().signal);
 const buffer=new CompletionDrainInputBuffer<{width:number;height:number;closed:number;close():void}>();
 let seq=0;
 const record=(value:Record<string,unknown>)=>replay.recovery({version:1,seq:++seq,...value});
 const frames=[];
 for(let id=1;id<=2;id++){
  const stamp={inputId:id,captureTime:id,observedAtMs:id};
  replay.admission({kind:'consider',stamp,gates:{capturing:true,checkingCompletion:true},expected:'verification'});
  const frame={width:1,height:1,closed:0,close(){this.closed++;}};
  frames.push(frame);assert.equal(buffer.add(frame,id,id,stamp),true);record({kind:'retained',stamp});
 }
 return {replay,buffer,record,frames};
}

test('matched prefix followed by changed input keeps both frames ordered through recovery',async()=>{
 const {replay,buffer,record,frames}=setup();
 assert.equal(buffer.verify((_frame,id)=>{
  if(id===1){record({kind:'verified',inputId:id});return true;}
  return false;
 },()=>true),false);
 const order:number[]=[];let input;
 while((input=buffer.takeNext())){
  order.push(input.id);record({kind:'started',inputId:input.id});
  replay.link({inputId:input.id,frameId:input.id,captureTime:input.time,phase:'input'});
  record({kind:'finished',inputId:input.id,outcome:'completed'});
  input.frame.close();record({kind:'released',inputId:input.id,failed:false,reason:'processed'});
 }
 const summary=await replay.summary();
 assert.deepEqual(order,[1,2]);assert.deepEqual(frames.map(frame=>frame.closed),[1,1]);
 assert.equal(summary.settled,true);assert.equal(summary.recovery?.linked,2);assert.equal(summary.recovery?.lost,0);
});

test('expiration after one comparison releases every frame and leaves replay unsettled',async()=>{
 const {replay,buffer,record,frames}=setup();let now=0;
 const reservation=new CompletionDrainReservation(()=>{
  let input;
  while((input=buffer.takeNext())){
   record({kind:'lost',inputId:input.id,reason:'cancelled'});input.frame.close();
   record({kind:'released',inputId:input.id,failed:false,reason:'lost'});
  }
  assert.equal(buffer.clear(),true);
 },100,()=>now);
 const token=reservation.start();
 assert.equal(buffer.verify((_frame,id)=>{record({kind:'verified',inputId:id});now=100;return true;},
  ()=>reservation.valid(token)),false);
 const summary=await replay.summary();
 assert.equal(summary.settled,false);assert.equal(summary.recovery?.lost,2);
 assert.deepEqual(frames.map(frame=>frame.closed),[1,1]);assert.equal(reservation.active,false);
});
