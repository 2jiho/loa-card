import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchCountPattern, countContrastFloor, prepareContrastPattern, packCount, emptyCounterProof, stablePreviewEmptyCandidate } from "../src/features/card-scanner/recognition/count-pattern.ts";
import type { EmptyPreviewEvidence } from "../src/features/card-scanner/recognition/count-pattern.ts";
import { countReliability } from "../src/features/card-scanner/recognition/count-confidence.ts";
import { readFullAwakening, readVisual } from "../src/features/card-scanner/recognition/visual-fields.ts";
import type { Raster, RasterContext } from "../src/features/card-scanner/acquisition/acquisition-raster.ts";

const atlas = JSON.parse(await readFile("public/scanner/counter-patterns.json", "utf8"));
const patterns = atlas.patterns.map(prepareContrastPattern);
const beskalEvidence = JSON.parse(await readFile(
  new URL("./fixtures/beskal-single-frame.json", import.meta.url), "utf8")) as EmptyPreviewEvidence;
// These regression strips share video-1 source data with the atlas builder.
// Every test using them is a regression check, not an independent accuracy evaluation.
const samples = JSON.parse(await readFile("tests/fixtures/counter-samples.json", "utf8"));
const emptyEvidence='gray-card-marker-and-visible-background';
/** Synthetic paper UI and a continuous colored background seam. No gameplay
 * image, card ID, or artwork template is part of the empty-field rule. */
function grayMarkerBackground(offset=0) {
  const image=new Uint8Array(140*210*4);
  const paint=(x:number,y:number,color:number[])=>image.set([...color,255],((y+offset)*140+x)*4);
  for(let y=135;y<173;y++)for(let x=6;x<139;x++) {
    const shade=(x+y)%2?82:115;paint(x,y,[shade,shade,shade]);
  }
  // Two overlapping paper sheets, including full corners and lower edges.
  for(let y=140;y<=153;y++)for(let x=12;x<=28;x++)
    paint(x,y,x===12||x===28||y===140||y===153?[196,196,196]:[136,136,136]);
  for(let y=151;y<=164;y++)for(let x=10;x<=30;x++)
    paint(x,y,x===10||x===30||y===151||y===164?[196,196,196]:[136,136,136]);
  // This faint cyan strand continues from above the fixed icon's top edge.
  for(let y=139;y<146;y++)for(let x=70;x<72;x++)paint(x,y,[100,150,145]);
  return image;
}
function paintBox(image:Uint8Array,x:number,y:number,width:number,height:number,color:number[],offset=0) {
  for(let yy=y;yy<y+height;yy++)for(let xx=x;xx<x+width;xx++)image.set(color,((yy+offset)*140+xx)*4);
}
function pixels(sample: { rgba: string }, offset = 0) {
  const image = new Uint8Array(140 * 210 * 4), strip = Buffer.from(sample.rgba, "base64");
  for (let y = 0; y < 25; y++) image.set(strip.subarray(y * 86 * 4, (y + 1) * 86 * 4), ((141 + offset + y) * 140 + 54) * 4);
  return image;
}
function opaqueTexturedBackground(){
 const image=new Uint8Array(140*210*4);
 for(let y=0;y<210;y++)for(let x=0;x<140;x++){
  const shade=(x+y)%2?24:60;image.set([shade,shade,shade,255],(y*140+x)*4);
 }
 return image;
}

test('full-awakening shortcut rejects visible labelled counters but accepts an icon without digits',()=>{
  let data=new Uint8Array(140*210*4);
  const context={drawImage(){},getImageData(){return {data};}} as unknown as RasterContext;
  const fields={awakening:5,hasIcon:true,offsetY:0,labelPixels:100,blankName:false,hasNameBand:true};
  for(const sample of samples){
    data=pixels(sample);
    const value=readFullAwakening({} as Raster,context,fields,patterns);
    assert.equal(value?.awakening,null,sample.name);
    assert.equal(value?.extraCopies,sample.value,sample.name);
  }
  data=new Uint8Array(140*210*4);
  for(let y=144;y<164;y++)for(let x=60;x<82;x++)data.set([40,190,200,255],(y*140+x)*4);
  assert.deepEqual(readFullAwakening({} as Raster,context,fields,patterns),{awakening:5,extraCopies:0});
});

// This regression fixture shares video-1 source strips with the atlas builder;
// it is not an independent accuracy or generalization benchmark.
test("runtime font atlas reads its labelled regression strips with compensated vertical movement", () => {
  for (const sample of samples) for (const offset of [-2, 0, 3]) {
    const result = matchCountPattern(pixels(sample, offset), patterns, offset);
    assert.equal(result.value, sample.value, `${sample.name}, offset ${offset}`);
  }
});

test("closed-set confidence avoids wrong counts on transformed regression strips", () => {
  const confirmed = new Map<string, number>();
  for (const sample of samples) for (const factor of [.65, .8, 1]) for (const brightness of [-18, 0, 18]) {
    const image = pixels(sample);
    for (let i = 0; i < image.length; i += 4) {
      if (!image[i + 3]) continue;
      for (let c = 0; c < 3; c++) image[i + c] = Math.max(0, Math.min(255, (image[i + c] - 128) * factor + 128 + brightness));
    }
    const pattern = matchCountPattern(image, patterns);
    const reliability = countReliability({ stable: false, borderAlignment: .95,
      awakening: 0, extraCopies: pattern.value, pattern });
    if (reliability !== "unconfirmed") {
      const key = `${factor}/${brightness}`;
      confirmed.set(key, (confirmed.get(key) ?? 0) + 1);
      assert.equal(pattern.value, sample.value, `${sample.name}: contrast ${factor}, brightness ${brightness}`);
    }
  }
  // Observed regression baselines by contrast, separately for each brightness.
  // This fixture shares the atlas source; these are not independent accuracy rates.
  for (const [factor, minimum] of [[.65, 7], [.8, 32], [1, 34]] as const)
    for (const brightness of [-18, 0, 18])
      assert.ok((confirmed.get(`${factor}/${brightness}`) ?? 0) >= minimum,
        `unexpected loss of confirmed regression samples at contrast ${factor}, brightness ${brightness}`);
});

test("awakening limits reject the winning count without substituting a lower candidate", () => {
  for (const sample of samples) {
    const result = matchCountPattern(pixels(sample), patterns, 0, sample.value - 1);
    assert.equal(result.value, null, sample.name);
    assert.equal(result.candidate, sample.value, sample.name);
    assert.equal(result.reason, "각성별 장수 상한 초과");
  }
});

test("missing icon, solid occlusion and incomplete atlases return unknown rather than zero", () => {
  const image = pixels(samples.find((s: {name: string}) => s.name === "여울"));
  assert.equal(matchCountPattern(image, patterns.slice(0, 8)).value, null);
  for (let y = 141; y < 172; y++) image.fill(0, (y * 140 + 56) * 4, (y * 140 + 89) * 4);
  assert.equal(matchCountPattern(image, patterns).value, null);
  const covered = pixels(samples[0]);
  for (let y = 142; y < 167; y++) covered.fill(160, (y * 140 + 89) * 4, (y * 140 + 139) * 4);
  assert.equal(matchCountPattern(covered, patterns).value, null);
  assert.equal(matchCountPattern(new Uint8Array(0), patterns).value, null);
});

test('counter diagnostics distinguish ambiguous evidence from an actually absent icon',()=>{
  const transparent=new Uint8Array(140*210*4);
  assert.equal(packCount(transparent).hasIcon,null,'transparent pixels cannot certify an empty counter');
  const empty=opaqueTexturedBackground();
  assert.equal(packCount(empty).hasIcon,false);
  assert.equal(matchCountPattern(empty,patterns).reason,'추가 카드 아이콘 없음');
  // One visible font-shaped digit can survive while the icon is covered.
  // It must remain unknown and must not be described as positive absence.
  for(let y=145;y<159;y++)for(let x=110;x<117;x++)if(x===110||x===116||y===145||y===158)empty.set([255,255,255,255],(y*140+x)*4);
  assert.equal(packCount(empty).hasIcon,null);
  const ambiguous=matchCountPattern(empty,patterns);
  assert.equal(ambiguous.value,null);assert.equal(ambiguous.reason,'장수 숫자 미검출 또는 불명확');
});

test('whole gray paper UI and visible background can distinguish an artwork seam from a counter remnant',()=>{
  for(const offset of [-4,0,6]) {
    const image=grayMarkerBackground(offset),packed=packCount(image,140,offset);
    assert.equal(packed.hasIcon,false,`offset ${offset}`);
    assert.equal(packed.emptyEvidence,emptyEvidence);
    const pattern=matchCountPattern(image,patterns,offset);
    assert.equal(pattern.value,null,'this evidence does not invent a positive numeric pattern');
    assert.equal(pattern.emptyEvidence,emptyEvidence);
    assert.equal(pattern.reason,'회색 카드 표식 · 빈 장수 배경 확인');
    const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
    const fields={awakening:0,hasIcon:packed.hasIcon,emptyEvidence:packed.emptyEvidence,
      offsetY:offset,labelPixels:100,blankName:false,hasNameBand:false};
    const reading=readVisual({} as Raster,context,fields,patterns);
    assert.equal(reading.extraCopies,0);
    assert.equal(reading.countDiagnostics?.emptyEvidence,emptyEvidence);
    assert.match(reading.countDiagnostics!.reason,/회색 카드 표식 · 빈 장수 배경 확인/);
    const unknownAwakening=readVisual({} as Raster,context,{...fields,awakening:null},patterns);
    assert.equal(unknownAwakening.extraCopies,null,'empty counter evidence cannot fill missing awakening');
    assert.equal(unknownAwakening.countDiagnostics?.emptyEvidence,emptyEvidence);
  }
});

test('partial gray geometry, opaque coverage and visible blue remnants cannot certify an empty counter',()=>{
  for(const offset of [-4,0,6])for(const [kind,mutate] of [
    ['paper top covered',(image:Uint8Array)=>paintBox(image,12,138,18,5,[0,0,0,255],offset)],
    ['paper side covered',(image:Uint8Array)=>paintBox(image,28,142,5,23,[0,0,0,255],offset)],
    ['paper bottom covered',(image:Uint8Array)=>paintBox(image,10,162,22,5,[0,0,0,255],offset)],
    ['transparent paper',(image:Uint8Array)=>paintBox(image,10,140,21,25,[196,196,196,0],offset)],
    ['colored paper',(image:Uint8Array)=>paintBox(image,10,140,21,25,[40,190,200,255],offset)],
    ['flat gray body',(image:Uint8Array)=>paintBox(image,64,150,19,17,[160,160,160,255],offset)],
    ['flat black body',(image:Uint8Array)=>paintBox(image,64,150,19,17,[0,0,0,255],offset)],
    ['flat white body',(image:Uint8Array)=>paintBox(image,64,150,19,17,[255,255,255,255],offset)],
    ['transparent body',(image:Uint8Array)=>paintBox(image,64,150,19,17,[100,100,100,0],offset)],
    ['opaque flat digits',(image:Uint8Array)=>paintBox(image,90,144,48,20,[0,0,0,255],offset)],
    ['partly transparent digits',(image:Uint8Array)=>paintBox(image,90,144,48,20,[64,64,64,254],offset)],
    ['strong top remnant',(image:Uint8Array)=>paintBox(image,70,144,3,1,[40,190,200,255],offset)],
    ['strong lower remnant',(image:Uint8Array)=>paintBox(image,72,151,1,3,[40,190,200,255],offset)],
    ['disconnected seam',(image:Uint8Array)=>paintBox(image,70,141,2,2,[100,100,100,255],offset)],
  ] as const) {
    const image=grayMarkerBackground(offset);mutate(image);
    const packed=packCount(image,140,offset);
    assert.notEqual(packed.hasIcon,false,`${kind}, offset ${offset}`);
    assert.equal(packed.emptyEvidence,undefined,`${kind}, offset ${offset}`);
  }
});

test('gray paper evidence never overrides any of the fifteen positive fonts or surviving labelled digits',()=>{
  for(const offset of [-4,0,6])for(const pattern of patterns) {
    const image=grayMarkerBackground(offset);
    paintBox(image,89,143,50,23,[0,0,0,255],offset);
    for(const p of pattern.foreground) {
      const x=89+p%50,y=143+Math.floor(p/50);
      image.set([255,255,255,255],((y+offset)*140+x)*4);
    }
    const packed=packCount(image,140,offset);
    assert.notEqual(packed.hasIcon,false,`font ${pattern.value}, offset ${offset}`);
    assert.equal(packed.emptyEvidence,undefined);
    // With an intact blue icon the usual positive count still wins exactly.
    paintBox(image,64,143,18,20,[40,190,200,255],offset);
    assert.equal(matchCountPattern(image,patterns,offset).value,pattern.value);
  }
  for(const sample of samples)for(const offset of [-4,0,6]) {
    const image=grayMarkerBackground(offset),strip=pixels(sample,offset);
    for(let y=141+offset;y<166+offset;y++)image.set(strip.subarray((y*140+54)*4,(y*140+140)*4),(y*140+54)*4);
    assert.equal(matchCountPattern(image,patterns,offset).value,sample.value,sample.name);
    paintBox(image,56,141,34,31,[160,160,160,255],offset);
    assert.notEqual(packCount(image,140,offset).hasIcon,false,`${sample.name}: surviving digits`);
    assert.equal(packCount(image,140,offset).emptyEvidence,undefined);
  }
});

test("visible digits without the plus prefix do not produce a positive count", () => {
  const pattern = patterns.find((p: {value: number}) => p.value === 10);
  const image = new Uint8Array(140 * 210 * 4);
  for (let y = 144; y < 164; y++) for (let x = 60; x < 82; x++)
    image.set([40, 190, 200, 255], (y * 140 + x) * 4);
  for (const p of pattern.foreground) {
    if (pattern.plus.includes(p)) continue;
    const y = Math.floor(p / 50) + 144, x = p % 50 + 90;
    image.set([255, 255, 255, 255], (y * 140 + x) * 4);
  }
  assert.equal(matchCountPattern(image, patterns).value, null);
});

test('cyan artwork below the icon with an empty numeric field is zero, including aligned movement', () => {
  for (const offset of [-4, 0, 6]) {
    const image = opaqueTexturedBackground();
    // A lower diagonal cyan streak fills the old color region without the
    // icon upper body. Synthetic pixels avoid publishing a gameplay capture.
    for (let y = 155; y < 172; y++) for (let x = 70; x < 130; x++)
      if (x + y >= 245) image.set([55, 170, 180, 255], ((y + offset) * 140 + x) * 4);
    const packed = packCount(image, 140, offset);
    assert.equal(packed.hasIcon, false);
    const context = { drawImage() {}, getImageData() { return { data: image }; } } as unknown as RasterContext;
    const fields = { awakening: 0, hasIcon: packed.hasIcon, offsetY: offset, labelPixels: 100, blankName: false, hasNameBand: false };
    const reading = readVisual({} as Raster, context, fields, patterns);
    assert.equal(reading.extraCopies, 0);
    assert.equal(countReliability({ ...reading, borderAlignment: .95, stable: false, iconPresent: false }), 'empty-counter');
  }
});

test('cyan artwork cannot certify zero when the counter apertures are transparent', () => {
  for (const offset of [-4, 0, 6]) {
    const image = new Uint8Array(140 * 210 * 4);
    for (let y = 155; y < 172; y++) for (let x = 70; x < 130; x++)
      if (x + y >= 245) image.set([55, 170, 180, 255], ((y + offset) * 140 + x) * 4);
    const packed = packCount(image, 140, offset);
    assert.equal(packed.hasIcon, null);
    assert.equal(matchCountPattern(image, patterns, offset).reason, '장수 숫자 미검출 또는 불명확');
    const context = { drawImage() {}, getImageData() { return { data: image }; } } as unknown as RasterContext;
    const reading = readVisual({} as Raster, context,
      { awakening: 0, hasIcon: packed.hasIcon, offsetY: offset, labelPixels: 100, blankName: false, hasNameBand: false }, patterns);
    assert.equal(reading.extraCopies, null);
    assert.equal(countReliability({ ...reading, borderAlignment: .95, stable: false }), 'unconfirmed');
  }
});

test('partially transparent icon or digit apertures cannot establish an empty counter', () => {
  for (const [x, y] of [[64, 143], [81, 152], [90, 144], [137, 163]]) {
    const image = opaqueTexturedBackground();
    // Preserve the lower cyan artwork that previously bypassed the aperture guard.
    for (let yy = 155; yy < 172; yy++) for (let xx = 70; xx < 130; xx++)
      if (xx + yy >= 245) image.set([55, 170, 180, 255], (yy * 140 + xx) * 4);
    image[(y * 140 + x) * 4 + 3] = 0;
    assert.equal(packCount(image).hasIcon, null, `${x}/${y}`);
  }
});

test('low-contrast opaque icon and counter coverings cannot be accepted as zero',()=>{
  const sample=samples.find((entry:{value:number})=>entry.value===2);
  assert.ok(sample,'requires a positive source strip for the occlusion counterexample');
  for(const offset of [-4,0,6])for(const factor of [.8,1,1.1])for(const brightness of [-10,0,10])
    for(const region of ['icon','both'] as const)for(const base of [[50,50,50],[180,180,180],[30,65,83]]) {
      const image=pixels(sample,offset);
      // A positive source strip is deliberately covered; background pixels are
      // synthetic. This is an occlusion regression, not an independent +2 label.
      for(let y=141;y<172;y++)for(let x=56;x<(region==='icon'?90:139);x++) {
        const add=(x+y)%2?25:0;
        const color=base.map(c=>Math.max(0,Math.min(255,Math.round((c+add-128)*factor+128+brightness))));
        image.set([...color,255],((y+offset)*140+x)*4);
      }
      const packed=packCount(image,140,offset);
      assert.equal(packed.hasIcon,null,`${region}/${base}/${offset}/${factor}/${brightness}`);
      const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
      const fields={awakening:0,hasIcon:packed.hasIcon,offsetY:offset,labelPixels:100,blankName:false,hasNameBand:false};
      const reading=readVisual({} as Raster,context,fields,patterns);
      assert.equal(reading.extraCopies,null);
      assert.equal(countReliability({...reading,borderAlignment:1,stable:true}),'unconfirmed');
    }
});

test('high-contrast textured covering must not be accepted as zero',()=>{
  const sample=samples.find((entry:{value:number})=>entry.value===2);
  assert.ok(sample);
  const image=pixels(sample);
  for(let y=141;y<172;y++)for(let x=56;x<139;x++){
    const shade=(x+y)%2?0:40;
    image.set([shade,shade,shade,255],(y*140+x)*4);
  }
  const packed=packCount(image),context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
  const fields={awakening:0,hasIcon:packed.hasIcon,offsetY:0,labelPixels:100,blankName:false,hasNameBand:false};
  // Known failure: synthetic covering can look like non-flat artwork. Do not
  // promote this TODO to a passing expectation of zero.
  assert.equal(readVisual({} as Raster,context,fields,patterns).extraCopies,null);
});

test('partially covered icon or numbers stay unresolved instead of becoming zero', () => {
  for (const fragment of ['icon', 'digits']) {
    const image = new Uint8Array(140 * 210 * 4);
    for (let y = 155; y < 170; y++) for (let x = 72; x < 106; x++) image.set([40, 190, 200, 255], (y * 140 + x) * 4);
    if (fragment === 'icon') for (let x = 64; x < 68; x++) image.set([40, 190, 200, 255], (146 * 140 + x) * 4);
    else for (let y = 148; y < 156; y++) image.set([255, 255, 255, 255], (y * 140 + 115) * 4);
    assert.equal(packCount(image).hasIcon, true, fragment);
    const context = { drawImage() {}, getImageData() { return { data: image }; } } as unknown as RasterContext;
    const reading = readVisual({} as Raster, context, { awakening: 0, hasIcon: true, offsetY: 0, labelPixels: 100, blankName: false, hasNameBand: false }, patterns);
    assert.equal(reading.extraCopies, null, fragment);
  }
});

test('small muted cyan artwork seams do not invent an icon, while connected or saturated remnants remain unknown',()=>{
  for(const offset of [-4,0,6])for(const factor of [.9,1,1.1])for(const brightness of [-10,0,10]) {
    const image=opaqueTexturedBackground();
    const color=[96,122,118].map(c=>Math.round((c-128)*factor+128+brightness));
    // Two short, separate seams produce more than the old three-pixel gate,
    // but neither has the overlay body's area or a sustained edge.
    for(const [x,y] of [[69,143],[70,143],[71,143],[72,143],[70,144],[71,144],[78,149],[79,149]])
      image.set([...color,255],((y+offset)*140+x)*4);
    assert.equal(packCount(image,140,offset).hasIcon,false,`${offset}/${factor}/${brightness}`);
    const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
    const fields={awakening:0,hasIcon:packCount(image,140,offset).hasIcon,offsetY:offset,labelPixels:100,blankName:false,hasNameBand:false};
    const value=readVisual({} as Raster,context,fields,patterns);
    assert.equal(value.extraCopies,0);
    assert.equal(countReliability({...value,stable:true,borderAlignment:1,iconPresent:false}),'stable-frame');
  }
  for(const fragment of [
    {color:[40,190,200],points:[[69,143],[70,143],[70,144]]},
    {color:[96,122,118],points:[[69,143],[70,144],[71,145]]},
    {color:[96,122,118],points:[[69,146],[70,146],[71,146],[72,146],[73,146]]},
  ]) {
    const image=opaqueTexturedBackground();
    for(const [x,y] of fragment.points)image.set([...fragment.color,255],(y*140+x)*4);
    const packed=packCount(image);
    assert.equal(packed.hasIcon,null,'a partially covered icon cannot become a zero');
    const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
    const fields={awakening:0,hasIcon:packed.hasIcon,offsetY:0,labelPixels:100,blankName:false,hasNameBand:false};
    assert.equal(readVisual({} as Raster,context,fields,patterns).extraCopies,null);
  }
});

test('a weak cyan artwork seam needs a real edge before it can block an empty counter',()=>{
  const seams=[
    [[71,143],[67,144],[68,144],[69,144],[70,144],[71,144]],
    [[69,143],[70,143],[69,144],[70,144],[71,144],[71,145]],
  ];
  for(const points of seams)for(const offset of [-4,0,6])for(const factor of [.9,1,1.1])for(const brightness of [-10,0,10]) {
    const image=opaqueTexturedBackground();
    const paint=(x:number,y:number,color:number[])=>image.set([...color.map(c=>Math.max(0,Math.min(255,
      Math.round((c-128)*factor+128+brightness)))),255],((y+offset)*140+x)*4);
    // The green fabric is continuous across this region. The lightest six
    // pixels happen to meet the cyan mask, forming a seam or a small 2D patch;
    // its neighbors have almost the same luminance, without an icon outline.
    for(let y=140;y<156;y++)for(let x=62;x<84;x++)paint(x,y,[94,115,111]);
    for(const [x,y] of points)paint(x,y,[96,122,118]);
    // The nearly flat icon aperture may be covered; do not assert zero even
    // when the synthetic background was deliberately painted as artwork.
    assert.equal(packCount(image,140,offset).hasIcon,null,`${offset}/${factor}/${brightness}`);
    // The same faint-colored edge over a contrasting surround is retained:
    // missing digits may be covered, so this cannot certify zero copies.
    const edge=new Uint8Array(140*210*4);
    for(const [x,y] of points)
      edge.set([96,122,118,255],((y+offset)*140+x)*4);
    assert.equal(packCount(edge,140,offset).hasIcon,null);
  }
});

test('detached artwork highlights do not turn an absent counter into a failed numeric reading', () => {
  for (const offset of [-4, 0, 6]) for (const brightness of [160, 210, 255]) {
    const image = opaqueTexturedBackground();
    for (let y = 155; y < 170; y++) for (let x = 72; x < 106; x++)
      image.set([40, 190, 200, 255], ((y + offset) * 140 + x) * 4);
    // Multiple highlights, each at most three pixels, scattered across the
    // strip. Total white-pixel counts change with JPEG/resampling thresholds.
    for (const [x, y] of [[116,144],[117,144],[118,144],[101,155],[104,156],[105,156],[90,161]])
      image.set([brightness,brightness,brightness,255], ((y + offset) * 140 + x) * 4);
    assert.equal(packCount(image,140,offset).hasIcon, false);
    // Even a short diagonal stroke must remain a candidate, not become zero.
    for (let i = 0; i < 4; i++) image.set([255,255,255,255], ((148+i+offset)*140+124+i)*4);
    assert.equal(packCount(image,140,offset).hasIcon, true);
  }
});

test('labelled positive counters retain their icon under brightness and contrast variations', () => {
  for (const sample of samples) for (const factor of [.65, .8, 1]) for (const brightness of [-18, 0, 18]) {
    const image = pixels(sample);
    for (let i = 0; i < image.length; i += 4) if (image[i + 3])
      for (let c = 0; c < 3; c++) image[i + c] = Math.max(0, Math.min(255, (image[i + c] - 128) * factor + 128 + brightness));
    assert.equal(packCount(image).hasIcon, true, `${sample.name}: ${factor}/${brightness}`);
  }
});

test('covering only a labelled counter icon never turns remaining digits into zero', () => {
  for(const sample of samples)for(const offset of [-2,0,3]){
    const image=pixels(sample,offset);
    for(let y=141+offset;y<172+offset;y++)for(let x=56;x<90;x++)
      image.set([0,0,0,255],(y*140+x)*4);
    const packed=packCount(image,140,offset);
    assert.notEqual(packed.hasIcon,false,`${sample.name}: ${offset}`);
    const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
    const fields={awakening:0,hasIcon:packed.hasIcon,offsetY:offset,labelPixels:100,blankName:false,hasNameBand:false};
    const reading=readVisual({} as Raster,context,fields,patterns);
    assert.notEqual(reading.extraCopies,0,sample.name);
    const reliable=countReliability({...reading,borderAlignment:.95,stable:false,
      iconPresent:reading.countDiagnostics?.iconPresent,pattern:reading.countDiagnostics?.pattern});
    if(reliable!=='unconfirmed')assert.equal(reading.extraCopies,sample.value,sample.name);
    assert.notEqual(readFullAwakening({} as Raster,context,{...fields,awakening:5},patterns)?.extraCopies,0,sample.name);
  }
});

test('numeric evidence without icon retains dim/bright labelled font while rejecting non-font artwork shapes',()=>{
  for(const sample of samples)for(const factor of [.65,.8,1])for(const brightness of [-18,0,18]){
    const image=pixels(sample);
    for(let i=0;i<image.length;i+=4)if(image[i+3])for(let c=0;c<3;c++)
      image[i+c]=Math.max(0,Math.min(255,(image[i+c]-128)*factor+128+brightness));
    for(let y=141;y<172;y++)for(let x=56;x<90;x++)image.set([0,0,0,255],(y*140+x)*4);
    assert.notEqual(packCount(image).hasIcon,false,`${sample.name}: ${factor}/${brightness}`);
  }
  for(const shape of [{x:2,y:2,w:5,h:12},{x:12,y:0,w:19,h:20},{x:14,y:7,w:5,h:10},{x:10,y:4,w:10,h:12}]){
    const image=opaqueTexturedBackground();
    for(let y=0;y<shape.h;y++)for(let x=0;x<shape.w;x++)
      image.set([210,210,210,255],((144+shape.y+y)*140+90+shape.x+x)*4);
    assert.ok(packCount(image).pixels>0);
    assert.equal(packCount(image).hasIcon,false,JSON.stringify(shape));
  }
});

test('a flat icon aperture with textured empty digits is an empty-counter candidate',()=>{
  const textured=()=>{
    const image=new Uint8Array(140*210*4);
    for(let y=0;y<210;y++)for(let x=0;x<140;x++){
      const shade=((Math.floor(x/4)+Math.floor(y/4))%2)?24:80;
      image.set([shade,shade,shade,255],(y*140+x)*4);
    }
    return image;
  };
  const image=textured();
  for(let y=143;y<153;y++)for(let x=64;x<82;x++)image.set([80,80,80,255],(y*140+x)*4);
  const packed=packCount(image,140,0,true);
  assert.equal(packed.hasIcon,null,'single flat icon aperture stays unknown');
  assert.equal(stablePreviewEmptyCandidate(packed),true);
  const covered=textured();
  for(let y=143;y<164;y++)for(let x=64;x<139;x++)covered.set([80,80,80,255],(y*140+x)*4);
  assert.equal(stablePreviewEmptyCandidate(packCount(covered,140,0,true)),false,'flat digits aperture is not empty artwork');
  const positive=textured();
  for(let y=143;y<153;y++)for(let x=64;x<82;x++)positive.set([40,190,200,255],(y*140+x)*4);
  assert.equal(stablePreviewEmptyCandidate(packCount(positive,140,0,true)),false,'a positive icon vetoes zero');
});

test('one observation of a clean empty counter is enough for zero; more only firm it up',()=>{
  // Same strict evidence for every observation count (a beskal crop: flat icon
  // aperture, textured digits aperture, no icon color or stroke).
  assert.equal(stablePreviewEmptyCandidate(beskalEvidence),true);
  assert.equal(emptyCounterProof(beskalEvidence,1,false),'single-observation','a single live/video observation counts');
  assert.equal(emptyCounterProof(beskalEvidence,2,false),'single-observation');
  assert.equal(emptyCounterProof(beskalEvidence,3,false),'repeated-observations');
  assert.equal(emptyCounterProof(beskalEvidence,7,false),'repeated-observations');
  assert.equal(emptyCounterProof(beskalEvidence,1,true),'still-image','a single still image keeps its own proof');
  assert.equal(emptyCounterProof(beskalEvidence,2,true),'single-observation');
  // Nothing observed proves nothing.
  assert.equal(emptyCounterProof(beskalEvidence,0,false),null);
  assert.equal(emptyCounterProof(beskalEvidence,-1,false),null);
  assert.equal(emptyCounterProof(beskalEvidence,Number.NaN,false),null);
  // The evidence itself never loosens: a flat digits aperture, a positive icon or
  // an explicit empty counter (which has its own path) are not this proof.
  const covered={...beskalEvidence,diagnostic:{...beskalEvidence.diagnostic!,digitsFlat:true}};
  assert.equal(stablePreviewEmptyCandidate(covered),false,'flat digits aperture remains unknown');
  assert.equal(emptyCounterProof(covered,1,false),null);
  assert.equal(emptyCounterProof(covered,9,true),null);
  const positive={...beskalEvidence,hasIcon:true};
  assert.equal(stablePreviewEmptyCandidate(positive),false,'positive icon cannot become zero');
  assert.equal(emptyCounterProof(positive,1,false),null);
  const numeric={...beskalEvidence,diagnostic:{...beskalEvidence.diagnostic!,numericEvidence:true}};
  assert.equal(emptyCounterProof(numeric,5,false),null,'a numeric stroke vetoes zero');
  const explicitEmpty={...beskalEvidence,hasIcon:false};
  assert.equal(emptyCounterProof(explicitEmpty,1,true),null,'explicit empty uses the existing path');
});

test('only resampled crops get the lower contrast floor', () => {
  assert.equal(countContrastFloor(140),.30);   // 2560x1440 full screen: read at its own size
  assert.equal(countContrastFloor(137),.22);   // a 2560x1440 window drawn at 0.98
  assert.equal(countContrastFloor(105),.22);   // 1920x1080
  assert.equal(countContrastFloor(undefined),.30);
  assert.equal(countContrastFloor(0),.30);
});
