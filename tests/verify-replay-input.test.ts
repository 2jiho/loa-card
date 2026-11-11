import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyReplayInput} from '../scripts/verify-replay-input';
import {createReproductionBundle} from '../src/features/card-scanner/reproduction/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {deflate,entryParts,packPixels,pixelHash} from '../src/features/card-scanner/reproduction/exact-recording-codec';

const signal=()=>new AbortController().signal;
async function fixture(options:{partial?:boolean;badHash?:boolean;eventsOutOfOrder?:boolean;wrongCount?:boolean}={}){
 const pixels=new Uint8Array([10,20,30,255,40,50,60,255]);
 const hash=options.badHash?'0'.repeat(64):await pixelHash(pixels);
 const payload=await deflate(packPixels(pixels));
 const frame=entryParts({kind:'frame',id:1,time:1,width:2,height:1,key:true,hash},payload);
 const events=options.eventsOutOfOrder?
   [...entryParts({kind:'event',seq:2,time:2,type:'other',value:null}),
    ...entryParts({kind:'event',seq:1,time:3,type:'other',value:null})]:[];
 const exact=new Blob([...frame,...events]);
 const file:ReproductionFile={video:new Blob(),exact,metadata:{version:3,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
   completed:!options.partial,recordState:options.partial?'partial':'complete',warnings:[],duration:2,type:'',bytes:0,seed:[],result:null,
   exact:{frames:options.wrongCount?2:1,events:options.eventsOutOfOrder?2:0,bytes:exact.size,dropped:0,peakQueuedBytes:0,
     peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''}}};
 return createReproductionBundle(file);
}
test('audits actual decoded pixels while keeping unsupported replay channels distinct',async()=>{
 const result=await verifyReplayInput(await fixture(),signal());
 assert.equal(result.recordedCoverage,'declared-complete');
 assert.equal(result.exact.supported,true);
 if(!result.exact.supported)throw Error('missing exact stream');
 assert.equal(result.exact.decodedFrames,1);assert.equal(result.exact.decodedPixelHashesVerified,true);
 assert.equal(result.exact.state.grid.supported,false);
 assert.equal(result.deliveredInputCoverage.status,'unknown');
 assert.equal(result.deliveredInputCoverage.callbackPixelBinding,'unproven');
 assert.equal(result.scope.recognitionRecomputed,false);assert.equal(result.scope.liveTimingReplayed,false);
 assert.equal(result.scope.originalCaptureAuthenticated,false);
});
test('a valid exact stream does not turn a partial session into complete coverage',async()=>{
 const result=await verifyReplayInput(await fixture({partial:true}),signal());
 assert.equal(result.recordedCoverage,'partial');assert.equal(result.exact.supported,true);
});
test('rejects wrong decoded hashes, event order and declared frame totals',async()=>{
 await assert.rejects(verifyReplayInput(await fixture({badHash:true}),signal()),/픽셀/);
 await assert.rejects(verifyReplayInput(await fixture({eventsOutOfOrder:true}),signal()),/이벤트 순서/);
 await assert.rejects(verifyReplayInput(await fixture({wrongCount:true}),signal()),/총량/);
});
test('video-only records cannot claim a decoded exact stream',async()=>{
 const file:ReproductionFile={video:new Blob(['video']),metadata:{version:1,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
   completed:true,warnings:[],duration:2,type:'video/webm',bytes:5,seed:[],result:null}};
 const result=await verifyReplayInput(createReproductionBundle(file),signal());
 assert.equal(result.exact.supported,false);assert.equal(result.scope.payloadPixelsDecoded,false);
 assert.equal(result.deliveredInputCoverage.status,'unknown');
 assert.equal(result.scope.videoDecoded,false);
});
