import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDetector} from '../src/features/card-scanner/detector';
import type {DetectorPlatform} from '../src/features/card-scanner/detector';

/** Synthetic CV scores isolate the coarse/native acceptance contract. Real
 * translated screenshot checks separately exercise the OpenCV computation. */
function platform(nativeScore: number, growthScore = .95) {
  class Mat {
    cols=0; rows=0; score=0; x=0; y=0;
    delete() {}
  }
  let nativeMatches=0;
  const cv={
    Mat, Size: class { width:number; height:number; constructor(w:number,h:number){this.width=w;this.height=h;} },
    COLOR_RGBA2GRAY:0,INTER_AREA:0,TM_CCOEFF_NORMED:0,
    cvtColor(a:Mat,b:Mat){b.cols=a.cols;b.rows=a.rows;},
    resize(_a:Mat,b:Mat,size:{width:number;height:number}){b.cols=size.width;b.rows=size.height;},
    matFromImageData(p:{width:number;height:number}){const m=new Mat();m.cols=p.width;m.rows=p.height;return m;},
    matchTemplate(a:Mat,t:Mat,r:Mat){
      if(a.cols===256&&a.rows===48){r.score=growthScore;r.x=r.y=0;}
      else if(a.cols>500){r.score=t.cols===64?.66:.3;r.x=384;r.y=128;}
      else{nativeMatches++;r.score=nativeScore;r.x=r.y=16;}
    },
    minMaxLoc(r:Mat){return {maxVal:r.score,maxLoc:{x:r.x,y:r.y}};},
  };
  const canvas=()=>{
    const c={width:1,height:1,getContext:()=>({drawImage(){},getImageData(_x:number,_y:number,w:number,h:number){
      const data=new Uint8ClampedArray(w*h*4);
      for(let i=0;i<data.length;i+=4){data[i]=220;data[i+1]=150;data[i+2]=30;data[i+3]=255;}
      return {width:w,height:h,data};
    }})};return c;
  };
  return {get nativeMatches(){return nativeMatches;}, value:{cv,canvas,anchor:async(name:string)=>{
    const m=new Mat();m.cols=name==='header-anchor.png'?100:256;m.rows=name==='header-anchor.png'?20:48;return m;
  }} as unknown as DetectorPlatform};
}

test('a phase-weakened coarse proposal must reach native verification',async()=>{
  const fake=platform(.96),detector=await createDetector(fake.value);
  try{const layout=detector.detect({width:2000,height:1600} as HTMLCanvasElement);
    assert.ok(fake.nativeMatches>0);assert.ok(layout);assert.equal(layout.score,.96);
  }finally{detector.dispose();}
});
test('accepting a coarse proposal does not lower native or Growth thresholds',async()=>{
  for(const [native,growth] of [[.74,.95],[.96,.79]]){
    const fake=platform(native,growth),detector=await createDetector(fake.value);
    try{assert.equal(detector.detect({width:2000,height:1600} as HTMLCanvasElement),null);assert.ok(fake.nativeMatches>0);}
    finally{detector.dispose();}
  }
});
