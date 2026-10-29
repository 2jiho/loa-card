import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDetector} from '../src/features/card-scanner/detector';
import type {DetectorPlatform} from '../src/features/card-scanner/detector';
import {recordDetectorStage,type DetectorProfile} from '../src/features/card-scanner/detector-profile';

/** Synthetic CV scores isolate the coarse/native acceptance contract. Real
 * translated screenshot checks separately exercise the OpenCV computation. */
function platform(nativeScore: number, growthScore = .95, fixedGeometry=false, strictGeometry=false) {
  class Mat {
    cols=0; rows=0; score=0; x=0; y=0;
    delete() {}
  }
  let nativeMatches=0,growthMatches=0,pixelChange=0,refinementPixelChange=0;
  const cv={
    Mat, Size: class { width:number; height:number; constructor(w:number,h:number){this.width=w;this.height=h;} },
    COLOR_RGBA2GRAY:0,INTER_AREA:0,TM_CCOEFF_NORMED:0,
    cvtColor(a:Mat,b:Mat){b.cols=a.cols;b.rows=a.rows;},
    resize(_a:Mat,b:Mat,size:{width:number;height:number}){b.cols=size.width;b.rows=size.height;},
    matFromImageData(p:{width:number;height:number}){const m=new Mat();m.cols=p.width;m.rows=p.height;return m;},
    matchTemplate(a:Mat,t:Mat,r:Mat){
      if(a.cols===256&&a.rows===48){growthMatches++;r.score=growthScore;r.x=r.y=0;}
      else if(a.cols>500){r.score=t.cols===64?.66:.3;r.x=384;r.y=128;}
      else{nativeMatches++;r.score=fixedGeometry&&t.cols!==100?.3:nativeScore;r.x=r.y=fixedGeometry&&a.cols===164?32:16;}
    },
    minMaxLoc(r:Mat){return {maxVal:r.score,maxLoc:{x:r.x,y:r.y}};},
  };
  const canvas=()=>{
    const c={width:1,height:1,getContext:()=>({drawImage(){},getImageData(_x:number,_y:number,w:number,h:number){
      const data=new Uint8ClampedArray(w*h*4);
      for(let i=0;i<data.length;i+=4){data[i]=220;data[i+1]=150;data[i+2]=30;data[i+3]=255;}
      data[3]-=pixelChange;
      if(w!==164&&w!==256&&w<500)data[7]-=refinementPixelChange;
      return {width:w,height:h,data};
    }})};
    if(strictGeometry)for(const key of ['width','height'] as const){let size=c[key];Object.defineProperty(c,key,{get:()=>size,set(value:number){
      if(!Number.isSafeInteger(value)||value<0||value>0xffffffff)throw TypeError(`Failed to set ${key}: outside unsigned long`);size=value;
    }});}
    return c;
  };
  return {changePixel(){pixelChange++;},changeRefinementPixel(){refinementPixelChange++;},get nativeMatches(){return nativeMatches;},get growthMatches(){return growthMatches;}, value:{cv,canvas,anchor:async(name:string)=>{
    const m=new Mat();m.cols=name==='header-anchor.png'?100:256;m.rows=name==='header-anchor.png'?20:48;return m;
  }} as unknown as DetectorPlatform};
}

interface PixelSource {width:number;height:number;data:Uint8ClampedArray}
/** Retains backing pixels and context state until a dimension assignment, like
 * Canvas2D. The two alpha cases used below (0/255) make copy vs source-over
 * observable from real RGBA bytes rather than a drawImage call counter. */
function pixelPlatform() {
  const fake=platform(.96,.95,true);
  const canvases:{width:number;height:number;resets:number;draws:{mode:string;width:number;height:number}[];pixels:()=>Uint8ClampedArray}[]=[];
  const canvas=()=>{
    let width=1,height=1,data=new Uint8ClampedArray(4);
    const draws:{mode:string;width:number;height:number}[]=[];
    const c={
      get width(){return width;},set width(value:number){width=value;reset();},
      get height(){return height;},set height(value:number){height=value;reset();},
      resets:0,draws,pixels:()=>data.slice(),getContext:()=>context,
    };
    const reset=()=>{c.resets++;data=new Uint8ClampedArray(width*height*4);context.globalCompositeOperation='source-over';};
    const context={
      globalCompositeOperation:'source-over',
      drawImage(source:PixelSource,sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number){
        draws.push({mode:this.globalCompositeOperation,width,height});
        assert.deepEqual([dx,dy,dw,dh],[0,0,width,height],'detector replaces the full destination');
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const from=(Math.min(source.height-1,Math.floor(sy+(y+.5)*sh/dh))*source.width+Math.min(source.width-1,Math.floor(sx+(x+.5)*sw/dw)))*4;
          const to=(y*width+x)*4;
          assert.ok(source.data[from+3]===0||source.data[from+3]===255,'this mock supports only opaque and transparent inputs');
          if(this.globalCompositeOperation==='copy'||source.data[from+3]===255)
            data.set(source.data.subarray(from,from+4),to);
        }
      },
      getImageData(x:number,y:number,w:number,h:number){
        assert.deepEqual([x,y,w,h],[0,0,width,height]);
        return {width,height,data:data.slice()};
      },
    };
    canvases.push(c);return c;
  };
  const source=(opaque=true):PixelSource=>{
    const data=new Uint8ClampedArray(2000*1600*4);
    if(opaque)for(let i=0;i<data.length;i+=4)data.set([220,150,30,255],i);
    return {width:2000,height:1600,data};
  };
  return {fake,canvases,source,value:{...fake.value,canvas} as unknown as DetectorPlatform};
}

test('a phase-weakened coarse proposal must reach native verification',async()=>{
  const fake=platform(.96),detector=await createDetector(fake.value);
  try{const layout=detector.detect({width:2000,height:1600} as HTMLCanvasElement);
    assert.ok(fake.nativeMatches>0);assert.ok(layout);assert.equal(layout.score,.96);
  }finally{detector.dispose();}
});

test('tracked large-source coordinates never resize a tiny source canvas with a negative dimension',async()=>{
 const fake=platform(.96,.95,true,true),events:Record<string,unknown>[]=[],detector=await createDetector(fake.value,true,event=>events.push(event));
 try{
  const large={width:2000,height:1600} as HTMLCanvasElement;
  assert.ok(detector.detect(large));assert.ok(detector.detect(large));
  assert.equal(detector.detect({width:8,height:8} as HTMLCanvasElement),null);
  assert.equal(events.filter(event=>event.stage==='coarse').at(-1)?.tracked,false);
  assert.ok(detector.detect(large));assert.equal(events.filter(event=>event.stage==='coarse').at(-1)?.tracked,false);
 }finally{detector.dispose();}
});

test('invalid media dimensions clear tracking and return null before raster allocation',async()=>{
 const fake=platform(.96,.95,true,true),events:Record<string,unknown>[]=[],detector=await createDetector(fake.value,true,event=>events.push(event));
 try{
  const large={width:2000,height:1600} as HTMLCanvasElement;assert.ok(detector.detect(large));
  for(const [width,height]of [[0,8],[8,0],[-1,8],[NaN,8],[8,Infinity],[2.5,8]])
    assert.equal(detector.detect({width,height} as HTMLCanvasElement),null);
  assert.ok(detector.detect(large));assert.equal(events.filter(event=>event.stage==='coarse').at(-1)?.tracked,false);
 }finally{detector.dispose();}
});

test('invalid matcher locations cannot become refinement crops or retained tracking geometry',async()=>{
 for(const x of [NaN,Infinity,-1,10_000]){
  const fake=platform(.96,.95,true,true),cv=fake.value.cv as unknown as {minMaxLoc:(value:unknown)=>unknown};
  cv.minMaxLoc=()=>({maxVal:.96,maxLoc:{x,y:200}});
  const detector=await createDetector(fake.value,true);
  try{assert.equal(detector.detect({width:2000,height:1600} as HTMLCanvasElement),null);}
  finally{detector.dispose();}
 }
});

test('native refinement is reused only for identical pixels and geometry, including alpha',async()=>{
  const fake=platform(.84,.95,true),events:Record<string,unknown>[]=[],detector=await createDetector(fake.value,true,event=>events.push(event));
  try{
    const input={width:2000,height:1600} as HTMLCanvasElement;
    const first=detector.detect(input);assert.ok(first);
    const before=fake.nativeMatches;
    assert.deepEqual(detector.detect(input),first);
    assert.equal(fake.nativeMatches-before,1,'tracked match still runs, 17-scale refinement is reused');
    const warmed=fake.nativeMatches;
    assert.deepEqual(detector.detect(input),first);
    assert.equal(fake.nativeMatches,warmed,'an identical weak tracked proposal and independently identical refinement both reuse their own evidence');
    fake.changePixel();const changed=fake.nativeMatches;
    assert.deepEqual(detector.detect(input),first);
    assert.equal(fake.nativeMatches-changed,18,'one changed alpha byte invalidates native reuse');
    detector.detect({width:2100,height:1600} as HTMLCanvasElement);
    assert.equal(events.filter(event=>event.stage==='coarse').at(-1)?.tracked,false,'new frame geometry restarts the full search');
  }finally{detector.dispose();}
});
test('accepting a coarse proposal does not lower native or Growth thresholds',async()=>{
  for(const [native,growth] of [[.74,.95],[.96,.79]]){
    const fake=platform(native,growth),detector=await createDetector(fake.value);
    try{assert.equal(detector.detect({width:2000,height:1600} as HTMLCanvasElement),null);assert.ok(fake.nativeMatches>0);}
    finally{detector.dispose();}
  }
});

test('cached weak tracked proposal cannot bypass changed native refinement pixels',async()=>{
  const fake=platform(.84,.95,true),detector=await createDetector(fake.value,true);
  try {
    const input={width:2000,height:1600} as HTMLCanvasElement;
    const first=detector.detect(input);assert.ok(first);
    detector.detect(input);detector.detect(input);
    const before=fake.nativeMatches;
    fake.changeRefinementPixel();
    assert.deepEqual(detector.detect(input),first);
    assert.equal(fake.nativeMatches-before,17,'unchanged proposal skips one match, but changed native pixels require every refinement scale');
  } finally {detector.dispose();}
});

test('same-size tracked and Growth canvases retain backing stores while all detector draws replace pixels',async()=>{
  const fake=pixelPlatform(),detector=await createDetector(fake.value,true);
  try{
    const input=fake.source();assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    const [growth,main]=fake.canvases;
    assert.deepEqual(main.draws.map(({width,height})=>[width,height]),[[1280,1024],[141,54]],'initial search exercises coarse and native destinations');
    assert.equal(growth.resets,2);assert.equal(main.resets,4);
    assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    assert.equal(growth.resets,2,'the fixed Growth canvas is sized only once');
    assert.equal(main.resets,6,'tracked crop changes the main canvas geometry once');
    const resets=fake.canvases.map(canvas=>canvas.resets);
    assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    assert.deepEqual(fake.canvases.map(canvas=>canvas.resets),resets,'same-size frame performs no width or height assignment');
    for(const canvas of fake.canvases)assert.ok(canvas.draws.every(draw=>draw.mode==='copy'),'coarse, native, tracked, and Growth draws explicitly replace all pixels');
  }finally{detector.dispose();}
});

test('transparent changed input cannot retain pixels from a same-size detector canvas',async()=>{
  const fake=pixelPlatform(),detector=await createDetector(fake.value,true);
  try{
    const input=fake.source();assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    const resets=fake.canvases.map(canvas=>canvas.resets);
    assert.equal(detector.detect(fake.source(false) as unknown as HTMLCanvasElement),null,'old opaque Growth evidence must not survive transparent replacement');
    assert.deepEqual(fake.canvases.map(canvas=>canvas.resets),resets);
    for(const canvas of fake.canvases)assert.ok(canvas.pixels().every(byte=>byte===0),'both retained raster buffers contain only the new transparent pixels');
  }finally{detector.dispose();}
});

test('a Growth-only pixel change is revalidated with unchanged tracked header pixels',async()=>{
  const fake=pixelPlatform(),detector=await createDetector(fake.value,true);
  try{
    const input=fake.source();assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    assert.ok(detector.detect(input as unknown as HTMLCanvasElement));
    const native=fake.fake.nativeMatches,growth=fake.fake.growthMatches;
    // Growth is x=450..705/y=124..171; the tracked header begins at y=168.
    // Change only the non-overlapping rows, leaving header RGBA identical.
    for(let y=124;y<168;y++)for(let x=450;x<706;x++)input.data.set([30,30,220,255],(y*input.width+x)*4);
    assert.equal(detector.detect(input as unknown as HTMLCanvasElement),null,'loss of the selected-tab gold evidence still rejects the frame');
    assert.equal(fake.fake.nativeMatches,native,'identical tracked header bytes can use the exact cache');
    assert.equal(fake.fake.growthMatches,growth+1,'Growth bytes are independently compared and matched again');
  }finally{detector.dispose();}
});

test('detector profiling reports real cache paths without changing accepted layout',async()=>{
 const fake=platform(.96,.95,true),profile:DetectorProfile={};
 const detector=await createDetector(fake.value,true,event=>recordDetectorStage(profile,event));
 try {
  const input={width:2000,height:1600} as HTMLCanvasElement;
  const first=detector.detect(input);assert.ok(first);
  assert.deepEqual(detector.detect(input),first);
  assert.deepEqual(detector.detect(input),first);
  assert.equal(profile.global?.calls,1);
  assert.equal(profile.tracked?.calls,2);assert.equal(profile.tracked?.cached,1);
  assert.equal(profile.refinement?.calls,1);assert.equal(profile.growth?.calls,3);
  assert.equal(profile.growth?.cached,2);
 }finally{detector.dispose();}
});

test('global proposal reuse does not accept failed native evidence and invalidates on changed RGBA or geometry',async()=>{
 const fake=platform(.74,.95,true),events:Record<string,unknown>[]=[];
 const detector=await createDetector(fake.value,true,event=>events.push(event));
 try {
  const input={width:2000,height:1600} as HTMLCanvasElement;
  assert.equal(detector.detect(input),null);
  const before=fake.nativeMatches;
  assert.equal(detector.detect(input),null);
  assert.equal(events.filter(e=>e.stage==='coarse').at(-1)?.cached,true);
  assert.equal(fake.nativeMatches-before,17,'cached global candidate still requires native acceptance');
  fake.changePixel();assert.equal(detector.detect(input),null);
  assert.equal(events.filter(e=>e.stage==='coarse').at(-1)?.cached,false,'changed alpha invalidates the whole coarse raster');
  assert.equal(detector.detect({width:2100,height:1600} as HTMLCanvasElement),null);
  assert.equal(events.filter(e=>e.stage==='coarse').at(-1)?.cached,false,'geometry participates in the key');
 } finally {detector.dispose();}
});

test('oversized global rasters are searched without retaining an unbounded proposal snapshot',async()=>{
 const fake=platform(.74,.95,true),events:Record<string,unknown>[]=[];
 const detector=await createDetector(fake.value,true,event=>events.push(event));
 try {
  const input={width:2000,height:3200} as HTMLCanvasElement;
  assert.equal(detector.detect(input),null);assert.equal(detector.detect(input),null);
  assert.ok(events.filter(e=>e.stage==='coarse').every(e=>e.cached===false));
 } finally {detector.dispose();}
});

test('an exact repeated global miss can be reused but changed input searches again',async()=>{
 const fake=platform(.74),cv=fake.value.cv as unknown as {matchTemplate:(a:unknown,t:unknown,r:unknown)=>void};
 let matches=0;
 cv.matchTemplate=(_a,_t,r)=>{matches++;Object.assign(r as object,{score:.3,x:0,y:0});};
 const detector=await createDetector(fake.value,true);
 try {
  const input={width:2000,height:1600} as HTMLCanvasElement;
  assert.equal(detector.detect(input),null);assert.equal(matches,7);
  assert.equal(detector.detect(input),null);assert.equal(matches,7);
  fake.changePixel();assert.equal(detector.detect(input),null);assert.equal(matches,14);
 } finally {detector.dispose();}
});
