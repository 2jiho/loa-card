import type * as OpenCV from "@techstark/opencv-js";
import { rasterContext } from './acquisition-raster';
import type { Raster } from './acquisition-raster';
import { ExactPixelCache } from './exact-pixel-cache';
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
  const readCanvas = (canvas:Raster) => cv.matFromImageData(rasterContext(canvas).getImageData(0,0,canvas.width,canvas.height));
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
  const growthCanvas = makeCanvas();
  const canvas = makeCanvas();
  // This canvas is read back by OpenCV every frame. Keep it on the CPU;
  // repeatedly uploading the full source to the GPU stalls live delivery.
  rasterContext(canvas);
  let previous: { x: number; y: number; scale: number } | null = null;
  const trackedCache = new ExactPixelCache<{score:number;x:number;y:number;scale:number}>(1);
  const growthCache = new ExactPixelCache<{score:number;gold:number}>(1);
  return {
    detect(video: HTMLVideoElement | HTMLImageElement | Raster): Layout | null {
      const mediaWidth =
        "videoWidth" in video ? video.videoWidth : "naturalWidth" in video ? video.naturalWidth : video.width;
      const mediaHeight =
        "videoHeight" in video ? video.videoHeight : "naturalHeight" in video ? video.naturalHeight : video.height;
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
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      rasterContext(canvas)
        .drawImage(
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
      const trackedKey = JSON.stringify([tracked,mediaWidth,mediaHeight,offsetX,offsetY,width,height,canvas.width,canvas.height]);
      const cached = reuseExact && tracked ? trackedCache.get(0,trackedKey,trackedPixels.data) : undefined;
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
            const template = new cv.Mat();
            const result = new cv.Mat();
            try {
              cv.resize(
                grayAnchor,
                template,
                new cv.Size(
                  Math.round(grayAnchor.cols * scale * ratio),
                  Math.round(grayAnchor.rows * scale * ratio),
                ),
                0,
                0,
                cv.INTER_AREA,
              );
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
              template.delete();
              result.delete();
            }
          }
        } finally {
          gray.delete();
        }
      }
      trace?.({stage:'coarse',tracked:!!tracked,...best});
      // Half-resolution glyphs change phase after odd-pixel window movement.
      // A coarse candidate is only a location proposal; validate at native
      // resolution before accepting it, with the original final threshold.
      if (best.score < (tracked ? 0.75 : 0.6)) {
        previous = null;
        return tracked ? this.detect(video) : null;
      }
      // Refinement reads a different region: cache only tracked matches that
      // do not need refinement. Any byte/geometry change uses the full matcher.
      if (reuseExact && tracked && !cached && best.score >= .88)
        trackedCache.set(0,trackedKey,trackedPixels.data,{...best});
      // Coarse downsampling estimates the scale. Refine at native resolution so
      // fractional scale errors do not accumulate across the ten-column grid.
      if (!tracked || best.score < 0.88) {
        const left = Math.max(0, Math.floor(best.x - 16));
        const top = Math.max(0, Math.floor(best.y - 16));
        canvas.width = Math.min(
          mediaWidth - left,
          Math.ceil(grayAnchor.cols * (best.scale + 0.09) + 32),
        );
        canvas.height = Math.min(
          mediaHeight - top,
          Math.ceil(grayAnchor.rows * (best.scale + 0.09) + 32),
        );
        rasterContext(canvas)
          .drawImage(
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
        const native = readCanvas(canvas),
          gray = new cv.Mat();
        cv.cvtColor(native, gray, cv.COLOR_RGBA2GRAY);
        native.delete();
        let refined = { ...best, score: 0 };
        try {
          for (let step = -8; step <= 8; step++) {
            const scale = Math.round((best.scale + step * 0.01) * 100) / 100;
            const template = new cv.Mat(),
              result = new cv.Mat();
            try {
              cv.resize(
                grayAnchor,
                template,
                new cv.Size(
                  Math.round(grayAnchor.cols * scale),
                  Math.round(grayAnchor.rows * scale),
                ),
                0,
                0,
                cv.INTER_AREA,
              );
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
              template.delete();
              result.delete();
            }
          }
        } finally {
          gray.delete();
        }
        if (refined.score >= 0.75) best = refined;
      }
      if (best.score < 0.75) return null;
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
      growthCanvas.width = 256;
      growthCanvas.height = 48;
      const gc = rasterContext(growthCanvas);
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
      trace?.({stage:'growth',growthScore,gold:gold/(256*48),gx,gy});
      if (growthScore < 0.8 || gold / (256 * 48) < 0.2) return null;
      previous = best;
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
      grayAnchor.delete();
      growthAnchor.delete();
      growthCanvas.width = 0;
    },
  };
}
