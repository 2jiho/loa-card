import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyScannerInput, normalizeScannerInputFrame, parseScannerInputProvenance, type ScannerInputFrame } from '../src/features/card-scanner/scanner-input-frame';

const element = {} as HTMLCanvasElement;
const metadata = { frameId: 12, captureTime: 1.25, phase: 'recovery', pixelHash: 'a'.repeat(64) };

test('input provenance preserves source ID, capture time, phase and verified pixel hash', () => {
  assert.deepEqual(parseScannerInputProvenance(metadata), { ...metadata, phaseInferred: false });
  const input = { ...metadata, phase: 'input' };
  assert.deepEqual(parseScannerInputProvenance(input), { ...input, phaseInferred: false });
  assert.equal(Object.hasOwn(metadata, 'phaseInferred'), false, 'normalization must not change imported metadata');
});

test('legacy phase omission is an explicit inference instead of invented recorded evidence', () => {
  const { phase: _phase, ...legacy } = metadata;
  const inferred = parseScannerInputProvenance(legacy);
  assert.equal(inferred.phase, 'input'); assert.equal(inferred.phaseInferred, true);
  assert.deepEqual(parseScannerInputProvenance(inferred), inferred, 'inference survives another normalization pass');
  assert.throws(() => parseScannerInputProvenance({ ...legacy, phaseInferred: false }), /missing phase/);
  assert.throws(() => parseScannerInputProvenance({ ...metadata, phaseInferred: true }), /legacy input fallback/);
});

test('malformed provenance is rejected without coercing unknown fields to zero', () => {
  for (const input of [null, [], 'metadata', {},
    ...[0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(frameId => ({ ...metadata, frameId })),
    ...[-1, NaN, Infinity, null, '0'].map(captureTime => ({ ...metadata, captureTime })),
    ...['', 'x'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), null].map(pixelHash => ({ ...metadata, pixelHash })),
    ...['future', '', null, 0].map(phase => ({ ...metadata, phase })),
    { ...metadata, phaseInferred: 'false' },
  ]) assert.throws(() => parseScannerInputProvenance(input), /Invalid scanner input/);
});

test('common envelope keeps pixel ownership and permits nonchronological recovery capture times', () => {
  const later = { element, time: 7, percent: 40, provenance: parseScannerInputProvenance({ ...metadata, frameId: 1, captureTime: 7, phase: 'input' }) };
  const older = { element, time: 1.25, percent: 90, provenance: parseScannerInputProvenance(metadata) };
  const source = normalizeScannerInputFrame(later);
  const recovery = normalizeScannerInputFrame(older);
  assert.equal(source.element, element); assert.equal(recovery.element, element);
  assert.equal(source.time, 7); assert.equal(recovery.time, 1.25);
  assert.equal(recovery.provenance?.frameId, 12);
  assert.equal(recovery.provenance?.phase, 'recovery');
  const ordinary: ScannerInputFrame<HTMLCanvasElement> = { element, time: 0, percent: 0, image: '' };
  assert.equal(normalizeScannerInputFrame(ordinary), ordinary);
});

test('envelope rejects changed capture time and invalid progress without modifying the payload', () => {
  const frame = { element, time: 1.25, percent: 100, provenance: parseScannerInputProvenance(metadata) };
  assert.throws(() => normalizeScannerInputFrame({ ...frame, time: 10 }), /captureTime must equal source time/);
  for (const percent of [-1, 101, NaN, Infinity]) {
    assert.throws(() => normalizeScannerInputFrame({ ...frame, percent }), /percent/);
  }
  for (const time of [-1, NaN, Infinity]) assert.throws(() => normalizeScannerInputFrame({ ...frame, time }), /time/);
  assert.throws(() => normalizeScannerInputFrame({ ...frame, image: 2 as unknown as string }), /image/);
  assert.throws(() => normalizeScannerInputFrame({ ...frame, element: null as unknown as HTMLCanvasElement }), /element/);
  assert.equal(frame.time, 1.25); assert.deepEqual(element, {});
});

type PixelSource={width:number;height:number;pixels:readonly number[];close():void};
function compositor(initial:readonly number[]) {
  const pixels=new Uint8ClampedArray(initial),draws:{source:CanvasImageSource;args:number[]}[]=[];
  const context:Pick<CanvasRenderingContext2D,'globalCompositeOperation'|'drawImage'>={
    globalCompositeOperation:'source-over',
    drawImage(source:CanvasImageSource,...args:number[]) {
      draws.push({source,args});
      const input=source as unknown as PixelSource;
      assert.equal(input.pixels.length,pixels.length);
      for(let offset=0;offset<pixels.length;offset+=4){
        if(context.globalCompositeOperation==='copy'){
          pixels.set(input.pixels.slice(offset,offset+4),offset);continue;
        }
        assert.equal(context.globalCompositeOperation,'source-over');
        const sourceAlpha=input.pixels[offset+3]/255,targetAlpha=pixels[offset+3]/255;
        const alpha=sourceAlpha+targetAlpha*(1-sourceAlpha);
        for(let channel=0;channel<3;channel++)pixels[offset+channel]=alpha?
          Math.round((input.pixels[offset+channel]*sourceAlpha+pixels[offset+channel]*targetAlpha*(1-sourceAlpha))/alpha):0;
        pixels[offset+3]=Math.round(alpha*255);
      }
    },
  };
  return {context,pixels,draws};
}

test('a new transparent or translucent input replaces opaque history without retaining its pixels',()=>{
  const previous=[240,30,10,255,20,220,80,255],next=Object.freeze([0,0,0,0,100,40,200,128]);
  let closed=0;
  const source:PixelSource={width:2,height:1,pixels:next,close(){closed++;}};
  const image=source as unknown as CanvasImageSource;
  const unprotected=compositor(previous);unprotected.context.drawImage(image,0,0);
  assert.notDeepEqual([...unprotected.pixels],next,'the fixture detects source-over blending with an older frame');
  assert.deepEqual([...unprotected.pixels.slice(0,4)],previous.slice(0,4),'a transparent source leaves the old opaque pixel under source-over');
  const copied=compositor(previous);copyScannerInput(copied.context,image);
  assert.deepEqual([...copied.pixels],next);
  assert.deepEqual(copied.draws,[{source:image,args:[0,0]}],'the source is drawn unscaled at its original origin');
  assert.equal(copied.context.globalCompositeOperation,'copy');
  assert.equal(closed,0);assert.equal(source.pixels,next);assert.equal(source.width,2);assert.equal(source.height,1);
});

test('each frame replaces history even if another consumer changed the composition mode',()=>{
  const copied=compositor([10,20,30,255]);
  const first:PixelSource={width:1,height:1,pixels:[90,80,70,255],close(){assert.fail('borrowed input must stay open');}};
  const second:PixelSource={width:1,height:1,pixels:[15,35,55,128],close(){assert.fail('borrowed input must stay open');}};
  copyScannerInput(copied.context,first as unknown as CanvasImageSource);
  copied.context.globalCompositeOperation='source-over';
  copyScannerInput(copied.context,second as unknown as CanvasImageSource);
  assert.deepEqual([...copied.pixels],second.pixels);
  assert.equal(copied.draws.length,2);assert.equal(copied.context.globalCompositeOperation,'copy');
});
