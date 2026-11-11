import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FieldDiagnosticImages, previewOrCapture} from '../src/features/card-scanner/acquisition/field-diagnostic-images';
import {InventoryEvidence} from '../src/features/card-scanner/session/inventory-evidence';
import {pendingScanFields} from '../src/features/card-scanner/session/current-scan-fields';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

test('failure pixels are capture-ordered and encode the current observation', () => {
  const images = new FieldDiagnosticImages(); let encoded = 0;
  images.capture('a', 2, 'pixels1', () => { encoded++; return 'one'; });
  images.capture('a', 3, 'pixels1', () => { encoded++; return 'current'; });
  images.capture('a', 1, 'older', () => { throw Error('older capture replaced latest'); });
  assert.equal(images.get('a', 2), undefined);
  assert.equal(images.get('a', 3), 'current');
  images.resolved('a', 2); assert.equal(images.get('a', 3), 'current');
  images.capture('a', 4, 'pixels2', () => { encoded++; return 'two'; });
  assert.equal(encoded, 3);
  images.resolved('a', 4); assert.equal(images.get('a', 4), undefined);
});

test('same source and crop key do not reuse a different encoded diagnostic', () => {
  const images=new FieldDiagnosticImages();
  const source:InventorySource={sessionId:'scan',frameId:1,observationId:'one',captureOrder:40,
    captureTime:1,phase:'input',slot:0,frame:'frame-one'};
  assert.equal(images.captureCurrent('card',40,'pixels',()=> 'first variant',source,source),true);
  assert.equal(images.captureCurrent('card',40,'pixels',()=> 'current variant',source,source),true);
  assert.equal(images.get('card',40,source),'current variant');
});

test('failure images respect both image and encoded-byte budgets', () => {
  const images = new FieldDiagnosticImages(2, 7);
  images.capture('a', 1, 'a', () => 'aaa');
  images.capture('b', 1, 'b', () => 'bbb');
  images.capture('c', 1, 'c', () => 'ccc');
  assert.equal(images.get('a', 1), undefined);
  assert.equal(images.get('b', 1), 'bbb');
  images.capture('d', 1, 'd', () => 'ddddd');
  assert.equal(images.get('b', 1), undefined);
  assert.equal(images.get('c', 1), undefined);
  assert.equal(images.get('d', 1), 'ddddd');
  images.capture('e', 1, 'e', () => 'oversized');
  assert.equal(images.get('e', 1), undefined);
});

test('an unavailable optional preview falls back to the still-owned capture', () => {
  let calls=0;
  const capture=()=>{calls++;return 'data:image/webp;base64,YQ==';};
  assert.equal(previewOrCapture('data:image/jpeg;base64,Yg==',capture),'data:image/jpeg;base64,Yg==');
  assert.equal(calls,0);
  assert.equal(previewOrCapture('',capture),'data:image/webp;base64,YQ==');
  assert.equal(previewOrCapture(undefined,capture),'data:image/webp;base64,YQ==');
  assert.equal(previewOrCapture('not-an-image',capture),'data:image/webp;base64,YQ==');
  assert.equal(calls,3);
  assert.equal(previewOrCapture('',()=> 'data:,'),'');
  assert.equal(previewOrCapture('',()=> 'invalid-image'),'');
  assert.throws(()=>previewOrCapture('',()=>{throw Error('canvas blocked');}),/canvas blocked/);
});

test('a missing encoding cannot cache a blank image or let an older capture replace it', () => {
  const images=new FieldDiagnosticImages();
  images.capture('a',2,'old',()=> 'old pixels');
  assert.equal(images.get('a',undefined),undefined,'an unknown capture order cannot select an image');
  images.capture('a',3,'new',()=> '');
  assert.equal(images.get('a',3),undefined);
  images.capture('a',2,'late',()=>{throw Error('older capture must not encode');});
  assert.equal(images.get('a',2),undefined);
  let calls=0;
  images.capture('a',4,'new',()=>{calls++;return 'recovered pixels';});
  assert.equal(calls,1);
  assert.equal(images.get('a',4),'recovered pixels');
});

test('a failed encoding at the same order cannot leave an unrelated older image visible', () => {
  const images=new FieldDiagnosticImages();
  images.capture('a',3,'first',()=> 'first pixels');
  images.capture('a',3,'other',()=>{throw Error('encoder failed');});
  assert.equal(images.get('a',3),undefined);
  images.capture('a',2,'older',()=>{throw Error('older capture must not encode');});
  images.capture('a',4,'latest',()=> 'latest pixels');
  assert.equal(images.get('a',4),'latest pixels');
  images.resolved('a',4);
  assert.equal(images.get('a',4),undefined);
});

test('late same-order failed crop cannot replace the selected diagnostic from another source', () => {
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3'}),images=new FieldDiagnosticImages();
  const source=(frameId:number,order=40):InventorySource=>({sessionId:'scan',frameId,observationId:`observation-${frameId}`,
    captureOrder:order,captureTime:order/10,phase:'input',slot:0,frame:`frame-${frameId}`});
  const failed=(input:InventorySource):ScannedCard=>({id:'card',name:'카드',awakening:0,extraCopies:null,
    confidence:.9,review:['장수 확인'],image:'',time:input.captureTime,observations:1,captureOrder:input.captureOrder,
    capturePosition:{frame:input.frame,slot:input.slot,stable:true,sort:null},countReliable:false});
  const first=source(1),second=source(2);
  inventory.acceptIdentity(first,'card');
  assert.equal(inventory.recordObservation(first,failed(first),.9).latestDiagnostic,true);
  // The first reader pauses before its finally block; the second becomes the
  // reducer's current diagnostic even though captureOrder collides.
  inventory.acceptIdentity(second,'card');
  assert.equal(inventory.recordObservation(second,failed(second),.9).latestDiagnostic,true);
  assert.equal(images.captureCurrent('card',40,'second',()=> 'second crop',second,
    inventory.latestFieldObservationSource('card')),true);
  let staleEncoded=false;
  assert.equal(images.captureCurrent('card',40,'first',()=>{staleEncoded=true;return 'first crop';},first,
    inventory.latestFieldObservationSource('card')),false);
  assert.equal(staleEncoded,false);
  const pending=pendingScanFields(inventory.latestFieldObservations.values(),
    {latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder});
  assert.equal(pending.length,1);
  assert.equal(images.get('card',pending[0].captureOrder,inventory.latestFieldObservationSource('card')),'second crop');
  assert.equal(images.get('card',40,first),undefined);
  assert.equal(images.get('card',40),undefined,'a source-bound image cannot be selected by order alone');
  assert.equal(images.captureCurrent('card',40,'first',()=> 'first crop',first,undefined),false,'missing provenance is unknown');
});
