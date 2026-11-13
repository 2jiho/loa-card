import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COARSE_SCALES,createDetector,FULL_SEARCH_AFTER} from '../src/features/card-scanner/acquisition/detector';
import type {DetectorPlatform} from '../src/features/card-scanner/acquisition/detector';

/** Synthetic OpenCV: the header "appears" at the scale in `windowScale` (null: no card
 * window). The coarse pass is the one whose source is wider than 500 px; each call is
 * one scale tried, which is exactly what the scale memory saves. */
function fake(initial:number|null) {
  class Mat {cols=0;rows=0;score=0;x=0;y=0;delete(){}}
  const state={windowScale:initial as number|null,coarseCalls:0,sizes:[] as number[],wrongScaleScore:.3,strictRefinement:false};
  const ANCHOR_COLS=100,ANCHOR_ROWS=20;
  const cv={
    Mat,Size:class{width:number;height:number;constructor(w:number,h:number){this.width=w;this.height=h;}},
    COLOR_RGBA2GRAY:0,INTER_AREA:0,TM_CCOEFF_NORMED:0,
    cvtColor(a:Mat,b:Mat){b.cols=a.cols;b.rows=a.rows;},
    resize(_a:Mat,b:Mat,size:{width:number;height:number}){b.cols=size.width;b.rows=size.height;},
    matFromImageData(p:{width:number;height:number}){const m=new Mat();m.cols=p.width;m.rows=p.height;return m;},
    matchTemplate(a:Mat,t:Mat,r:Mat){
      if(a.cols===256&&a.rows===48){r.score=.95;r.x=r.y=0;return;}   // Growth tab check
      if(a.cols>500){                                                   // coarse global/tracked search
        state.coarseCalls++;state.sizes.push(t.cols);
        const ratio=0.5,wanted=state.windowScale===null?-1:Math.round(ANCHOR_COLS*state.windowScale*ratio);
        r.score=t.cols===wanted?.99:state.wrongScaleScore;r.x=384;r.y=128;return;
      }
      // native refinement; strict: only a template of the window's real size matches
      r.score=!state.strictRefinement||(state.windowScale!==null&&Math.abs(t.cols-ANCHOR_COLS*state.windowScale)<=1)?.96:.5;r.x=r.y=16;
    },
    minMaxLoc(r:Mat){return {maxVal:r.score,maxLoc:{x:r.x,y:r.y}};},
  };
  const canvas=()=>({width:1,height:1,getContext:()=>({drawImage(){},getImageData(_x:number,_y:number,w:number,h:number){
    const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<data.length;i+=4){data[i]=220;data[i+1]=150;data[i+2]=30;data[i+3]=255;}
    return {width:w,height:h,data};}})});
  const platform={cv,canvas,anchor:async(name:string)=>{const m=new Mat();m.cols=name==='header-anchor.png'?ANCHOR_COLS:256;m.rows=name==='header-anchor.png'?ANCHOR_ROWS:48;return m;}} as unknown as DetectorPlatform;
  return {state,platform};
}
const SOURCE={width:2560,height:1440} as HTMLCanvasElement;
const calls=(f:ReturnType<typeof fake>,run:()=>void)=>{const before=f.state.coarseCalls;run();return f.state.coarseCalls-before;};
/** Forget tracking the way a closed window does (a zero-sized frame resets it). */
const reset=(d:Awaited<ReturnType<typeof createDetector>>)=>d.detect({width:0,height:0} as HTMLCanvasElement);

test('nothing remembered: every frame without a window searches all scales, as before', async()=>{
  const f=fake(null),d=await createDetector(f.platform);
  try{
    for(let i=0;i<3;i++)assert.equal(calls(f,()=>assert.equal(d.detect(SOURCE),null)),COARSE_SCALES.length);
  }finally{d.dispose();}
});

test('after a window was found, frames without one try only the remembered scale, with a full search every few frames', async()=>{
  const f=fake(1),d=await createDetector(f.platform);
  try{
    assert.ok(d.detect(SOURCE),'window found at scale 1 (first scale, early exit)');
    f.state.windowScale=null;reset(d);                      // the window is closed
    const perFrame:number[]=[];
    for(let i=0;i<FULL_SEARCH_AFTER*2+2;i++)perFrame.push(calls(f,()=>assert.equal(d.detect(SOURCE),null)));
    // restricted frames cost one scale; after FULL_SEARCH_AFTER misses one full search, then it repeats.
    assert.deepEqual(perFrame.slice(0,FULL_SEARCH_AFTER),Array(FULL_SEARCH_AFTER).fill(1));
    assert.equal(perFrame[FULL_SEARCH_AFTER],COARSE_SCALES.length);
    assert.deepEqual(perFrame.slice(FULL_SEARCH_AFTER+1,FULL_SEARCH_AFTER*2+1),Array(FULL_SEARCH_AFTER).fill(1));
    assert.equal(perFrame[FULL_SEARCH_AFTER*2+1],COARSE_SCALES.length);
  }finally{d.dispose();}
});

test('a window that reappears at the remembered scale is found at once; at another scale within the full-search interval', async()=>{
  const f=fake(1),d=await createDetector(f.platform);
  try{
    assert.ok(d.detect(SOURCE));
    f.state.windowScale=null;reset(d);
    assert.equal(d.detect(SOURCE),null);
    f.state.windowScale=1;assert.ok(d.detect(SOURCE),'same scale: found on the very next frame');
    // The UI scale changes while the window is closed.
    f.state.windowScale=null;reset(d);
    f.state.windowScale=1.3;
    let found=0;
    for(let i=0;i<=FULL_SEARCH_AFTER;i++){const layout=d.detect(SOURCE);if(layout){found=i+1;break;}}
    assert.ok(found>0&&found<=FULL_SEARCH_AFTER+1,`a new scale is found within ${FULL_SEARCH_AFTER+1} frames, found on frame ${found}`);
    f.state.windowScale=null;reset(d);
    f.state.windowScale=1.3;assert.ok(d.detect(SOURCE),'and the new scale is remembered');
  }finally{d.dispose();}
});

test('a different source size forgets the scale; dispose forgets everything', async()=>{
  const f=fake(1),d=await createDetector(f.platform);
  try{
    assert.ok(d.detect(SOURCE));
    f.state.windowScale=null;reset(d);
    assert.equal(calls(f,()=>assert.equal(d.detect(SOURCE),null)),1,'remembered at this size');
    reset(d);
    assert.equal(calls(f,()=>assert.equal(d.detect({width:1920,height:1080} as HTMLCanvasElement),null)),COARSE_SCALES.length,'new size: full search');
  }finally{d.dispose();}
});

test('a window shown while tracking is unaffected by the memory', async()=>{
  const f=fake(1),d=await createDetector(f.platform);
  try{
    assert.ok(d.detect(SOURCE));
    // Tracking looks at a small region around the known window, never the whole source,
    // so it is not a global search at all (here: no coarse call over a wide source).
    const globalSearches=calls(f,()=>assert.ok(d.detect(SOURCE),'the tracked window is still found'));
    assert.equal(globalSearches,0);
  }finally{d.dispose();}
});

test('a weak match at the remembered scale that refinement rejects still leads back to the full search', async()=>{
  const f=fake(1),d=await createDetector(f.platform);
  try{
    assert.ok(d.detect(SOURCE));
    // The UI scale changes while the window is closed; the header still matches weakly at the old scale.
    f.state.windowScale=null;reset(d);
    f.state.windowScale=1.3;f.state.wrongScaleScore=.65;f.state.strictRefinement=true;
    let found=0;
    for(let i=0;i<=FULL_SEARCH_AFTER;i++)if(d.detect(SOURCE)){found=i+1;break;}
    assert.ok(found>0,'the window at the new scale is found within '+(FULL_SEARCH_AFTER+1)+' frames');
  }finally{d.dispose();}
});

test('the 1920x1080 interface scale is one of the search scales', () => {
  // 1080 / 1440: the card window of a 1080p share is this size relative to the templates.
  assert.ok((COARSE_SCALES as readonly number[]).includes(.75));
  // Every scale is reachable by the native refinement (+-0.09) from a coarse scale only if the
  // coarse scales themselves are not too far apart around the common resolutions.
  const sorted=[...COARSE_SCALES].sort((a,b)=>a-b);
  assert.ok(sorted.includes(1)&&sorted.includes(.75));
});
