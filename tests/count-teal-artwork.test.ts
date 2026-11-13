import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {packCount} from '../src/features/card-scanner/recognition/count-pattern';

const band=JSON.parse(readFileSync(new URL('./fixtures/count-teal-artwork-band.json',import.meta.url),'utf8'));
const picture=(shift=0)=>{
  const image=new Uint8ClampedArray(140*210*4),bytes=Buffer.from(band.rgba,'base64');
  for(let y=0;y<band.height;y++)for(let x=0;x<band.width;x++)image.set(bytes.subarray((y*band.width+x)*4,(y*band.width+x)*4+4),((band.top+y+shift)*140+x)*4);
  return image;
};

test('teal artwork across the icon aperture, with the paper marker and textured background visible, is an empty counter', () => {
  // 하누마탄 at 5120x2880: the jewels place the field at offset 1, the paper is seen one pixel lower.
  const packed=packCount(picture(),140,1,true);
  assert.equal(packed.hasIcon,false);
  assert.equal(packed.emptyEvidence,'gray-card-marker-and-visible-background');
});

test('the same artwork with cyan in the icon body rows is not an empty counter', () => {
  const image=picture();
  for(let y=147;y<153;y++)for(let x=65;x<73;x++)image.set([60,200,215,255],((y+1)*140+x)*4);
  assert.notEqual(packCount(image,140,1,true).hasIcon,false);
});

test('the paper marker is looked for one pixel either way only', () => {
  // Three pixels away from where the jewels put the field, the marker is not taken.
  const packed=packCount(picture(3),140,1,true);
  assert.notEqual(packed.hasIcon,false);
  assert.equal(packed.emptyEvidence,undefined);
});
