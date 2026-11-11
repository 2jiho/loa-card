import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {COUNT_UNEXPLAINED_TRAILING_GLYPH,matchCountPattern,prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import {readFullAwakening,readVisual} from '../src/features/card-scanner/recognition/visual-fields';
import {corroboratedCount} from '../src/features/card-scanner/recognition/count-corroboration';
import {currentCountReliability} from '../src/features/card-scanner/recognition/count-confidence';
import type {Raster,RasterContext} from '../src/features/card-scanner/acquisition/acquisition-raster';

const atlas=JSON.parse(readFileSync('public/scanner/counter-patterns.json','utf8'));
const patterns=atlas.patterns.map(prepareContrastPattern);
/** Synthetic bitmap glyphs, not independent game screenshots or accuracy data. */
function card(value:number,offset=0,reference?:{value:number;foreground:number[]}) {
 const p=reference??patterns.find((pattern:{value:number})=>pattern.value===value);assert.ok(p);
 const image=new Uint8ClampedArray(140*210*4);
 for(let i=3;i<image.length;i+=4)image[i]=255;
 for(let y=143;y<153;y++)for(let x=64;x<82;x++)image.set([30,200,210,255],((y+offset)*140+x)*4);
 for(const pixel of p.foreground){const x=89+pixel%50,y=143+Math.floor(pixel/50)+offset;
  image.set([255,255,255,255],(y*140+x)*4);}
 return image;
}
function paint(image:Uint8ClampedArray,offset:number,x:number,y:number,width:number,height:number,brightness:number) {
 for(let dy=0;dy<height;dy++)for(let dx=0;dx<width;dx++)image.set([brightness,brightness,brightness,255],((y+dy+offset)*140+x+dx)*4);
}
const context=(image:Uint8ClampedArray)=>({drawImage(){},getImageData(){return{data:image};}} as unknown as RasterContext);

test('all 1–15 synthetic template glyphs remain readable and all winning values respect awakening maxima',()=>{
 for(let value=1;value<=15;value++)for(const offset of [-4,0,2,6]){
  const image=card(value,offset),normal=matchCountPattern(image,patterns,offset);
  assert.equal(normal.value,value,`count ${value}, offset ${offset}`);
  const impossible=matchCountPattern(image,patterns,offset,value-1);
  assert.equal(impossible.value,null);assert.equal(impossible.candidate,value);
  assert.equal(impossible.reason,'각성별 장수 상한 초과');
 }
});

test('every atlas variant retains its value on synthetic inputs',()=>{
 for(const pattern of patterns)for(const offset of [-2,0,2]){
  const result=matchCountPattern(card(pattern.value,offset,pattern),patterns,offset);
  assert.equal(result.value,pattern.value,`variant ${pattern.value}, offset ${offset}`);
 }
});

test('strong unexplained trailing glyph vetoes every single-digit winner without inventing another count',()=>{
 for(let value=1;value<=9;value++)for(const offset of [-4,0,2,6]){
  const image=card(value,offset);
  // Independent second vertical glyph, outside every single-digit candidate.
  paint(image,offset,129,147,2,13,255);
  const reading=matchCountPattern(image,patterns,offset);
  assert.equal(reading.candidate,value);assert.equal(reading.value,null);
  assert.equal(reading.reason,COUNT_UNEXPLAINED_TRAILING_GLYPH);
  assert.equal(matchCountPattern(image,patterns,offset,15,false).reason,COUNT_UNEXPLAINED_TRAILING_GLYPH);
 }
});

test('small highlights and low-contrast background details do not by themselves veto a single digit',()=>{
 for(let value=1;value<=9;value++)for(const kind of ['speckle','short','dim'] as const){
  const image=card(value);
  if(kind==='speckle')for(const [x,y] of [[129,147],[130,150],[128,154],[131,157]])paint(image,0,x,y,1,1,255);
  if(kind==='short')paint(image,0,129,148,2,5,255);
  if(kind==='dim')paint(image,0,129,147,2,13,110);
  assert.equal(matchCountPattern(image,patterns).value,value,`${value}/${kind}`);
 }
});

test('a trailing-glyph conflict cannot fall through five-awakening zero shortcut',()=>{
 const image=card(1,2);paint(image,2,129,147,2,13,255);
 const fields={awakening:5,hasIcon:true,offsetY:2,labelPixels:100,blankName:false,hasNameBand:false};
 const result=readFullAwakening({} as Raster,context(image),fields,patterns);
 assert.equal(result?.awakening,null);assert.equal(result?.extraCopies,null);
 assert.equal(result?.countDiagnostics?.pattern?.reason,COUNT_UNEXPLAINED_TRAILING_GLYPH);
 const ordinary=readVisual({} as Raster,context(image),{...fields,awakening:0},patterns);
 assert.equal(ordinary.extraCopies,null);assert.equal(ordinary.countDiagnostics?.pattern?.candidate,1);
});

test('low-gap partial single digit with a strong trailing glyph cannot be certified by numeric OCR',()=>{
 // Blend atlas variants into a genuinely low-gap pattern: no prefilled fake
 // CountPatternReading. The separate high-contrast stroke is a possible
 // second digit, not grounds to claim a particular two-digit result.
 const image=card(1),one=patterns.find((p:{value:number})=>p.value===1)!;
 const two=patterns.find((p:{value:number})=>p.value===2)!;
 for(const pixel of one.foreground){const x=89+pixel%50,y=143+Math.floor(pixel/50);
  image.set([160,160,160,255],(y*140+x)*4);}
 for(const pixel of two.foreground){const x=89+pixel%50,y=143+Math.floor(pixel/50),i=(y*140+x)*4,gray=Math.max(image[i],150);
  image.set([gray,gray,gray,255],i);}
 paint(image,0,129,147,2,13,255);
 const pattern=matchCountPattern(image,patterns);
 assert.equal(pattern.candidate,1);assert.equal(pattern.value,null);
 assert.ok(pattern.score>=.4);assert.ok(pattern.gap>=0&&pattern.gap<.018);
 assert.equal(pattern.reason,COUNT_UNEXPLAINED_TRAILING_GLYPH);
 assert.equal(corroboratedCount({pattern,awakening:0,value:1,iconPresent:true,ocrConfirmedValue:1,ocrAgreed:true}),false);
 assert.equal(currentCountReliability({stable:true,borderAlignment:1,awakening:0,extraCopies:1,pattern,
  iconPresent:true,ocrConfirmedValue:1,patternOcrAgreed:true}),'unconfirmed');
 const overCapacity=matchCountPattern(image,patterns,0,0);
 assert.equal(overCapacity.value,null);assert.equal(overCapacity.candidate,1);
 assert.equal(overCapacity.reason,'각성별 장수 상한 초과');
 const weak=image.slice();
 for(const pixel of new Set([...one.foreground,...two.foreground])){
  const x=89+pixel%50,y=143+Math.floor(pixel/50),i=(y*140+x)*4,gray=Math.round(weak[i]*.5);weak.set([gray,gray,gray,255],i);}
 const lowContrast=matchCountPattern(weak,patterns);
 assert.equal(lowContrast.value,null);assert.ok(lowContrast.score<.30);
 assert.equal(lowContrast.reason,'숫자 획과 외곽선 대비 부족');
});

test('bright trailing glyph joined to wider artwork remains uncertain while background alone is not a veto',()=>{
 for(const offset of [-4,0,2,6])for(const brightness of [145,150,155]){
  const image=card(1,offset);
  // Below the second threshold this region merges into a >10px component.
  // At the brighter cutoff only the digit-shaped foreground remains.
  paint(image,offset,121,146,19,16,brightness);
  const background=matchCountPattern(image,patterns,offset);
  assert.equal(background.value,1,`background ${brightness}/${offset}`);
  const noise=image.slice();paint(noise,offset,129,149,2,4,255);
  assert.equal(matchCountPattern(noise,patterns,offset).value,1,`small highlight ${brightness}/${offset}`);
  paint(image,offset,129,147,2,13,255);
  const reading=matchCountPattern(image,patterns,offset);
  assert.equal(reading.value,null);assert.equal(reading.candidate,1);
  assert.equal(reading.reason,COUNT_UNEXPLAINED_TRAILING_GLYPH);
 }
});

test('a strong single-digit candidate plus two OCR readings can explain a trailing artwork stroke',()=>{
 const strong={value:null,candidate:1,score:.497,gap:.13,reason:COUNT_UNEXPLAINED_TRAILING_GLYPH} as const;
 assert.equal(corroboratedCount({pattern:strong,awakening:0,value:1,iconPresent:true,ocrConfirmedValue:1,ocrAgreed:true}),true);
 assert.equal(currentCountReliability({stable:false,borderAlignment:1,awakening:0,extraCopies:1,pattern:strong,
  iconPresent:true,ocrConfirmedValue:1,patternOcrAgreed:true}),'pattern-ocr');
 assert.equal(currentCountReliability({stable:false,borderAlignment:1,awakening:0,extraCopies:1,pattern:strong,
  iconPresent:true,ocrConfirmedValue:1,patternOcrAgreed:false}),'unconfirmed');
 const weak={...strong,gap:.02};
 assert.equal(currentCountReliability({stable:false,borderAlignment:1,awakening:0,extraCopies:1,pattern:weak,
  iconPresent:true,ocrConfirmedValue:1,patternOcrAgreed:true}),'unconfirmed');
});
