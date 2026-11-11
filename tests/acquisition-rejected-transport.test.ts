import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRejectedTransport} from '../src/features/card-scanner/acquisition/acquisition-client';

const metadata=(slot:number,usable:boolean,reason:string)=>({slot,quality:{usable,reason,sharpness:1},art:new Uint8Array(648),feature:new Uint8Array(3240),
 content:{x:0,y:0,width:140,height:210},preview:{x:0,y:0,width:140,height:210},alignment:1,intact:true,complete:true,labelVisible:true,
 borderSides:[1,1,1,1],pixelKey:'observation'});
const materialized=(slot:number,usable:boolean,reason:string)=>({...metadata(slot,usable,reason),cropState:'materialized',bitmap:{width:140,height:210}});
const omitted=(slot:number,reason:string)=>({...metadata(slot,false,reason),cropState:'omitted-rejected',originalWidth:140,originalHeight:210});
const validate=(cells:unknown[],count=cells.length)=>validateRejectedTransport(cells as Parameters<typeof validateRejectedTransport>[0],count);

test('reduced wire preserves candidates and one actual crop for each rejected reason',()=>{
 const cells=[materialized(0,true,'candidate'),materialized(1,false,'empty'),omitted(2,'empty'),materialized(3,false,'border'),omitted(4,'border')];
 assert.deepEqual(validate(cells),{omitted:2,kept:3,omittedRgbaBytes:2*140*210*4});
});

test('reduced wire rejects first examples, valid cards, missing raster and aliases in omitted entries',()=>{
 const first=materialized(0,false,'empty');
 const cases=[
  [omitted(0,'empty')],
  [first,{...omitted(1,'empty'),quality:{usable:true,reason:'empty',sharpness:1}}],
  [first,{...omitted(1,'empty'),bitmap:{}}],
  [first,{...omitted(1,'empty'),previewBitmap:{}}],
  [first,{...omitted(1,'empty'),originalWidth:0}],
  [first,{...omitted(1,'empty'),originalWidth:Number.MAX_SAFE_INTEGER}],
  [first,{...omitted(1,'empty'),slot:0}],
  [{...materialized(0,true,'candidate'),bitmap:undefined}],
  [{...materialized(0,true,'candidate'),pixels:{width:1,height:1,data:new Uint8ClampedArray(4)}}],
  [first,{...omitted(1,'empty'),slot:2}],
  [first,{...omitted(1,'empty'),art:new Uint8Array(1)}],
  [first,{...omitted(1,'empty'),feature:new Uint8Array(1)}],
  [first,{...omitted(1,'empty'),content:{x:0,y:0,width:NaN,height:1}}],
  [first,{...omitted(1,'empty'),quality:{usable:false,reason:'empty',sharpness:NaN}}],
  [first,{...omitted(1,'empty'),fieldRevision:''}],
  [first,{...omitted(1,'empty'),fieldRevision:'x'.repeat(161)}],
  [first,{...omitted(1,'empty'),fieldRevision:'bad\u0001id'}],
  [first,{...omitted(1,'empty'),pixelKey:'x'.repeat(161)}],
  [first,{...omitted(1,'empty'),pixelKey:'bad\u0081id'}],
  [first,{...omitted(1,'empty'),occlusionAdvisory:false}],
  [first,{...omitted(1,'empty'),preBorder:{kind:'invented',reason:'empty'}}],
  [first,{...omitted(1,'empty'),preBorder:{kind:'empty',reason:'x'.repeat(257)}}],
  [first,{...omitted(1,'empty'),preBorder:{kind:'empty',reason:'empty',extra:true}}],
  [first,{...omitted(1,'empty'),quality:{usable:false,reason:'x'.repeat(257),sharpness:1}}],
  [first,{...omitted(1,'empty'),alignment:1.1}],
  [first,{...omitted(1,'empty'),borderSides:[0,0,0,-0.1]}],
 ];
 for(const cells of cases)assert.throws(()=>validate(cells));
 assert.throws(()=>validate([first],2),/응답/);
 const valid=[{...materialized(0,false,'empty'),fieldRevision:'revision/1',occlusionAdvisory:true,preBorder:{kind:'empty',reason:'empty'}},
  {...omitted(1,'empty'),fieldRevision:'revision/2',preBorder:{kind:'empty',reason:'empty'}}];
 assert.equal(validate(valid).omitted,1);
});
