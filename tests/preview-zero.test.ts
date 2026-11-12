import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsPreviewZeroProof,previewZeroReading,selectZeroPreview} from '../src/features/card-scanner/session/preview-zero';

test('the first preferred preview that shows an empty counter is accepted', () => {
  assert.equal(selectZeroPreview([{order:5,zero:false,positive:false},{order:9,zero:true,positive:false},{order:7,zero:true,positive:false}]),1);
});

test('an empty counter seen before a later positive count does not confirm zero', () => {
  // The stable (preferred) preview is older than a capture that showed copies.
  assert.equal(selectZeroPreview([{order:3,zero:true,positive:false},{order:8,zero:false,positive:true}]),-1);
});

test('an empty counter seen after the positive count still confirms zero', () => {
  assert.equal(selectZeroPreview([{order:3,zero:true,positive:false},{order:8,zero:false,positive:true},{order:9,zero:true,positive:false}]),2);
});

test('no empty counter, no confirmation', () => {
  assert.equal(selectZeroPreview([]),-1);
  assert.equal(selectZeroPreview([{order:1,zero:false,positive:false}]),-1);
});

const emptyCounter={hasIcon:null,diagnostic:{iconColor:false,numericEvidence:false,iconRemnant:false,emptyFields:true,grayMarker:false,
  visibleBackground:false,grayBackgroundEmpty:false,iconFlat:true,digitsFlat:false,highFrequencyCover:false,flatCover:false}} as const;
const noProof={hasIcon:true,diagnostic:{...emptyCounter.diagnostic,iconColor:true,emptyFields:false}} as const;
const diagnostics=(iconPresent:boolean)=>({maximum:15,reason:'',readings:[],iconPresent});

test('a card needs the preview proof only for a missing count or an unconfirmed zero under count review', () => {
  assert.equal(needsPreviewZeroProof({awakening:2,extraCopies:null,review:['추가 장수 확인']}),true);
  assert.equal(needsPreviewZeroProof({awakening:2,extraCopies:0,countReliable:false,review:['추가 장수 확인']}),true);
  assert.equal(needsPreviewZeroProof({awakening:2,extraCopies:0,countReliable:true,review:['추가 장수 확인']}),false);
  assert.equal(needsPreviewZeroProof({awakening:2,extraCopies:3,countReliable:false,review:['추가 장수 확인']}),false);
  assert.equal(needsPreviewZeroProof({awakening:null,extraCopies:null,review:['추가 장수 확인']}),false);
  assert.equal(needsPreviewZeroProof({awakening:2,extraCopies:null,review:['이름 확인']}),false);
});

test('a re-read zero without an icon and with the same awakening shows zero', () => {
  const reading=previewZeroReading({values:{awakening:2,extraCopies:0,countDiagnostics:diagnostics(false)},packed:noProof,card:{awakening:2,observations:1},stillImage:false});
  assert.equal(reading.zero,true);assert.equal(reading.positive,false);
});

test('a re-read zero with another awakening is not zero without the empty-counter proof', () => {
  const reading=previewZeroReading({values:{awakening:3,extraCopies:0,countDiagnostics:diagnostics(false)},packed:noProof,card:{awakening:2,observations:1},stillImage:false});
  assert.equal(reading.zero,false);assert.equal(reading.positive,false);
});

test('the strict empty-counter proof shows zero when the reader left the count unread', () => {
  const reading=previewZeroReading({values:{awakening:null,extraCopies:null},packed:emptyCounter,card:{awakening:2,observations:1},stillImage:false});
  assert.equal(reading.zero,true);
  assert.equal(reading.diagnostics?.iconPresent,false);assert.equal(reading.diagnostics?.maximum,12);
  // No observation of the card, no proof.
  assert.equal(previewZeroReading({values:{awakening:null,extraCopies:null},packed:emptyCounter,card:{awakening:2,observations:0},stillImage:false}).zero,false);
});

test('a counter icon with a positive count is positive, never zero', () => {
  const reading=previewZeroReading({values:{awakening:2,extraCopies:4,countDiagnostics:diagnostics(true)},packed:noProof,card:{awakening:2,observations:2},stillImage:false});
  assert.equal(reading.zero,false);assert.equal(reading.positive,true);
  // A positive number read with the icon explicitly absent is neither.
  assert.equal(previewZeroReading({values:{awakening:2,extraCopies:4,countDiagnostics:diagnostics(false)},packed:noProof,card:{awakening:2,observations:2},stillImage:false}).positive,false);
});
