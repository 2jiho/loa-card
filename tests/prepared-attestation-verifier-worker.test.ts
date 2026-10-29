import test from 'node:test';
import assert from 'node:assert/strict';

test('rejected verifier requests cannot unlock an active owner or report disposal before its hash work joins',async()=>{
 const priorSelf=Object.getOwnPropertyDescriptor(globalThis,'self'),priorCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto'),realCrypto=globalThis.crypto;
 const messages:{kind:string;id?:number;error?:string}[]=[],digest=realCrypto.subtle.digest.bind(realCrypto.subtle);
 let release!:()=>void,gate=new Promise<void>(resolve=>{release=resolve;}),blocked=true;
 const scope={onmessage:undefined as undefined|((event:MessageEvent)=>Promise<void>),postMessage(value:unknown,options?:StructuredSerializeOptions){
  messages.push(structuredClone(value,options) as typeof messages[number]);
 }};
 const fakeCrypto=Object.create(realCrypto);
 Object.defineProperty(fakeCrypto,'subtle',{value:{async digest(algorithm:AlgorithmIdentifier,data:BufferSource){if(blocked)await gate;return digest(algorithm,data);}}});
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'crypto',{configurable:true,value:fakeCrypto});
 const descriptor={format:'I420',codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}};
 const request=(id:number)=>({data:{kind:'verify',id,binding:{sourceFrameId:id,captureTime:id},width:2,height:2,
  native:{descriptor,pixels:Uint8Array.from([16,80,160,235,70,190])}}} as MessageEvent);
 const active:Promise<void>[]=[];
 try{
  await import('../dev/prepared-attestation-verifier-worker');assert.ok(scope.onmessage);
  const handle=scope.onmessage!;await handle({data:{kind:'init',mode:'independent'}} as MessageEvent);
  const first=handle(request(1));active.push(first);
  const second=handle(request(2)),third=handle(request(3));active.push(second,third);
  try{
   await Promise.resolve();
   assert.deepEqual(messages.filter(value=>value.kind==='error').map(value=>value.id),[2,3]);
   assert.equal(messages.some(value=>value.kind==='verified'),false);
  }finally{blocked=false;release();await Promise.all(active);}
  assert.deepEqual(messages.filter(value=>value.kind==='verified').map(value=>value.id),[1]);
  await handle(request(4));assert.deepEqual(messages.filter(value=>value.kind==='verified').map(value=>value.id),[1,4]);
  blocked=true;gate=new Promise<void>(resolve=>{release=resolve;});
  const last=handle(request(5));active.push(last);await handle({data:{kind:'dispose'}} as MessageEvent);
  const rejected=handle(request(6));active.push(rejected);await rejected;
  try{assert.equal(messages.filter(value=>value.kind==='disposed').length,0);}
  finally{blocked=false;release();await last;}
  assert.equal(messages.filter(value=>value.kind==='disposed').length,1);
  assert.deepEqual(messages.filter(value=>value.kind==='verified').map(value=>value.id),[1,4]);
 }finally{
  blocked=false;release();await Promise.allSettled(active);
  if(priorSelf)Object.defineProperty(globalThis,'self',priorSelf);else Reflect.deleteProperty(globalThis,'self');
  if(priorCrypto)Object.defineProperty(globalThis,'crypto',priorCrypto);else Reflect.deleteProperty(globalThis,'crypto');
 }
});
