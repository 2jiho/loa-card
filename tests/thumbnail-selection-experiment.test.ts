import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseThumbnailFrames,thumbnailDistance,type ThumbnailFrame} from '../dev/thumbnail-selection-experiment';

const f=(id:number,v:number,bytes=10):ThumbnailFrame=>({id,bytes,thumbnail:new Uint8Array(16).fill(v)});
test('latest retained, bounded budget and deterministic oldest tie',()=>{
 const active=f(1,0),pending=[f(2,12),f(3,12)],incoming=f(4,20);
 for(const policy of ['oldest','diversity'] as const){
  const a=chooseThumbnailFrames(active,pending,incoming,30,policy),b=chooseThumbnailFrames(active,pending,incoming,30,policy);
  assert.deepEqual(a,b);assert.deepEqual(a.kept.map(x=>x.id),[2,4]);
  assert.ok(active.bytes+a.kept.reduce((n,x)=>n+x.bytes,0)<=30);
 }
 assert.deepEqual(chooseThumbnailFrames(active,pending,incoming,20,'diversity').kept.map(x=>x.id),[4]);
 assert.deepEqual(chooseThumbnailFrames(active,pending,incoming,19,'diversity').kept,[]);
});
test('diversity can prefer an intermediate image while oldest keeps its first',()=>{
 const a=f(1,0),p=[f(2,2),f(3,70)],n=f(4,100);
 assert.deepEqual(chooseThumbnailFrames(a,p,n,30,'oldest').kept.map(x=>x.id),[2,4]);
 assert.deepEqual(chooseThumbnailFrames(a,p,n,30,'diversity').kept.map(x=>x.id),[3,4]);
});
test('occlusion can appear more diverse and is not proof of useful coverage',()=>{
 const a=f(1,80),p=[f(2,90),f(3,0)],n=f(4,100);
 assert.deepEqual(chooseThumbnailFrames(a,p,n,30,'diversity').kept.map(x=>x.id),[3,4]);
 assert.equal(thumbnailDistance(new Uint8Array(),new Uint8Array()),null);
});
test('unreadable descriptors use oldest fallback',()=>{
 const first={...f(2,1),thumbnail:new Uint8Array()},second={...f(3,2),thumbnail:new Uint8Array()};
 assert.deepEqual(chooseThumbnailFrames(f(1,0),[first,second],f(4,3),30,'diversity').kept.map(x=>x.id),[2,4]);
 assert.deepEqual(chooseThumbnailFrames(f(1,0),[first,f(3,70)],f(4,100),30,'diversity').kept.map(x=>x.id),[2,4]);
});
