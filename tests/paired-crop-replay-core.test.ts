import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cropDigest,readPairedCropArchive} from '../dev/paired-crop-replay-core';

async function fixture(){
 const png=Uint8Array.from([137,80,78,71,13,10,26,10,1]),pngHash=await cropDigest(png),rgbaHash='a'.repeat(64);
 const source={sessionId:'s',frameId:2,observationId:'o',captureOrder:5,captureTime:1.2,phase:'input',slot:4};
 const box={x:10,y:20,width:1,height:1},meta={diagnosticReadId:1,processingFrame:2,slot:4,source,
  stage:'short',stable:true,borderAlignment:1,sourceBox:box,sourceWidth:100,sourceHeight:100,cropWidth:1,cropHeight:1,pixelKey:'pixel-1'};
 const image={id:'image-1',region:'recognition-card',status:'encoded',observation:{source:{...source},pixelKey:'pixel-1'},
  geometry:{sourceBox:{...box}},width:1,height:1,pngSha256:pngHash,rgbaSha256:rgbaHash,rasterRgbaSha256:rgbaHash,
  rgbaMatchesRaster:true,pngBytes:png.length,image:`data:image/png;base64,${btoa(String.fromCharCode(...png))}`};
 return {version:1,complete:true,images:[image],rows:[{diagnosticReadId:1,meta,card:{imageId:'image-1',shared:false,exactRegion:true,omitted:null}}]};
}
test('selected crops preserve source identities and shared references without asserting independent observations',async()=>{
 const input=await fixture();input.rows.push({...structuredClone(input.rows[0]),diagnosticReadId:2,
  meta:{...structuredClone(input.rows[0].meta),diagnosticReadId:2},card:{...input.rows[0].card,shared:true}});
 const result=await readPairedCropArchive({pairedCropEvidence:input});
 assert.equal(result.crops.length,2);assert.equal(result.crops[1].shared,true);
 assert.equal(result.crops[0].observationId,result.crops[1].observationId);
 assert.match(result.scope,/not independent frames/);
});
test('old and new refusal budget metadata leave saved crop replay compatible',async()=>{
 const input=await fixture();
 const row=input.rows[0] as typeof input.rows[0]&{outcome:unknown};
 row.outcome={admitted:false,budgetRemainingAtStart:3000,budgetRemainingAtEnd:2998};
 const old=await readPairedCropArchive(input);
 row.outcome={admitted:false,budgetRemainingAtStart:null,budgetRemainingAtEnd:null};
 const current=await readPairedCropArchive(input);
 assert.equal(old.crops.length,1);assert.deepEqual(current,old);
});
test('missing selected crops stay explicit omissions',async()=>{
 const input=await fixture();input.rows[0].card={imageId:null as never,shared:false,exactRegion:false,omitted:'budget' as never};
 const result=await readPairedCropArchive(input);assert.equal(result.crops.length,0);assert.equal(result.omitted,1);
});
test('corrupted bytes, inconsistent origins, forged raster proof and reordered reads fail closed',async()=>{
 for(const mutate of [
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.images[0].pngSha256='b'.repeat(64);},
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.images[0].observation.source.frameId=99;},
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.images[0].observation.pixelKey='different';},
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.images[0].rgbaMatchesRaster=false;},
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.images[0].geometry.sourceBox.x=99;},
  (v:Awaited<ReturnType<typeof fixture>>)=>{v.rows.push(structuredClone(v.rows[0]));},
 ]){const input=await fixture();mutate(input);await assert.rejects(readPairedCropArchive(input));}
});
