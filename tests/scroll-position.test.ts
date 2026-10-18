import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { readScrollPosition, readScrollGeometry } from "../src/features/card-scanner/scroll-position.ts";

test("actual scrollbar captures distinguish the first page and later pages without treating empty slots as the end", async () => {
  const samples = JSON.parse(await readFile("tests/fixtures/scrollbar-samples.json", "utf8"));
  for (const sample of samples) {
    const rgba = inflateSync(Buffer.from(sample.rgbaZlib, "base64"));
    const position = readScrollPosition(rgba, sample.width, sample.height);
    assert.notEqual(position, null);
    const geometry=readScrollGeometry(rgba,sample.width,sample.height)!;
    assert.equal(geometry.position,position);
    assert.ok(geometry.pageSpan>.07&&geometry.pageSpan<.09,'actual four-row viewport span');
    if (sample.index === 0) assert.ok(position! <= .01);
    if (sample.index === 5) assert.ok(position! > .38 && position! < .40);
    if (sample.index === 9) assert.ok(position! > .69 && position! < .71);
    assert.equal(readScrollPosition(new Uint8Array(rgba.length), sample.width, sample.height), null);
  }
});

test('actual gray video thumb uses structure while isolated strokes stay unknown',async()=>{
  const sample=JSON.parse(await readFile('tests/fixtures/scrollbar-gray-sample.json','utf8'));
  const rgba=inflateSync(Buffer.from(sample.rgbaZlib,'base64'));
  const geometry=readScrollGeometry(rgba,sample.width,sample.height)!;
  const thumb=sample.expectedBottom-sample.expectedTop,travel=sample.height-46-thumb;
  assert.ok(geometry,'moving thumb is gray, not a missing screen');
  assert.equal(geometry.position,(sample.expectedTop-20)/travel);
  assert.equal(geometry.pageSpan,thumb/travel);
  const strokes=rgba.slice();
  for(let y=sample.expectedTop+4;y<sample.expectedBottom-4;y++)for(let x=0;x<sample.width;x++)
    strokes.set([0,0,0,255],(y*sample.width+x)*4);
  assert.equal(readScrollGeometry(strokes,sample.width,sample.height),null,'unfilled strokes are not a thumb');
  assert.equal(readScrollGeometry(new Uint8Array(10),16,942),null);
});

function syntheticThumb(top:number,bottom:number) {
 const pixels=new Uint8Array(16*942*4);
 for(let y=0;y<942;y++)for(let x=0;x<16;x++) {
   const level=x>=2&&x<=10?(y===top||y===bottom?140:y>top&&y<bottom?65:15):15;
   pixels.set([level,level,level,255],(y*16+x)*4);
 }
 return pixels;
}
test('bottom thumb edge is distinct from the lower arrow and reaches the end',()=>{
 const pixels=syntheticThumb(852,916);
 // A lower arrow stroke must not become a third thumb edge.
 for(let x=0;x<16;x++)pixels.set([180,160,80,255],(918*16+x)*4);
 assert.deepEqual(readScrollGeometry(pixels,16,942),{position:1,pageSpan:64/832});
});
test('a partially covered thumb uses agreeing columns, while a cursor alone is unknown',()=>{
 const pixels=syntheticThumb(281,345);
 for(let y=270;y<315;y++)for(let x=6;x<16;x++)pixels.set([250,30,130,255],(y*16+x)*4);
 const result=readScrollGeometry(pixels,16,942);
 assert.ok(result);assert.ok(Math.abs(result.position-261/832)<.003);
 const cursor=syntheticThumb(-100,-50);
 for(let y=270;y<315;y++)for(let x=6;x<16;x++)cursor.set([250,30,130,255],(y*16+x)*4);
 assert.equal(readScrollGeometry(cursor,16,942),null);
});
