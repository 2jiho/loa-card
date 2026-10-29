import { confirmCounter, parseCounterEvidence } from "./counter-evidence";
import type { CounterReading } from "./counter-evidence";
import type { CountDiagnostics } from "./recognizer";
import { parseGrowthPoints, parseCardSort } from "./capture-metadata";
import { createNeuralReader } from "./neural-reader";
import type { Worker, PSM } from "tesseract.js";
import { matchCardName, normalizeName } from "./card-dictionary";
import { createArtworkVerifier } from "./artwork-verifier";
import type { ArtworkEvidence } from "./artwork-verifier";
import { matchCtcCardName } from "./ctc-name-match";
import type { CatalogName } from "./card-dictionary";
import { confirmCatalogName } from "./name-confidence";
import type { NameMatchEvidence } from "./name-confidence";
import { softNamePixels, normalizeSoftNamePixels } from "./soft-name-pixels";
import { strongNameMask } from "./text-mask";
import { nameMask, nameSimilarity, packName } from "./name-pattern";
import { parseInventoryTotal } from "./ocr-values";
import { nameAttempt } from "./name-diagnostics";
import type { NameAttempt } from "./name-diagnostics";
import { ExactRegionResult } from './exact-region-result';
import { ExactPixelCache } from './exact-pixel-cache';
import type {CardReadBudget} from './card-read-budget';
import {observeNameLabel,type NameLabelObserver} from './recognition-input-observer';
import {createGrayNameFirstLine,NAME_GRAY_FIRST_RECIPE} from './name-gray-first';
import {nameLabelContrast} from './name-label-contrast';
import {initializeOwnedResource,onceDisposer,settleDisposals} from './resource-cleanup';

export type NameRawResultPolicy='resample'|'continue';
export type NameOcrRecipe='raw-first-line'|'raw-second-line'|'raw-full-label'|'gray-first-line'|'stretch-first-v1'|
  `soft-grade-${0|1|2|3|4}-${'original'|'normalized'}`;
export type NameReading=NonNullable<ReturnType<typeof matchCardName>>&{
  ocrConfidence:number;rawText:string;complete:boolean;engine:'paddle'|'tesseract';readingId:string;fingerprint:string;
  ctc?:{relativeLikelihood:number;margin:number};artwork?:ArtworkEvidence;preprocessing?:'soft-rarity'|'stretch-first-v1'|typeof NAME_GRAY_FIRST_RECIPE;
};
export interface NameOcrMetrics {
  /** Korean neural name-wrapper calls only: readiness/copy/queue/Worker await.
   * Excludes Tesseract, digits and metadata; requests are not inference counts. */
  readonly scope:'korean-neural-name-request-await';readonly policy:NameRawResultPolicy;
  readonly invocations:number;readonly continued:number;readonly quickAccepted:number;readonly invocationFailures:number;
  readonly requests:number;readonly reusedRequests:number;readonly failedRequests:number;readonly wallAwaitMs:number;
  readonly recipes:readonly Readonly<{recipe:NameOcrRecipe;requests:number;reusedRequests:number;failedRequests:number;wallAwaitMs:number}>[];
}
export interface IdentifyNameOptions {
  full?:boolean;offsetY?:number;allowRaw?:boolean;onAttempt?:(attempt:NameAttempt)=>void;budget?:CardReadBudget;
  observeLabel?:NameLabelObserver;allowGrayNameFallback?:boolean;
  acceptQuick(reading:NameReading|null):boolean;onMetrics?:(metrics:NameOcrMetrics)=>void;
}
type MutableMetrics={invocations:number;continued:number;quickAccepted:number;invocationFailures:number;
  requests:number;reusedRequests:number;failedRequests:number;wallAwaitMs:number;
  recipes:Map<NameOcrRecipe,{recipe:NameOcrRecipe;requests:number;reusedRequests:number;failedRequests:number;wallAwaitMs:number}>};
const newMetrics=(invocations=0):MutableMetrics=>({invocations,continued:0,quickAccepted:0,invocationFailures:0,
  requests:0,reusedRequests:0,failedRequests:0,wallAwaitMs:0,recipes:new Map()});
type MatchExecution={metrics:MutableMetrics;continueQuick?:(reading:NameReading|null)=>boolean};

/** OCR supplies visible text; artwork can independently confirm a truncated name. */
export function createNameReader(cards: (CatalogName & { feature?: string })[], status?: (message: string) => void, signal?: AbortSignal,
  options:{rawResultPolicy?:NameRawResultPolicy;contrastNameFallback?:boolean}={}) {
  const rawResultPolicy=options.rawResultPolicy??'resample';
  if(rawResultPolicy!=='resample'&&rawResultPolicy!=='continue')throw Error('Invalid name raw-result policy');
  const aggregate=newMetrics();
  const snapshot=(metrics:MutableMetrics):NameOcrMetrics=>Object.freeze({scope:'korean-neural-name-request-await' as const,policy:rawResultPolicy,
    ...metrics,recipes:Object.freeze([...metrics.recipes.values()].map(value=>Object.freeze({...value})))});
  const update=(metrics:MutableMetrics,recipe:NameOcrRecipe,kind:'requests'|'reusedRequests'|'failedRequests'|'wallAwaitMs',amount=1)=>{
    for(const target of [metrics,aggregate]){
      target[kind]+=amount;let row=target.recipes.get(recipe);
      if(!row){row={recipe,requests:0,reusedRequests:0,failedRequests:0,wallAwaitMs:0};target.recipes.set(recipe,row);}
      row[kind]+=amount;
    }
  };
  const neural = createNeuralReader("korean", cards.map(({ id, name }) => ({ id, name })), status);
  const verifyArtwork = createArtworkVerifier(cards);
  const digits = createNeuralReader("digits", undefined, status);
  const abort = () => { neural.dispose(); digits.dispose(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const engines = new Map<string, Promise<Worker>>();
  const terminateWorker=onceDisposer((worker:Worker)=>worker.terminate());
  let initializationCleanupError:{error:unknown}|undefined;
  const rememberCleanupError=(error:unknown)=>{initializationCleanupError??={error};};
  const cache: {
    bits: Uint32Array;
    pixels: number;
    height: number;
    grade: number;
    result: NonNullable<ReturnType<typeof matchCardName>> & {
      ocrConfidence: number;
      rawText: string;
      complete: boolean;
      engine: "paddle" | "tesseract";
      readingId: string;
      fingerprint: string;
      ctc?: { relativeLikelihood: number; margin: number };
      artwork?: ArtworkEvidence;
      preprocessing?: "soft-rarity" | typeof NAME_GRAY_FIRST_RECIPE;
    };
  }[] = [];
  const counters = new ExactPixelCache<number>(1024);
  const pointsCache=new ExactRegionResult<NonNullable<ReturnType<typeof parseGrowthPoints>>>(1);
  const sortCache=new ExactRegionResult<NonNullable<ReturnType<typeof parseCardSort>>>(1);
  let disposed = false;
  let disposal:Promise<void>|undefined;
  function worker(language: "kor" | "eng") {
    if(disposed)return Promise.reject(new Error("OCR 종료"));
    let engine = engines.get(language);
    if (!engine) {
      engine = (async () => {
        const { createWorker } = await import("tesseract.js");
        const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href)
          .href;
        return initializeOwnedResource(()=>createWorker(language, 1, {
          workerPath: `${base}worker.min.js`,
          corePath: base,
          langPath: base.replace(/\/$/, ""),
          cachePath: `loacard-${language}-4.1.0`,
          workerBlobURL: false,
        }),instance=>instance.setParameters({
          tessedit_pageseg_mode: (language === "kor" ? "6" : "7") as PSM,
          user_defined_dpi: "300",
          tessedit_char_whitelist: "",
        }),terminateWorker,{isClosed:()=>disposed,closedError:()=>new Error("OCR 종료"),onCleanupError:rememberCleanupError});
      })();
      engines.set(language, engine);
    }
    return engine;
  }
  async function boundedWorker(language:"kor"|"eng",budget?:CardReadBudget){
    budget?.check();
    const engine=worker(language);
    const invalidate=()=>{if(engines.get(language)===engine)engines.delete(language);
      void engine.then(instance=>terminateWorker(instance).catch(rememberCleanupError),()=>{});};
    return budget ? budget.wait(()=>engine,invalidate) : engine;
  }
  async function parameters(language:"kor"|"eng",psm:PSM,budget?:CardReadBudget){
    const instance=await boundedWorker(language,budget);
    const set=()=>instance.setParameters({tessedit_pageseg_mode:psm});
    if(budget)await budget.wait(set,()=>{engines.delete(language);void terminateWorker(instance).catch(rememberCleanupError);});
    else await set();
  }
  async function recognize(source: HTMLCanvasElement, language: "kor" | "eng", budget?:CardReadBudget) {
    const instance = await boundedWorker(language,budget);
    if(budget)return (await budget.wait(()=>instance.recognize(source),()=>{engines.delete(language);void terminateWorker(instance).catch(rememberCleanupError); } )).data;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { data } = await Promise.race([
        instance.recognize(source),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void terminateWorker(instance).catch(rememberCleanupError);
            reject(new Error("OCR 판독 시간 초과"));
          }, 10000);
        }),
      ]);
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function enlarge(source: HTMLCanvasElement, binary = false) {
    const output = document.createElement("canvas");
    output.width = source.width * 4 + 32;
    output.height = source.height * 4 + 32;
    const context = output.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, output.width, output.height);
    if (!binary) context.filter = "grayscale(1) invert(1) contrast(2)";
    context.drawImage(source, 16, 16, source.width * 4, source.height * 4);
    return output;
  }
  async function matchImpl(source: HTMLCanvasElement, quick = false, offsetY = 0, allowRaw = false, onAttempt?: (attempt: NameAttempt) => void,budget?:CardReadBudget, bypassCache = false,observeLabel?:NameLabelObserver,allowGrayNameFallback=false,execution?:MatchExecution):Promise<NameReading|null> {
      const check=()=>{signal?.throwIfAborted();if(disposed)throw Error('OCR 종료');budget?.check();};
      check();
      const prefix=new Set<NameOcrRecipe>();
      const finishQuick=(reading:NameReading|null)=>{
        if(!execution?.continueQuick)return true;
        if(execution.continueQuick(reading)){check();return true;}
        // Resume this SAME label/offset/recipe execution. No raw pixels or
        // provider outputs survive this match call, and no new reading is
        // manufactured for the already-executed prefix.
        check();quick=false;bypassCache=true;
        execution.metrics.continued++;aggregate.continued++;
        for(const recipe of prefix)update(execution.metrics,recipe,'reusedRequests');
        return false;
      };
      const readNeural=async(recipe:NameOcrRecipe,canvas:HTMLCanvasElement,useLexicon:boolean,nameLine?:import('./neural-reader').NameLine)=>{
        check();const started=performance.now();if(execution)update(execution.metrics,recipe,'requests');
        try{const reading=await neural.recognize(canvas,useLexicon,nameLine,budget);check();
          if(recipe.startsWith('raw-'))prefix.add(recipe);return reading;
        }catch(error){if(execution)update(execution.metrics,recipe,'failedRequests');throw error;}
        finally{if(execution)update(execution.metrics,recipe,'wallAwaitMs',Math.max(0,performance.now()-started));}
      };
      const label = document.createElement("canvas");
      let rawCrop:HTMLCanvasElement|undefined;
      try {
      label.width = 128;
      label.height = 36;
      const context = label.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(
        source,
        (6 * source.width) / 140,
        ((14 + offsetY) * source.height) / 210,
        (128 * source.width) / 140,
        (36 * source.height) / 210,
        0,
        0,
        128,
        36,
      );
      const rgba = context.getImageData(0, 0, 128, 36).data;
      // Reuse this existing read-only array. The label canvas is overwritten by
      // later fallback masks, so reading it after match() would be misleading.
      if(observeLabel)observeNameLabel(observeLabel,{width:128,height:36,data:rgba},{
        region:'initial-name-label',sourceBox:{x:6*source.width/140,y:(14+offsetY)*source.height/210,
          width:128*source.width/140,height:36*source.height/210},
        targetWidth:128,targetHeight:36,offsetY,quick,allowRaw,bypassCache,
      });
      check();
      let hash = 2166136261;
      for (const value of rgba) hash = Math.imul(hash ^ value, 16777619);
      const fingerprint = (hash >>> 0).toString(16);
      const diagnostics = (rawText: string, engine: "paddle" | "tesseract") => ({
        rawText, engine, complete: allowRaw, readingId: crypto.randomUUID(), fingerprint,
      });
      const gray = Float32Array.from(
        { length: 128 * 36 },
        (_, i) =>
          0.299 * rgba[i * 4] +
          0.587 * rgba[i * 4 + 1] +
          0.114 * rgba[i * 4 + 2],
      );
      const contrast = new Uint8Array(128 * 36);
      for (let y = 0; y < 36; y++)
        for (let x = 0; x < 128; x++) {
          let dark = 255;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
              if (y + dy >= 0 && y + dy < 36 && x + dx >= 0 && x + dx < 128)
                dark = Math.min(dark, gray[(y + dy) * 128 + x + dx]);
          contrast[y * 128 + x] = Number(
            dark < 100 && gray[y * 128 + x] - dark >= 45,
          );
        }
      const makeMasks = (strong: boolean) =>
        Array.from({ length: 5 }, (_, grade) => {
          const mask = strong
            ? strongNameMask(rgba, grade)
            : nameMask(rgba, grade).map((v, i) => v & contrast[i]);
          return { grade, mask, ...packName(mask) };
        })
          .filter((m) => m.pixels >= 35 && m.pixels <= 1300)
          .sort(
            (a, b) =>
              b.mask.slice(0, 128 * 18).reduce((n, v) => n + v, 0) -
              a.mask.slice(0, 128 * 18).reduce((n, v) => n + v, 0),
          )
          .slice(0, 3);
      const strong = makeMasks(true),
        outlined = makeMasks(false),
        masks = [...strong, ...outlined];
      if (!masks.length && !allowRaw) {
        onAttempt?.({text:'',confidence:0,engine:'quality',variant:'이름 영역 사전 검사',
          reason:'이름 마스크 픽셀 부족 · OCR 미실행',candidates:[]});
        label.width = 0;
        if(quick&&execution?.continueQuick)finishQuick(null);
        return null;
      }
      rawCrop = document.createElement("canvas");
        for (const packed of masks) {
          const bands = new Map(
            [16, 18, 36].map((height) => [
              height,
              {
                bits: packed.bits.subarray(0, height * 4),
                pixels: packed.mask
                  .subarray(0, height * 128)
                  .reduce((n, v) => n + v, 0),
              },
            ]),
          );
          const previous = cache.find((c) => {
            if (c.grade !== packed.grade) return false;
            const band = bands.get(c.height)!;
            return (
              nameSimilarity(band.bits, band.pixels, c.bits, c.pixels) > 0.985
            );
          });
          if (previous) {
            const reusable=confirmCatalogName(previous.result,false);
            onAttempt?.({text:previous.result.rawText,confidence:previous.result.ocrConfidence,engine:'cache',
              variant:'이름 마스크 캐시',reason:bypassCache?'전체 재시도 · 새 OCR을 위해 캐시 우회':
                reusable?'확정 이름 캐시 재사용':'독립 식별 근거 부족 · 캐시 미사용',
              candidates:[{id:previous.result.card.id,name:previous.result.card.name,score:previous.result.score}]});
            if(!bypassCache&&reusable){const reading={ ...previous.result, complete: allowRaw };
              if(!quick||finishQuick(reading)){check();return reading;}}
          }
        }
        // Raw glyphs survive video compression better than saturation masks.
        rawCrop.width = 128;
        rawCrop.height = 18;
        const rawContext = rawCrop.getContext("2d")!;
        let variant = "원본 첫 줄";
        const primaryMatch = (text: string, confidence: number) => {
          if (confidence < 0.5 || /[ㄱ-ㅎㅏ-ㅣ]/.test(text)) {
            if (onAttempt) onAttempt(nameAttempt(text, confidence * 100, "paddle", variant, cards, false));
            return null;
          }
          let result = matchCardName(text, cards);
          if (!result)
            for (const packed of masks) {
              result = matchCardName(
                text,
                cards.filter((c) => c.rarity === packed.grade),
              );
              if (result) break;
            }
          if (!result && /[A-Za-z0-9]/.test(text)) {
            const clean = text.replace(/[A-Za-z0-9]/g, "");
            if (text.length - clean.length <= 3)
              result = matchCardName(
                clean,
                cards.filter((c) => !/[A-Za-z0-9]/.test(c.name)),
              );
          }
          if (onAttempt) onAttempt(nameAttempt(text, confidence * 100, "paddle", variant, cards, !!result));
          return result ? { ...result, ocrConfidence: confidence * 100, ...diagnostics(text, "paddle") } : null;
        };
        const lexiconMatch = (data: import("./neural-reader").NeuralReading) => {
          const result = matchCtcCardName(data, cards);
          return result ? { ...result, ocrConfidence: data.confidence * 100, ...diagnostics(data.text, "paddle") } : null;
        };
        type Reading = NonNullable<ReturnType<typeof primaryMatch>> | NonNullable<ReturnType<typeof lexiconMatch>>;
        const confirmedReading = (reading: Reading) => confirmCatalogName({ ...reading,
          ctc: "ctc" in reading ? reading.ctc : undefined }, false);
        let fallback: Reading | undefined, fallbackHeight = 18;
        const retainCandidate = (reading: Reading, height: number) => {
          if (!fallback || reading.score > fallback.score ||
              (reading.score === fallback.score && reading.ocrConfidence > fallback.ocrConfidence)) {
            fallback = reading; fallbackHeight = height;
          }
        };
        const rememberName = (
          reading: NonNullable<ReturnType<typeof primaryMatch>> & { preprocessing?: "soft-rarity" },
          height: number,
        ) => {
          check();
          const grade = cards.find((c) => c.name === reading.card.name)?.rarity;
          const packed = masks.find((m) => m.grade === grade);
          // Partial names may share identical glyphs. Their artwork must be
          // checked on every capture, not reused from the name-mask cache.
          // A plausible dictionary correction can still fail the recognizer's
          // independent identity check. Caching it would make every full retry
          // return that same rejected hypothesis without running new OCR.
          if (packed && confirmCatalogName(reading,false) && !("artwork" in reading && reading.artwork)) {
            cache.push({
              bits: packed.bits.slice(0, height * 4),
              pixels: packed.mask
                .subarray(0, height * 128)
                .reduce((n, v) => n + v, 0),
              height,
              grade: packed.grade,
              result: reading,
            });
            if (cache.length > 512) cache.shift();
          }
          return reading;
        };
        let firstText = "",
          firstConfidence = 0;
        for (const y of [0, 18]) {
          variant = y === 0 ? "원본 첫 줄" : "원본 두 줄 결합";
          rawContext.clearRect(0, 0, 128, 18);
          rawContext.drawImage(label, 0, y, 128, 18, 0, 0, 128, 18);
          const data = await readNeural(y===0?'raw-first-line':'raw-second-line',rawCrop,y===0,{ group: fingerprint, line: y === 0 ? 0 : 1 });
          if (y === 0) {
            firstText = data.text;
            firstConfidence = data.confidence;
            const result = primaryMatch(data.text, data.confidence) ?? lexiconMatch(data);
            if (result) {
              if ((quick&&finishQuick(result)) || (!quick&&confirmedReading(result))) {
                rawCrop.width = 0;
                return rememberName(result, 18);
              }
              retainCandidate(result, 18);
            }
          } else {
            const result = primaryMatch(
              firstText + data.text,
              Math.min(firstConfidence, data.confidence),
            ) ?? (data.joined ? lexiconMatch(data.joined) : null);
            if (result) {
              if ((quick&&finishQuick(result)) || (!quick&&confirmedReading(result))) {
                rawCrop.width = 0;
                return rememberName(result, 36);
              }
              retainCandidate(result, 36);
            }
          }
        }
        rawCrop.width = 0;
        variant = "원본 전체 이름 영역";
        const full = await readNeural('raw-full-label',label,true),
          fullResult = primaryMatch(full.text, full.confidence) ?? lexiconMatch(full);
        if (fullResult) {
          if ((quick&&finishQuick(fullResult)) || (!quick&&confirmedReading(fullResult))) return rememberName(fullResult, 36);
          retainCandidate(fullResult, 36);
        }
        const artworkCanvas = document.createElement("canvas");
        artworkCanvas.width = 24;
        artworkCanvas.height = 32;
        const artworkContext = artworkCanvas.getContext("2d", { willReadFrequently: true })!;
        artworkContext.imageSmoothingQuality = "high";
        artworkContext.drawImage(source, 0, 0, 24, 32);
        const artworkPixels = artworkContext.getImageData(0, 0, 24, 32).data;
        let artworkConfidence = firstConfidence;
        let corroborated = verifyArtwork(artworkPixels, firstText, artworkConfidence);
        if (!corroborated) {
          artworkConfidence = full.confidence;
          corroborated = verifyArtwork(artworkPixels, full.text, artworkConfidence);
        }
        artworkCanvas.width = 0;
        if (corroborated){const reading={ ...corroborated,
          ocrConfidence: artworkConfidence * 100, ...diagnostics(corroborated.artwork.visiblePrefix, "paddle") };
          // The full algorithm returns the same artwork result at this point.
          // A rejected quick result does not authorize additional field proof.
          if(quick)finishQuick(reading);return rememberName(reading,36);}
        if(quick&&execution?.continueQuick&&finishQuick(fallback??null))return fallback?rememberName(fallback,fallbackHeight):null;
        // An opt-in full retry may test one achromatic first line, after raw
        // text/artwork have failed. Keep the same attempt budget and require an
        // exact greedy name; correlated preprocessing is not a new observation.
        if(allowGrayNameFallback&&!quick&&bypassCache){
          budget?.check();
          const grayFirst=document.createElement('canvas');grayFirst.width=128;grayFirst.height=18;
          try{
            grayFirst.getContext('2d')!.putImageData(new ImageData(createGrayNameFirstLine(rgba),128,18),0,0);
            budget?.check();variant=NAME_GRAY_FIRST_RECIPE;
            const data=await readNeural('gray-first-line',grayFirst,false);
            const result=primaryMatch(data.text,data.confidence);
            if(result?.exact&&normalizeName(data.text)===normalizeName(result.card.name)&&confirmCatalogName(result,false)){
              check();return {...result,preprocessing:NAME_GRAY_FIRST_RECIPE};}
            // Do not retain/cache a gray hypothesis or displace a raw fallback.
          }finally{grayFirst.width=0;grayFirst.height=0;}
        }
        if(options.contrastNameFallback&&!quick&&bypassCache){
          budget?.check();
          const target=document.createElement('canvas');target.width=128;target.height=18;
          try{
            const pixels=nameLabelContrast(rgba,'stretch-first-v1');
            target.getContext('2d')!.putImageData(new ImageData(pixels.data,128,18),0,0);
            budget?.check();variant='stretch-first-v1';
            const data=await readNeural('stretch-first-v1',target,false);
            const result=primaryMatch(data.text,data.confidence);
            if(result?.exact&&normalizeName(data.text)===normalizeName(result.card.name)&&confirmCatalogName(result,false)){
              check();return {...result,preprocessing:'stretch-first-v1'};}
          }finally{target.width=0;target.height=0;}
        }
        if (quick || !masks.length) return fallback ? rememberName(fallback, fallbackHeight) : null;
        // Bound expensive retries to retained failed crops. Preserve source
        // luminance; binary masks can erase the anti-aliased Hangul strokes.
        const soft = document.createElement("canvas");
        soft.width = 128;
        soft.height = 18;
        const softContext = soft.getContext("2d")!;
        try {
          for (const grade of [...new Set(masks.map(mask => mask.grade))].slice(0, 3)) {
            const pixels = softNamePixels(rgba, grade).subarray(0, 128 * 18 * 4);
            for (const [index, transformed] of [new Uint8ClampedArray(pixels), normalizeSoftNamePixels(new Uint8ClampedArray(pixels))].entries()) {
              variant = index === 0 ? `등급 ${grade} 배경 제거` : `등급 ${grade} 배경 제거 · 밝기 정규화`;
              softContext.putImageData(new ImageData(transformed, 128, 18), 0, 0);
              const data = await readNeural(`soft-grade-${grade}-${index===0?'original':'normalized'}` as NameOcrRecipe,soft,true);
              const result = primaryMatch(data.text, data.confidence) ?? lexiconMatch(data);
              if(result)retainCandidate(result,18);
              const confirmed = result && confirmCatalogName({ ...result,
                ctc: "ctc" in result ? result.ctc as NameMatchEvidence["ctc"] : undefined }, false) ? result : null;
              const art = confirmed ? null : verifyArtwork(artworkPixels, data.text, data.confidence);
              // Failed preprocessing must not bypass the existing fallback or
              // relax the identity thresholds. Only confirmed evidence returns.
              if (confirmed || art) return rememberName({ ...(confirmed ?? { ...art!, ocrConfidence: data.confidence * 100,
                ...diagnostics(data.text, "paddle") }), preprocessing: "soft-rarity" as const }, art ? 36 : 18);
            }
          }
        } finally { soft.width = 0; }
        // A valid but unconfirmed raw candidate remains reviewable if the
        // bounded neural retries cannot strengthen it. Do not cache it.
        if (fallback) return rememberName(fallback, fallbackHeight);
        const passes = [
          { masks: strong, psm: "7", heights: [16, 18] },
          { masks: strong, psm: "6", heights: [36] },
          { masks: outlined, psm: "6", heights: [18, 36] },
          { masks: outlined, psm: "11", heights: [18, 36] },
        ];
        for (const pass of passes) {
          check();
          await parameters('kor',pass.psm as PSM,budget);
          check();
          for (const height of pass.heights)
            for (const packed of pass.masks) {
              const image = context.createImageData(128, 36);
              for (let i = 0; i < packed.mask.length; i++) {
                const v = packed.mask[i] ? 0 : 255;
                image.data.set([v, v, v, 255], i * 4);
              }
              context.putImageData(image, 0, 0);
              const trimmed = document.createElement("canvas");
              trimmed.width = 128;
              trimmed.height = height;
              trimmed
                .getContext("2d")!
                .drawImage(label, 0, 0, 128, height, 0, 0, 128, height);
              const enlarged = enlarge(trimmed, true);
              trimmed.width = 0;
              try {
                check();
                const data = await recognize(enlarged, "kor",budget);
                check();
                // Incomplete Hangul fragments are not complete name evidence.
                const result = /[ㄱ-ㅎㅏ-ㅣ]/.test(data.text)
                  ? null
                  : matchCardName(
                      data.text,
                      cards.filter((card) => card.rarity === packed.grade),
                    );
                if (onAttempt) onAttempt(nameAttempt(data.text, data.confidence, "tesseract", `마스크 ${packed.grade} · ${height}px`, cards, !!result));
                if (result) {
                  const reading = { ...result, ocrConfidence: data.confidence, ...diagnostics(data.text, "tesseract") };
                  const bits = packed.bits.slice(0, height * 4),
                    pixels = packed.mask
                      .subarray(0, height * 128)
                      .reduce((n, v) => n + v, 0);
                  if (confirmCatalogName(reading,false)) cache.push({
                    bits,
                    pixels,
                    height,
                    grade: packed.grade,
                    result: reading,
                  });
                  if (cache.length > 512) cache.shift();
                  return reading;
                }
              } finally {
                enlarged.width = 0;
              }
            }
        }
        // A gray crop retains faint strokes lost by color/outline segmentation.
        context.putImageData(
          new ImageData(new Uint8ClampedArray(rgba), 128, 36),
          0,
          0,
        );
        check();
        await parameters('kor','6' as PSM,budget);
        check();
        for (const height of [18, 36]) {
          const trimmed = document.createElement("canvas");
          trimmed.width = 128;
          trimmed.height = height;
          trimmed
            .getContext("2d")!
            .drawImage(label, 0, 0, 128, height, 0, 0, 128, height);
          const enlarged = enlarge(trimmed);
          trimmed.width = 0;
          try {
            check();
            const data = await recognize(enlarged, "kor",budget);
            check();
            const result = /[ㄱ-ㅎㅏ-ㅣ]/.test(data.text)
              ? null
              : matchCardName(data.text, cards);
            if (onAttempt) onAttempt(nameAttempt(data.text, data.confidence, "tesseract", `흑백 원본 · ${height}px`, cards, !!result));
            if (result){check();return { ...result, ocrConfidence: data.confidence, ...diagnostics(data.text, "tesseract") };}
          } finally {
            enlarged.width = 0;
          }
        }
        check();return null;
      } finally {
        label.width = 0;
        if(rawCrop)rawCrop.width = 0;
      }
  }

  async function measuredMatch<T>(operation:(metrics:MutableMetrics)=>Promise<T>,onMetrics?:(metrics:NameOcrMetrics)=>void):Promise<T>{
    const metrics=newMetrics(1);aggregate.invocations++;
    try{return await operation(metrics);}
    catch(error){metrics.invocationFailures++;aggregate.invocationFailures++;throw error;}
    finally{if(onMetrics)try{onMetrics(snapshot(metrics));}catch{/* Optional counters cannot change an OCR outcome. */}}
  }
  function match(source:HTMLCanvasElement,quick=false,offsetY=0,allowRaw=false,onAttempt?:(attempt:NameAttempt)=>void,
    budget?:CardReadBudget,bypassCache=false,observeLabel?:NameLabelObserver,allowGrayNameFallback=false){
    return measuredMatch(metrics=>matchImpl(source,quick,offsetY,allowRaw,onAttempt,budget,bypassCache,observeLabel,allowGrayNameFallback,{metrics}));
  }
  function matchForIdentify(source:HTMLCanvasElement,options:IdentifyNameOptions){
    // Capture all options once. A later call, canvas, offset, reader, or changed
    // provider policy never receives this invocation's continuation.
    const {full=true,offsetY=0,allowRaw=false,onAttempt,budget,observeLabel,allowGrayNameFallback=false,acceptQuick,onMetrics}=options;
    return measuredMatch(async metrics=>{
      let checked=false;
      const accept=(reading:NameReading|null)=>{
        if(checked)throw Error('Name quick result checked more than once');checked=true;
        const accepted=acceptQuick(reading)&&reading!==null;
        if(accepted){metrics.quickAccepted++;aggregate.quickAccepted++;}return accepted;
      };
      // Current fixed WASM requests can opt into one linear execution. An
      // adaptive/nondeterministic provider must keep resample: its later raw
      // request is deliberately a new observation, not an interchangeable one.
      if(full&&rawResultPolicy==='continue')return matchImpl(source,true,offsetY,allowRaw,onAttempt,budget,false,observeLabel,allowGrayNameFallback,{metrics,continueQuick:accept});
      const quick=await matchImpl(source,true,offsetY,allowRaw,onAttempt,budget,false,observeLabel,false,{metrics});
      const accepted=accept(quick);signal?.throwIfAborted();budget?.check();
      return !full||accepted?quick:matchImpl(source,false,offsetY,allowRaw,onAttempt,budget,true,observeLabel,allowGrayNameFallback,{metrics});
    },onMetrics);
  }

  return {
    async ready() {
      await Promise.all([neural.ready(), digits.ready()]);
    },
    async total(source: HTMLCanvasElement) {
      const primary = await digits.recognize(source);
      const total =
        primary.confidence >= 0.7 ? parseInventoryTotal(primary.text) : null;
      if (total) return total;
      const enlarged = enlarge(source);
      try {
        const data = await recognize(enlarged, "eng");
        return data.confidence >= 60 ? parseInventoryTotal(data.text) : null;
      } finally {
        enlarged.width = 0;
      }
    },
    async metadata(points: HTMLCanvasElement, sort: HTMLCanvasElement) {
      const pixels=(canvas:HTMLCanvasElement)=>canvas.getContext('2d',{willReadFrequently:true})!
        .getImageData(0,0,canvas.width,canvas.height);
      // Independent OCR sessions can read together. Successful fields cache
      // separately: an unreadable point total must not re-read a known sort.
      const [pointsResult,sortResult]=await Promise.allSettled([
        pointsCache.read([pixels(points)],async()=>{
          const reading=await digits.recognize(points);
          return reading.confidence>=.7 ? parseGrowthPoints(reading.text) : null;
        }),
        sortCache.read([pixels(sort)],async()=>{
          const reading=await neural.recognize(sort);
          return reading.confidence>=.5 ? parseCardSort(reading.text) : null;
        }),
      ]);
      // Wait for both sessions even on failure before the caller frees crops.
      if(pointsResult.status==='rejected')throw pointsResult.reason;
      if(sortResult.status==='rejected')throw sortResult.reason;
      return {growthPoints:pointsResult.value,sort:sortResult.value};
    },
    async count(source: HTMLCanvasElement, maximum: number, diagnostic?: CountDiagnostics,budget?:CardReadBudget) {
      budget?.check();
      const record = (engine: string, data: { text: string; confidence: number }) => diagnostic?.readings.push({ engine, text: data.text, confidence: data.confidence, value: parseCounterEvidence(data.text, maximum)?.value ?? null });
      const context = source.getContext("2d", { willReadFrequently: true })!;
      const rgba = context.getImageData(0, 0, source.width, source.height);
      const mask = document.createElement("canvas");
      mask.width = source.width;
      mask.height = source.height;
      const maskContext = mask.getContext("2d")!;
      const binary = maskContext.createImageData(source.width, source.height);
      let key = "",
        ink = 0;
      for (let i = 0; i < rgba.data.length; i += 4) {
        const r = rgba.data[i],
          g = rgba.data[i + 1],
          b = rgba.data[i + 2];
        const row = Math.floor(i / 4 / source.width);
        const white =
          row >= 2 &&
          row < 18 &&
          Math.min(r, g, b) > 155 &&
          Math.max(r, g, b) - Math.min(r, g, b) < 85;
        const value = white ? 0 : 255;
        binary.data.set([value, value, value, 255], i);
        key += white ? "1" : "0";
        ink += Number(white);
      }
      if (ink < 12) {
        if (diagnostic) diagnostic.reason = "숫자 획 부족";
        mask.width = 0;
        return null;
      }
      // The mask selects a bucket only. Raw and tight OCR also consume color
      // pixels: equal masks cannot authorize reuse across changed raw input.
      let bucket = 2166136261;
      for (let i = 0; i < key.length; i++) bucket = Math.imul(bucket ^ key.charCodeAt(i), 16777619) >>> 0;
      const cacheKey = `${source.width}:${source.height}:${maximum}:${key}`;
      const previous = counters.get(bucket, cacheKey, rgba.data);
      if (previous !== undefined) {
        if (diagnostic) {
          diagnostic.reason = previous <= maximum ? "캐시 판독" : "각성별 장수 상한 초과";
          if (previous <= maximum) diagnostic.ocrConfirmedValue = previous;
        }
        mask.width = 0;
        return previous <= maximum ? previous : null;
      }
      maskContext.putImageData(binary, 0, 0);
      const tight = document.createElement("canvas");
      tight.width = 34;
      tight.height = 16;
      tight.getContext("2d")!.drawImage(mask, 6, 2, 34, 16, 0, 0, 34, 16);
      const rawTight = document.createElement("canvas");
      rawTight.width = 34;
      rawTight.height = 16;
      rawTight.getContext("2d")!.drawImage(source, 6, 2, 34, 16, 0, 0, 34, 16);
      let first:import('./neural-reader').NeuralReading,second:import('./neural-reader').NeuralReading;
      try {first=await digits.recognize(source,false,undefined,budget);second=await digits.recognize(rawTight,false,undefined,budget);}
      catch(error){mask.width=0;tight.width=0;throw error;}
      finally{rawTight.width=0;}
      record("PP-OCRv6 전체", { text: first.text, confidence: first.confidence * 100 });
      record("PP-OCRv6 숫자 영역", { text: second.text, confidence: second.confidence * 100 });
      rawTight.width = 0;
      const readings: CounterReading[] = [
        { engine: "neural", variant: "raw", text: first.text, confidence: first.confidence * 100 },
        { engine: "neural", variant: "tight", text: second.text, confidence: second.confidence * 100 },
      ];
      const remember = (count: number) => {
        if (diagnostic) {
          diagnostic.reason = "숫자 근거 일치로 확정";
          diagnostic.ocrConfirmedValue = count;
        }
        counters.set(bucket, cacheKey, rgba.data, count);
        return count;
      };
      let agreed = confirmCounter(readings, maximum);
      if (agreed !== null) {
        mask.width = 0;
        tight.width = 0;
        return remember(agreed);
      }
      // One additional achromatic crop can corroborate the tight reading when
      // colored artwork caused a spurious digit in the full strip.
      let masked:import('./neural-reader').NeuralReading;
      try{masked=await digits.recognize(tight,false,undefined,budget);}
      catch(error){mask.width=0;tight.width=0;throw error;}
      record("PP-OCRv6 흰 숫자", { text: masked.text, confidence: masked.confidence * 100 });
      readings.push({ engine: "neural", variant: "mask", text: masked.text, confidence: masked.confidence * 100 });
      agreed = confirmCounter(readings, maximum);
      if (agreed !== null) {
        mask.width = 0;
        tight.width = 0;
        return remember(agreed);
      }
      try {
        for (const [canvas, isBinary] of [
          [tight, true],
          [mask, true],
          [source, false],
        ] as const) {
          const enlarged = enlarge(canvas, isBinary);
          try {
            const data = await recognize(enlarged, "eng",budget);
            record("Tesseract", data);
            readings.push({ engine: "tesseract", variant: canvas === tight ? "tight" : canvas === mask ? "mask" : "raw", text: data.text, confidence: data.confidence });
            const count = confirmCounter(readings, maximum);
            if (count !== null) return remember(count);
          } finally {
            enlarged.width = 0;
          }
        }
        // Strict achromatic strokes remove colored artwork behind white digits.
        // These correlated threshold variants need a strong OCR score individually.
        for (const delta of [20, 10, 35]) {
          for (let i = 0; i < rgba.data.length; i += 4) {
            const r = rgba.data[i],
              g = rgba.data[i + 1],
              b = rgba.data[i + 2],
              row = Math.floor(i / 4 / source.width);
            const white =
              row >= 2 &&
              row < 18 &&
              Math.min(r, g, b) > 155 &&
              Math.max(r, g, b) - Math.min(r, g, b) < delta;
            const v = white ? 0 : 255;
            binary.data.set([v, v, v, 255], i);
          }
          maskContext.putImageData(binary, 0, 0);
          tight.getContext("2d")!.clearRect(0, 0, 34, 16);
          tight.getContext("2d")!.drawImage(mask, 6, 2, 34, 16, 0, 0, 34, 16);
          const enlarged = enlarge(tight, true);
          try {
            const data = await recognize(enlarged, "eng",budget);
            record("Tesseract 획 분리", data);
            readings.push({ engine: "tesseract", variant: `threshold-${delta}`, text: data.text, confidence: data.confidence });
            const count = confirmCounter(readings, maximum);
            if (count !== null) return remember(count);
          } finally {
            enlarged.width = 0;
          }
        }
        if (diagnostic) diagnostic.reason = readings.filter(r => r.engine === "neural" && r.confidence >= 70).every(r => parseCounterEvidence(r.text, maximum) === null)
          ? "PP-OCRv6에서 신뢰도 70% 이상의 유효 숫자 근거 없음"
          : "보조 OCR 불일치 또는 신뢰도 부족";
        return null;
      } finally {
        mask.width = 0;
        tight.width = 0;
      }
    },
    match,
    matchForIdentify,
    nameOcrMetrics:()=>snapshot(aggregate),
    dispose() {
      if(disposal)return disposal;
      disposed = true;
      signal?.removeEventListener('abort', abort);
      const pending=[...engines.values()];engines.clear();
      return disposal=(async()=>{
        const errors=await settleDisposals([()=>neural.dispose(),()=>digits.dispose(),...pending.map(engine=>async()=>{
          let instance:Worker;
          try{instance=await engine;}catch{return;} // Failed initialization already releases its allocated resource.
          await terminateWorker(instance);
        })]);
        if(initializationCleanupError&&!errors.includes(initializationCleanupError.error))errors.push(initializationCleanupError.error);
        if(errors.length)throw new AggregateError(errors,'OCR 자원 종료 실패');
      })();
    },
  };
}
