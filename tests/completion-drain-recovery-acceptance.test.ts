import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionDrainRecovery} from '../src/features/card-scanner/session/completion-drain-recovery';
import {createLiveCapturePipeline} from '../src/features/card-scanner/capture/live-capture-pipeline';
const cells=(count:number)=>Array.from({length:count},(_,slot)=>({slot}));

test('recovery completion requires this input to reach the end of cell processing',async()=>{
  const receipt=new CompletionDrainRecovery(),losses:number[]=[],released:number[]=[];
  const pipeline=createLiveCapturePipeline({
    yieldTask:async()=>{},release:(frame:number)=>released.push(frame),onError:error=>{throw error;},
    onRecoveryLifecycle:event=>{
      if(event.kind==='started')receipt.start(event.inputId);
      if(event.kind==='finished'&&!receipt.verified(event.inputId,event.outcome))losses.push(event.inputId);
      if(event.kind==='released')receipt.release(event.inputId);
    },
    consume:async(frame:number)=>{
      // The consumer returned normally after acquisition linked the input,
      // but never reached the card loop (unlocated layout or full queue).
      if(frame===1)return;
      if(frame===2){assert.equal(receipt.accept(frame,cells(40),40,false),false);return;}
      assert.equal(receipt.accept(frame,cells(40),40,true),true);
    },
  });
  for(let id=1;id<=3;id++){
    assert.equal(pipeline.offerRecovery([{frame:id,stamp:{inputId:id,captureTime:id,observedAtMs:id}}]),true);
    await pipeline.flush();
  }
  assert.deepEqual(losses,[1,2]);
  assert.deepEqual(released,[1,2,3]);
  assert.equal(receipt.verified(3,'completed'),false,'release clears the input-specific acknowledgement');
  pipeline.dispose();
});

test('incomplete, empty, mismatched, unstaged and failed recovery cannot be acknowledged',()=>{
  const receipt=new CompletionDrainRecovery();
  assert.equal(receipt.accept(1,cells(40),40,true),false);
  receipt.start(1);
  for(const [actual,expected,admitted] of [[cells(0),0,true],[cells(39),40,true],[cells(40),40,false],[cells(40),NaN,true]] as const)
    assert.equal(receipt.accept(1,actual,expected,admitted),false);
  assert.equal(receipt.verified(1,'completed'),false);
  assert.equal(receipt.accept(1,cells(40),40,true),true);
  assert.equal(receipt.verified(1,'error'),false);
  assert.equal(receipt.verified(2,'completed'),false,'another input cannot borrow acceptance');
  receipt.release(1);
  assert.equal(receipt.verified(1,'completed'),false);
});

test('recovery accepts only a complete ordered slot set, including valid empty slots',()=>{
  const receipt=new CompletionDrainRecovery();receipt.start(1);
  const proper=cells(40),duplicate=cells(40),reversed=cells(40).reverse(),sparse=cells(40);
  duplicate[20]={slot:19};
  delete sparse[20];
  assert.equal(receipt.accept(1,duplicate,40,true),false);
  assert.equal(receipt.accept(1,reversed,40,true),false);
  assert.equal(receipt.accept(1,sparse,40,true),false);
  assert.equal(receipt.accept(1,proper.slice(0,39),40,true),false);
  assert.equal(receipt.verified(1,'completed'),false);
  const withEmpty=proper.map(cell=>({...cell,quality:{usable:false,reason:'미보유 카드 뒷면 · 빈 슬롯'}}));
  assert.equal(receipt.accept(1,withEmpty,40,true),true,'empty slots are still processed slots');
  assert.equal(receipt.verified(1,'completed'),true);
});
