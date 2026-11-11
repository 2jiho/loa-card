import test from 'node:test';
import assert from 'node:assert/strict';
import {createRestoredPixelCapabilities} from '../src/features/card-scanner/acquisition/restored-pixel-capability';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';

const signal=()=>new AbortController().signal;
const options={maxFrames:2,lifetimeMs:10_000,maxWorkingBytes:8};
async function fixture(){const pixels=new Uint8ClampedArray([1,2,3,4]);return {pixels,id:{sourceFrameId:1,time:1,width:1,height:1,hash:await pixelHash(new Uint8Array(pixels))}};}

test('proof is opaque, owner-bound, and rejects cloned identity or buffer mutation',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities(options),other=createRestoredPixelCapabilities(options);
 const {pixels:verified,token}=await owner.issue(pixels,id,signal(),()=>true);
 assert.deepEqual(Object.keys(token),[]);assert.equal(JSON.stringify(token),'{}');
 assert.equal(await owner.verify(JSON.parse(JSON.stringify(token)),id,signal()),false);
 assert.equal(await other.verify(token,id,signal()),false);
 for(const changed of [{...id,sourceFrameId:2},{...id,time:2},{...id,width:2},{...id,height:2},{...id,hash:'f'.repeat(64)}])
  assert.equal(await owner.verify(token,changed,signal()),false);
 pixels[0]=99;assert.equal(await owner.verify(token,id,signal()),true,'the store buffer is not retained');
 verified[0]=99;assert.equal(await owner.verify(token,id,signal()),false);
});

test('issuance bounds concurrent work and copies its options; cancellation and close fail closed',async()=>{
 const {pixels,id}=await fixture(),config={...options,maxFrames:1},owner=createRestoredPixelCapabilities(config);config.maxFrames=100;
 const first=owner.issue(pixels,id,signal(),()=>true);
 await assert.rejects(owner.issue(pixels,id,signal(),()=>true),/issuance limit/);
 const {token}=await first;
 const controller=new AbortController();controller.abort();
 await assert.rejects(owner.verify(token,id,controller.signal),{name:'AbortError'});
 owner.close();await assert.rejects(owner.verify(token,id,signal()),/closed/);
 const insufficient=createRestoredPixelCapabilities({...options,maxWorkingBytes:7});
 await assert.rejects(insufficient.issue(pixels,id,signal(),()=>true),/budget/);
});

test('proof requires current source and exact SHA and expires',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,lifetimeMs:1});
 await assert.rejects(owner.issue(pixels,id,signal(),()=>false),/identity/);
 await assert.rejects(owner.issue(pixels,{...id,hash:'f'.repeat(64)},signal(),()=>true),/SHA mismatch/);
 const {token}=await owner.issue(pixels,id,signal(),()=>true);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(await owner.verify(token,id,signal()),false);
});

test('identity is snapshotted before hashing and getters or inherited fields are rejected',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const expected={...id},pending=owner.issue(pixels,id,signal(),()=>true);
 id.sourceFrameId=2;id.time=999;
 const {token}=await pending;
 assert.equal(await owner.verify(token,expected,signal()),true);
 assert.equal(await owner.verify(token,id,signal()),false);
 let invoked=0;
 const accessor={...expected,get time(){invoked++;return expected.time;}};
 await assert.rejects(owner.issue(pixels,accessor,signal(),()=>true),/identity/);
 assert.equal(await owner.verify(token,accessor,signal()),false);
 assert.equal(invoked,0);
 const inherited=Object.assign(Object.create({}),expected);
 await assert.rejects(owner.issue(pixels,inherited,signal(),()=>true),/identity/);
 assert.equal(await owner.verify(token,inherited,signal()),false);
});

test('signals cancel individual operations; explicit owner close revokes session proofs',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities(options),controller=new AbortController();
 const {token,pixels:held}=await owner.issue(pixels,id,controller.signal,()=>true);
 controller.abort();
 await assert.rejects(owner.verify(token,id,controller.signal),{name:'AbortError'});
 assert.equal(await owner.verify(token,id,signal()),true);
 assert.equal(held[0],pixels[0]);
 owner.close();await assert.rejects(owner.verify(token,id,signal()),/closed/);
});

test('one-use handoff moves verified bytes and invalidates all old references',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities(options),other=createRestoredPixelCapabilities(options);
 const {pixels:held,token}=await owner.issue(pixels,id,signal(),()=>true);
 assert.equal(await other.consume(token,id,signal()),undefined,'a foreign owner cannot spend the token');
 assert.equal(await owner.consume(structuredClone(token),id,signal()),undefined,'a cloned token is not an authority');
 const moved=await owner.consume(token,id,signal());
 assert.ok(moved);assert.deepEqual([...moved.pixels],[1,2,3,4]);assert.deepEqual(moved.identity,id);
 assert.ok(Object.isFrozen(moved.identity));assert.equal(held.byteLength,0,'the prior backing store is detached');
 assert.equal(await owner.verify(token,id,signal()),false);
 assert.equal(await owner.consume(token,id,signal()),undefined);
});

test('handoff fails closed on identity mismatch and does not invoke identity getters',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const first=await owner.issue(pixels,id,signal(),()=>true);
 assert.equal(await owner.consume(first.token,{...id,time:2},signal()),undefined);
 assert.equal(await owner.verify(first.token,id,signal()),false);
 const second=await owner.issue(pixels,id,signal(),()=>true);
 let invoked=0;const getter={...id,get time(){invoked++;return id.time;}};
 assert.equal(await owner.consume(second.token,getter,signal()),undefined);assert.equal(invoked,0);
 assert.equal(await owner.verify(second.token,id,signal()),false);
 const third=await owner.issue(pixels,id,signal(),()=>true),changing={...id};
 const pending=owner.consume(third.token,changing,signal());changing.sourceFrameId=2;
 assert.deepEqual((await pending)?.identity,id,'identity is captured before hashing');
});

test('handoff rejects bytes changed or detached before or during digest',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const first=await owner.issue(pixels,id,signal(),()=>true);first.pixels[0]=9;
 assert.equal(await owner.consume(first.token,id,signal()),undefined);assert.equal(await owner.verify(first.token,id,signal()),false);
 const second=await owner.issue(pixels,id,signal(),()=>true);
 const pending=owner.consume(second.token,id,signal());second.pixels[0]=9;
 assert.equal(await pending,undefined);assert.equal(await owner.verify(second.token,id,signal()),false);
 const third=await owner.issue(pixels,id,signal(),()=>true);
 structuredClone(third.pixels,{transfer:[third.pixels.buffer]});
 assert.equal(await owner.consume(third.token,id,signal()),undefined);assert.equal(await owner.verify(third.token,id,signal()),false);
});

test('concurrent consume and verify cannot revive a consumed token',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxWorkingBytes:16});
 const {pixels:held,token}=await owner.issue(pixels,id,signal(),()=>true);
 const before=owner.verify(token,id,signal()),first=owner.consume(token,id,signal()),second=owner.consume(token,id,signal());
 assert.equal(await before,false,'verification in flight observes revocation');assert.equal(await second,undefined);
 assert.ok(await first);assert.equal(held.byteLength,0);assert.equal(await owner.verify(token,id,signal()),false);
});

test('handoff consumes on cancellation, owner close, expiry, and exhausted budget',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const first=await owner.issue(pixels,id,signal(),()=>true),already=new AbortController();already.abort();
 await assert.rejects(owner.consume(first.token,id,already.signal),{name:'AbortError'});
 assert.equal(await owner.verify(first.token,id,signal()),false);
 const second=await owner.issue(pixels,id,signal(),()=>true),during=new AbortController();
 const pending=owner.consume(second.token,id,during.signal);during.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(await owner.verify(second.token,id,signal()),false);
 const third=await owner.issue(pixels,id,signal(),()=>true),closing=owner.consume(third.token,id,signal());owner.close();
 await assert.rejects(closing,/closed/);
 const expiring=createRestoredPixelCapabilities({...options,lifetimeMs:1});
 const expired=await expiring.issue(pixels,id,signal(),()=>true);await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(await expiring.consume(expired.token,id,signal()),undefined);
 const limited=createRestoredPixelCapabilities({...options,maxFrames:2});
 const a=await limited.issue(pixels,id,signal(),()=>true),b=await limited.issue(pixels,id,signal(),()=>true);
 const consuming=limited.consume(a.token,id,signal());
 await assert.rejects(limited.consume(b.token,id,signal()),/budget/);
 assert.equal(await limited.verify(b.token,id,signal()),false);assert.ok(await consuming);
});

test('issuance rejects shared, resizable, partial and detached source buffers',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const shared=new Uint8ClampedArray(new SharedArrayBuffer(4));shared.set(pixels);
 await assert.rejects(owner.issue(shared as Uint8ClampedArray<ArrayBuffer>,id,signal(),()=>true),/identity/);
 const resizable=new Uint8ClampedArray(new ArrayBuffer(4,{maxByteLength:8}));resizable.set(pixels);
 await assert.rejects(owner.issue(resizable,id,signal(),()=>true),/identity/);
 const partial=new Uint8ClampedArray(new ArrayBuffer(8),2,4);partial.set(pixels);
 await assert.rejects(owner.issue(partial,id,signal(),()=>true),/identity/);
 const detached=pixels.slice();structuredClone(detached,{transfer:[detached.buffer]});
 await assert.rejects(owner.issue(detached,id,signal(),()=>true),/identity/);
});

test('shadowed typed-array buffer and length getters cannot forge a handoff or retain the original buffer',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities(options);
 const heldResult=await owner.issue(pixels,id,signal(),()=>true),held=heldResult.pixels;
 const proto=Object.getPrototypeOf(Uint8Array.prototype) as object;
 const getBuffer=Object.getOwnPropertyDescriptor(proto,'buffer')!.get!;
 const getLength=Object.getOwnPropertyDescriptor(proto,'byteLength')!.get!;
 const actual=getBuffer.call(held) as ArrayBuffer,fake=new ArrayBuffer(4);let invoked=0;
 for(const [field,value] of [['buffer',fake],['byteLength',4],['byteOffset',0],['length',4]] as const)
  Object.defineProperty(held,field,{configurable:true,get(){invoked++;return value;}});
 assert.equal(await owner.verify(heldResult.token,id,signal()),true);
 const moved=await owner.consume(heldResult.token,id,signal());assert.ok(moved);
 assert.deepEqual([...moved.pixels],[1,2,3,4]);assert.equal(getLength.call(held),0);
 assert.equal(actual.byteLength,0,'the internal backing buffer was transferred');
 assert.equal(fake.byteLength,4,'the attacker-provided buffer was not transferred');assert.equal(invoked,0);
});

test('proxy and subclass rasters fail closed without consuming a different valid token',async()=>{
 const {pixels,id}=await fixture(),owner=createRestoredPixelCapabilities({...options,maxFrames:4});
 const proxy=new Proxy(pixels,{});
 await assert.rejects(owner.issue(proxy,id,signal(),()=>true),/identity/);
 class Subclass extends Uint8ClampedArray {}
 const subclass=new Subclass(pixels);
 await assert.rejects(owner.issue(subclass,id,signal(),()=>true),/identity/);
 const first=await owner.issue(pixels,id,signal(),()=>true),other=await owner.issue(pixels,id,signal(),()=>true);
 Object.setPrototypeOf(first.pixels,Object.prototype);
 assert.equal(await owner.consume(first.token,id,signal()),undefined);
 assert.equal(await owner.verify(first.token,id,signal()),false);
 assert.ok(await owner.consume(other.token,id,signal()),'another token remains valid');
});
