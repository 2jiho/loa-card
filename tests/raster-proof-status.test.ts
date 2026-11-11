import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rasterProofMessage,rasterProofStatus} from '../src/features/card-scanner/ui/raster-proof-status';

const proof={supported:true,complete:true,matches:true,uses:2,verified:2} as const;
test('record completion alone never proves that acquired and saved pixels match',()=>{
 assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:null}),'unverified');
 assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:{recordingComplete:true}}),'unsupported');
 assert.equal(rasterProofStatus({hasExact:false,inspectionFailed:false,summary:null}),'unsupported');
});
test('only a supported complete linked proof may report a match',()=>{
 assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:{recordingComplete:true,rasterProof:proof}}),'matched');
 for(const recordingComplete of [false,null] as const)
  assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:{recordingComplete,rasterProof:proof}}),'incomplete');
 assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:{recordingComplete:true,rasterProof:{...proof,complete:false,matches:null}}}),'incomplete');
 for(const bad of [{...proof,matches:false},{...proof,uses:0,verified:0},{...proof,verified:1}])
  assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:false,summary:{recordingComplete:true,rasterProof:bad}}),'failed');
 assert.equal(rasterProofStatus({hasExact:true,inspectionFailed:true,summary:null}),'failed');
});
test('message separates event/hash bindings from decoding saved pixel bytes',()=>{
 assert.match(rasterProofMessage('matched'),/해시 연결 일치/);
 assert.match(rasterProofMessage('matched'),/재판독 시 별도 검사/);
 assert.match(rasterProofMessage('failed'),/검증 실패 또는 기록 불일치/);
 assert.match(rasterProofMessage('unsupported'),/미지원/);
});
