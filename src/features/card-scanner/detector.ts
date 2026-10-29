import type * as OpenCV from "@techstark/opencv-js";
import { rasterContext } from './acquisition-raster';
import type { Raster } from './acquisition-raster';
import { ExactPixelCache } from './exact-pixel-cache';
import { createDetectorTemplateCache } from './detector-template-cache';
type CV = typeof OpenCV;
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Layout {
  cells: Box[];
  header: Box;
  growthPoints: Box;
  sort: Box;
  growthScore: number;
  area: Box;
  scrollbar: Box;
  score: number;
  scale: number;
}
let runtime: Promise<CV> | undefined;
export function loadCv(): Promise<CV> {
  if (!runtime)
    runtime = new Promise<CV>((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => fail(new Error('화면 검출 모듈 준비 시간 초과')), 120_000);
      const fail = (error: unknown) => { clearTimeout(timer); script.remove(); reject(error); };
      const done = (value: CV) => { clearTimeout(timer); resolve(value); };
      script.src = `${import.meta.env.BASE_URL}ocr/opencv.js`;
      script.onerror = () => fail(new Error('화면 검출 모듈을 불러올 수 없습니다. 연결을 확인하고 다시 시작해 주세요.'));
      script.onload = async () => {
        try {
          const loaded = await (window as unknown as { cv: CV | Promise<CV> }).cv;
          if (!loaded) throw new Error('화면 검출 모듈 응답 오류');
          if (loaded.Mat) done(loaded);
          else (loaded as CV & { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => done(loaded);
        } catch (error) { fail(error); }
      };
      document.head.append(script);
    }).catch(error => { runtime = undefined; throw error; });
  return runtime;
}
export interface DetectorPlatform {
  cv: CV;
  canvas: () => Raster;
  anchor: (name:string) => Promise<OpenCV.Mat>;
}
export async function createDetector(platform?: DetectorPlatform, reuseExact = false,
  trace?: (event: Record<string, unknown>) => void) {
  const cv = platform?.cv ?? await loadCv();
  const makeCanvas = platform?.canvas ?? (()=>document.createElement('canvas'));
  const anchor = platform?.anchor ?? (async (name:string) => {
    const image=new Image();image.src=`${import.meta.env.BASE_URL}scanner/${name}`;
    await image.decode();return cv.imread(image);
  });
  const original = await anchor('header-anchor.png');
  let growthOriginal: OpenCV.Mat;
  try { growthOriginal = await anchor('growth-tab.png'); }
  catch (error) { original.delete(); throw error; }
  const grayAnchor = new cv.Mat();
  cv.cvtColor(original, grayAnchor, cv.COLOR_RGBA2GRAY);
  original.delete();
  const growthAnchor = new cv.Mat();
  cv.cvtColor(growthOriginal, growthAnchor, cv.COLOR_RGBA2GRAY);
  growthOriginal.delete();
  const templates=createDetectorTemplateCache((width,height)=>{
    const template=new cv.Mat();
    try {cv.resize(grayAnchor,template,new cv.Size(width,height),0,0,cv.INTER_AREA);return template;}
    catch(error){template.delete();throw error;}
  });
  const growthCanvas = makeCanvas();
  const canvas = makeCanvas();
  // This canvas is read back by OpenCV every frame. Keep it on the CPU;
  // repeatedly uploading the full source to the GPU stalls live delivery.
  rasterContext(canvas);
  let previous: { x: number; y: number; scale: number; width:number; height:number } | null = null;
  const dimension=(value:number)=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
  const located=(value:{x:number;y:number;scale:number},width:number,height:number)=>
    Number.isFinite(value.x)&&value.x>=0&&value.x<width&&Number.isFinite(value.y)&&value.y>=0&&value.y<height&&
    Number.isFinite(value.scale)&&value.scale>0;
  const trackedCache = new ExactPixelCache<{score:number;x:number;y:number;scale:number}>(1);
  // Cache only the coarse proposal (including a miss), never final acceptance.
  // Tall sources must not grow this optional working set without a bound.
  let globalCache = new ExactPixelCache<{score:number;x:number;y:number;scale:number}>(1);
  const globalCacheBytes = 8 * 1024 * 1024;
  const refinementCache = new ExactPixelCache<{score:number;x:number;y:number;scale:number}>(1);
  const growthCache = new ExactPixelCache<{score:number;gold:number}>(1);
  return {
    detect(video: HTMLVideoElement | HTMLImageElement | Raster): Layout | null {
      const coarseStarted=trace?performance.now():0;
      const mediaWidth =
        "videoWidth" in video ? video.videoWidth : "naturalWidth" in video ? video.naturalWidth : video.width;
      const mediaHeight =
        "videoHeight" in video ? video.videoHeight : "naturalHeight" in video ? video.naturalHeight : video.height;
      // Tracking coordinates belong to one source geometry. A smaller next
      // source can otherwise make mediaWidth-offsetX negative before matching.
      if(!dimension(mediaWidth)||!dimension(mediaHeight)){previous=null;return null;}
      if(previous&&(previous.width!==mediaWidth||previous.height!==mediaHeight||!located(previous,mediaWidth,mediaHeight)))previous=null;
      const tracked = previous;
      const ratio = tracked ? 1 : Math.min(1, 1280 / mediaWidth);
      const offsetX = tracked ? Math.max(0, tracked.x - 32) : 0;
      const offsetY = tracked ? Math.max(0, tracked.y - 32) : 0;
      const width = tracked
        ? Math.min(mediaWidth - offsetX, grayAnchor.cols * tracked.scale + 64)
        : mediaWidth;
      const height = tracked
        ? Math.min(mediaHeight - offsetY, grayAnchor.rows * tracked.scale + 64)
        : mediaHeight;
      const rasterWidth=Math.round(width*ratio),rasterHeight=Math.round(height*ratio);
      if(!dimension(rasterWidth)||!dimension(rasterHeight)){previous=null;return null;}
      if(canvas.width!==rasterWidth)canvas.width=rasterWidth;
      if(canvas.height!==rasterHeight)canvas.height=rasterHeight;
      const context=rasterContext(canvas);
      // Same-size canvases retain pixels and state. Replace the full raster,
      // including transparent input, without resetting the backing store.
      context.globalCompositeOperation='copy';
      context.drawImage(
          video,
          offsetX,
          offsetY,
          width,
          height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      const trackedPixels = rasterContext(canvas).getImageData(0,0,canvas.width,canvas.height);
      const trackedKey = JSON.stringify([tracked?.x,tracked?.y,tracked?.scale,mediaWidth,mediaHeight,offsetX,offsetY,width,height,canvas.width,canvas.height]);
      const proposalCache = tracked ? trackedCache : globalCache;
      const cacheable = reuseExact && (!!tracked || trackedPixels.data.byteLength <= globalCacheBytes);
      const cached = cacheable ? proposalCache.get(0,trackedKey,trackedPixels.data) : undefined;
      let best = cached ? {...cached} : { score: 0, x: 0, y: 0, scale: 1 };
      if (!cached) {
        const src = cv.matFromImageData(trackedPixels);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        src.delete();
        try {
          for (const scale of tracked
            ? [tracked.scale]
            : [1, 0.85, 1.15, 0.7, 1.3, 0.55, 1.5]) {
            const lease=templates.acquire(Math.round(grayAnchor.cols*scale*ratio),Math.round(grayAnchor.rows*scale*ratio));
            const template=lease.value,result=new cv.Mat();
            try {
              if (template.cols >= gray.cols || template.rows >= gray.rows)
                continue;
              cv.matchTemplate(gray, template, result, cv.TM_CCOEFF_NORMED);
              const match = (
                cv.minMaxLoc as (source: OpenCV.Mat) => OpenCV.MinMaxLoc
              )(result);
              if (match.maxVal > best.score)
                best = {
                  score: match.maxVal,
                  x: offsetX + match.maxLoc.x / ratio,
                  y: offsetY + match.maxLoc.y / ratio,
                  scale,
                };
              if (best.score > 0.92) break;
            } finally {
              lease.release();
              result.delete();
            }
          }
        } finally {
          gray.delete();
        }
      }
      trace?.({stage:'coarse',tracked:!!tracked,cached:!!cached,elapsedMs:performance.now()-coarseStarted,...best});
      if(cacheable&&!tracked&&!cached&&Number.isFinite(best.score)&&located(best,mediaWidth,mediaHeight))
        globalCache.setOwned(0,trackedKey,trackedPixels.data,{...best});
      if(!Number.isFinite(best.score)||!located(best,mediaWidth,mediaHeight)){
        previous=null;return tracked?this.detect(video):null;
      }
      // Half-resolution glyphs change phase after odd-pixel window movement.
      // A coarse candidate is only a location proposal; validate at native
      // resolution before accepting it, with the original final threshold.
      if (best.score < (tracked ? 0.75 : 0.6)) {
        previous = null;
        return tracked ? this.detect(video) : null;
      }
      // Cache the tracked proposal, not the refined/final decision. A weaker
      // proposal still enters native refinement below, whose different pixels
      // and geometry are checked independently on every input.
      if (reuseExact && tracked && !cached)
        trackedCache.set(0,trackedKey,trackedPixels.data,{...best});
      // Coarse downsampling estimates the scale. Refine at native resolution so
      // fractional scale errors do not accumulate across the ten-column grid.
      if (!tracked || best.score < 0.88) {
        const refinementStarted=trace?performance.now():0;
        const left = Math.max(0, Math.floor(best.x - 16));
        const top = Math.max(0, Math.floor(best.y - 16));
        const refineWidth = Math.min(
          mediaWidth - left,
          Math.ceil(grayAnchor.cols * (best.scale + 0.09) + 32),
        );
        const refineHeight = Math.min(
          mediaHeight - top,
          Math.ceil(grayAnchor.rows * (best.scale + 0.09) + 32),
        );
        if(!dimension(refineWidth)||!dimension(refineHeight)){previous=null;return null;}
        if(canvas.width!==refineWidth)canvas.width=refineWidth;
        if(canvas.height!==refineHeight)canvas.height=refineHeight;
        const nativeContext=rasterContext(canvas);
        nativeContext.globalCompositeOperation='copy';
        nativeContext.drawImage(
            video,
            left,
            top,
            canvas.width,
            canvas.height,
            0,
            0,
            canvas.width,
            canvas.height,
          );
        const nativePixels=rasterContext(canvas).getImageData(0,0,canvas.width,canvas.height);
        const refinementKey=JSON.stringify([best.x,best.y,best.scale,left,top,canvas.width,canvas.height,mediaWidth,mediaHeight]);
        const cachedRefinement=reuseExact?refinementCache.get(0,refinementKey,nativePixels.data):undefined;
        if(cachedRefinement)best={...cachedRefinement};
        else {
          const native = cv.matFromImageData(nativePixels),
            gray = new cv.Mat();
          cv.cvtColor(native, gray, cv.COLOR_RGBA2GRAY);
          native.delete();
          let refined = { ...best, score: 0 };
          try {
            for (let step = -8; step <= 8; step++) {
              const scale = Math.round((best.scale + step * 0.01) * 100) / 100;
              const lease=templates.acquire(Math.round(grayAnchor.cols*scale),Math.round(grayAnchor.rows*scale));
              const template=lease.value,result=new cv.Mat();
              try {
                if (template.cols >= gray.cols || template.rows >= gray.rows)
                  continue;
                cv.matchTemplate(gray, template, result, cv.TM_CCOEFF_NORMED);
                const match = (
                  cv.minMaxLoc as (source: OpenCV.Mat) => OpenCV.MinMaxLoc
                )(result);
                if (match.maxVal > refined.score)
                  refined = {
                    score: match.maxVal,
                    x: left + match.maxLoc.x,
                    y: top + match.maxLoc.y,
                    scale,
                  };
              } finally {
                lease.release();
                result.delete();
              }
            }
          } finally {
            gray.delete();
          }
          if (refined.score >= 0.75) {
            best = refined;
            if(reuseExact)refinementCache.setOwned(0,refinementKey,nativePixels.data,{...best});
          }
        }
        trace?.({stage:'refinement-work',cached:!!cachedRefinement,elapsedMs:performance.now()-refinementStarted});
      }
      if (!Number.isFinite(best.score)||!located(best,mediaWidth,mediaHeight)||best.score < 0.75){previous=null;return null;}
      // The inventory title also appears outside Growth. Validate the selected tab.
      trace?.({stage:'refined',...best});
      const gx = best.x - 150 * best.scale,
        gy = best.y - 76 * best.scale;
      if (
        gx < 0 ||
        gy < 0 ||
        gx + 256 * best.scale > mediaWidth ||
        gy + 48 * best.scale > mediaHeight
      )
        return null;
      const growthStarted=trace?performance.now():0;
      if(growthCanvas.width!==256)growthCanvas.width=256;
      if(growthCanvas.height!==48)growthCanvas.height=48;
      const gc = rasterContext(growthCanvas);
      gc.globalCompositeOperation='copy';
      gc.drawImage(
        video,
        gx,
        gy,
        256 * best.scale,
        48 * best.scale,
        0,
        0,
        256,
        48,
      );
      const growthPixels = gc.getImageData(0, 0, 256, 48);
      const gp = growthPixels.data;
      const growthKey = JSON.stringify([gx,gy,best.scale,mediaWidth,mediaHeight]);
      const cachedGrowth = reuseExact ? growthCache.get(0,growthKey,gp) : undefined;
      let gold = 0;
      let growthScore = 0;
      if (cachedGrowth) { gold=cachedGrowth.gold;growthScore=cachedGrowth.score; }
      else {
        for (let i = 0; i < gp.length; i += 4)
          if (
            gp[i] > gp[i + 1] * 1.08 &&
            gp[i + 1] > gp[i + 2] * 1.25 &&
            gp[i] > 100
          )
            gold++;
        const gm = cv.matFromImageData(growthPixels),
          gg = new cv.Mat(),
          gr = new cv.Mat();
        try {
          cv.cvtColor(gm, gg, cv.COLOR_RGBA2GRAY);
          cv.matchTemplate(gg, growthAnchor, gr, cv.TM_CCOEFF_NORMED);
          growthScore = (
            cv.minMaxLoc as (source: OpenCV.Mat) => OpenCV.MinMaxLoc
          )(gr).maxVal;
        } finally {
          gm.delete();
          gg.delete();
          gr.delete();
        }
        if(reuseExact)growthCache.set(0,growthKey,gp,{score:growthScore,gold});
      }
      trace?.({stage:'growth',cached:!!cachedGrowth,elapsedMs:performance.now()-growthStarted,growthScore,gold:gold/(256*48),gx,gy});
      if (growthScore < 0.8 || gold / (256 * 48) < 0.2) return null;
      previous = {x:best.x,y:best.y,scale:best.scale,width:mediaWidth,height:mediaHeight};
      const { x, y, scale: s } = best;
      const cells: Box[] = [];
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 10; col++) {
          const box = {
            x: Math.round(x + (-662 + col * 157.5) * s),
            y: Math.round(y + (186 + row * 243) * s),
            width: 140 * s,
            height: 210 * s,
          };
          cells.push(box);
        }
      // Preserve logical slot indices even when the window is partially offscreen.
      // Acquisition checks each card's bounds instead of requiring all 40 slots.
      if (!cells.some(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= mediaWidth && box.y + box.height <= mediaHeight)) return null;
      return {
        cells,
        growthScore,
        growthPoints: {
          x: x + 710 * s,
          y: y - 6 * s,
          width: 230 * s,
          height: 34 * s,
        },
        sort: {
          x: x + 718 * s,
          y: y + 101 * s,
          width: 210 * s,
          height: 40 * s,
        },
        scrollbar: {
          x: x + 910 * s,
          y: y + 186 * s,
          width: 16 * s,
          height: 942 * s,
        },
        header: {
          x: x + 126 * s,
          y: y - 2 * s,
          width: 200 * s,
          height: 34 * s,
        },
        area: {
          x: x - 662 * s,
          y: y + 186 * s,
          width: 1562 * s,
          height: 942 * s,
        },
        score: best.score,
        scale: s,
      };
    },
    dispose() {
      templates.dispose();
      grayAnchor.delete();
      growthAnchor.delete();
      growthCanvas.width = 0;
      growthCanvas.height = 0;
      canvas.width=canvas.height=0;previous=null;
      globalCache = new ExactPixelCache(1);
    },
  };
}
