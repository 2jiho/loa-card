import { drawVisualRaster, inspectVisual, portraitIdentity, readVisual, readFullAwakening } from './visual-fields';
import { observationPixels } from "../acquisition/observation-pixels";
import { confirmCatalogName } from "./name-confidence";
import { normalizeName } from "./card-dictionary";
import { readSortArrow } from "./capture-metadata";
import type { Layout } from "../acquisition/detector";
import type { Box } from "../acquisition/detector";
import { createNameReader } from "./name-reader";
import type {NameOcrMetrics,NameRawResultPolicy,NameReading} from './name-reader';
import { prepareContrastPattern, matchCountPattern, countContrastFloor, countStrongScore, countAgreementScale } from "./count-pattern";
import type { CountPattern } from "./count-pattern";import { nameMask } from "./name-pattern";
import { createPortraitMatcher, screenExtraReferences } from "./portrait-matcher";
import {loadPortraitCompetitors} from './portrait-competitors';
import type {PortraitMatchDiagnostic,PortraitRanking} from './portrait-matcher';
import type {PortraitRankReply,PortraitRankRequest} from './portrait-worker';
import type {PortraitDiagnosticCall,PortraitDiagnostics} from './portrait-diagnostics';
import { areaGray } from "../acquisition/area-gray";
import type {NameLabelObserver} from './recognition-input-observer';
import {loadScannerJson} from '../../../data/catalog';
import {fuseIdentity,fusionIdentitySource,fusionUnresolvedReason} from './identity-fusion';
import type {CountDiagnostics,NameEvidence,Reference} from './recognizer-types';
export type {CountDiagnostics,NameEvidence,Reference,ScannedCard} from './recognizer-types';
export function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
export function crop(
  video: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  box: Box,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.width);
  canvas.height = Math.round(box.height);
  canvas
    .getContext("2d", { willReadFrequently: true })!
    .drawImage(
      video,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  return canvas;
}
let labelCanvas: HTMLCanvasElement | undefined;
export function cardHasLabel(canvas: HTMLCanvasElement) {
  labelCanvas ??= document.createElement("canvas");
  labelCanvas.width = 128;
  labelCanvas.height = 36;
  const ctx = labelCanvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(
    canvas,
    (6 * canvas.width) / 140,
    (14 * canvas.height) / 210,
    (128 * canvas.width) / 140,
    (36 * canvas.height) / 210,
    0,
    0,
    128,
    36,
  );
  const rgba = ctx.getImageData(0, 0, 128, 36).data;
  return Array.from({ length: 5 }, (_, grade) => grade).some(
    (grade) => nameMask(rgba, grade).reduce((n, v) => n + v, 0) >= 35,
  );
}
const observationCache = new WeakMap<HTMLCanvasElement, ReturnType<typeof observationPixels>>();
function canvasObservation(canvas: HTMLCanvasElement) {
  let value = observationCache.get(canvas);
  if (!value) {
    const pixels = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
    value = observationPixels(pixels, canvas.width, canvas.height);
    observationCache.set(canvas, value);
  }
  return value;
}
export function frameFeature(canvas: HTMLCanvasElement): Uint8Array {
  return canvasObservation(canvas).art;
}
/** Card crops are immutable until released. Share the deterministic Worker features. */
export function observationFeature(canvas: HTMLCanvasElement, _art?: Uint8Array) {
  return canvasObservation(canvas).feature;
}
export function sameObservation(a: Uint8Array, b: Uint8Array) {
  return [
    [0, 864, 2.5],
    [864, 2016, 2.5],
    [2016, 2592, 2.5],
    [2592, 3240, 5],
  ].every(
    ([from, to, limit]) =>
      difference(a.subarray(from, to), b.subarray(from, to)) < limit,
  );
}
/** Preserve the existing initialization error precedence while reporting a
 * failed owned-reader disposal separately to diagnostic callers. */
export async function rethrowAfterRecognizerInitFailure(error:unknown,dispose:()=>Promise<void>,onCleanupError?:(error:unknown)=>void):Promise<never>{
  try{await dispose();}catch(cleanupError){
    try{void Promise.resolve(onCleanupError?.(cleanupError)).catch(()=>{});}catch{/* Observer has no authority. */}
    throw cleanupError;
  }
  throw error;
}
/** Until readiness and its status publication both succeed, this factory owns
 * the reader and must dispose it on any failure. */
export async function prepareOwnedRecognizerReader(reader:{ready:()=>Promise<void>;dispose:()=>Promise<void>},signal:AbortSignal|undefined,
  status:()=>void,onCleanupError?:(error:unknown)=>void):Promise<void>{
  try{await reader.ready();signal?.throwIfAborted();status();}
  catch(error){return rethrowAfterRecognizerInitFailure(error,()=>reader.dispose(),onCleanupError);}
}
export async function createRecognizer(status: (message: string) => void, signal?: AbortSignal,
  options:{nameRawResultPolicy?:NameRawResultPolicy;contrastNameFallback?:boolean;onInitializationCleanupError?:(error:unknown)=>void}={}) {
  const nameRawResultPolicy=options.nameRawResultPolicy??'resample';
  if(nameRawResultPolicy!=='resample'&&nameRawResultPolicy!=='continue')throw Error('Invalid name raw-result policy');
  status("카드 이름 사전·OCR 준비 중");
  const initializationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const { cards } = await loadScannerJson<{ cards: Reference[] }>('cards.json', initializationSignal);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const portraitAtlas = await loadScannerJson<Record<string,string>>('artwork-details.json', initializationSignal);
  const screen = await loadScannerJson<{cards:Record<string,string>}>('screen-artwork-details.json', initializationSignal);
  // Further screen references: three cards the others miss, and the 1920x1080 and 0.625-scale
  // (1600x900) renderings of every card.
  const extraReferences = (await Promise.all(['screen-artwork-extra.json','screen-artwork-1080.json','screen-artwork-0625.json'].map(name=>
    loadScannerJson<{cards:Record<string,string[]>}>(name, initializationSignal)))).flatMap(screenExtraReferences);
  const competitors=await loadPortraitCompetitors(import.meta.env.BASE_URL,initializationSignal);
  const matchPortrait = createPortraitMatcher(cards,portraitAtlas,screen.cards,{competitors,extra:extraReferences});
  let refinePortrait:ReturnType<typeof createPortraitMatcher>|undefined;
  const portraits = new WeakMap<HTMLCanvasElement, ReturnType<typeof matchPortrait>>();
  // Ranking a crop against every artwork is the heavy part of the artwork check; a worker does it
  // (portrait-worker.ts) and the check below decides on that ranking exactly as on its own (see the
  // matcher's `rank`). Without workers, or when the worker fails, the crop is ranked here.
  const rankings = new WeakMap<HTMLCanvasElement, PortraitRanking>();
  let rankWorker:Worker|undefined,rankFailed=false,rankId=0;
  const rankReplies=new Map<number,(ranking:PortraitRanking|null)=>void>();
  const endRankWorker=()=>{rankWorker?.terminate();rankWorker=undefined;for(const reply of rankReplies.values())reply(null);rankReplies.clear();};
  function rankElsewhere(gray:Float32Array):Promise<PortraitRanking|null> {
    if(rankFailed||typeof Worker==='undefined')return Promise.resolve(null);
    if(!rankWorker){
      try{rankWorker=new Worker(new URL('./portrait-worker.ts',import.meta.url),{type:'module'});}catch{rankFailed=true;return Promise.resolve(null);}
      rankWorker.onmessage=(event:MessageEvent<PortraitRankReply>)=>{const reply=rankReplies.get(event.data.id);rankReplies.delete(event.data.id);reply?.(event.data.ranking);};
      rankWorker.onerror=()=>{rankFailed=true;endRankWorker();};
    }
    const id=++rankId;
    return new Promise(resolve=>{rankReplies.set(id,resolve);rankWorker!.postMessage({id,gray} satisfies PortraitRankRequest,[gray.buffer]);});
  }
  /** Rank the crop's artwork in the worker before checking it (once per crop). */
  async function rankPortrait(canvas: HTMLCanvasElement) {
    if (portraits.has(canvas) || rankings.has(canvas)) return;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
    const ranking = await rankElsewhere(areaGray(pixels, canvas.width, canvas.height));
    if (ranking) rankings.set(canvas, ranking);
  }
  const cachedPortraitDiagnostics=new WeakMap<HTMLCanvasElement,PortraitMatchDiagnostic>();
  // Each immutable crop owns at most one packet per evaluated path. A cache
  // hit reuses the original measurement and is never a new similarity pass.
  const portraitAttempts=new WeakMap<HTMLCanvasElement,PortraitDiagnosticCall[]>();
  function notePortrait(canvas:HTMLCanvasElement,mode:PortraitDiagnosticCall['mode'],source:PortraitDiagnosticCall['source'],diagnostic:PortraitMatchDiagnostic){
    const attempts=portraitAttempts.get(canvas)??[];
    const entry=Object.freeze({mode,source,diagnostic}),index=attempts.findIndex(old=>old.mode===mode);
    if(index>=0)attempts[index]=entry;else if(attempts.length<3)attempts.push(entry);
    portraitAttempts.set(canvas,attempts);
  }
  function portrait(canvas: HTMLCanvasElement, text?: import("./portrait-matcher").PortraitTextEvidence & { id: string }) {
    if (!text && portraits.has(canvas)) {
      const diagnostic=cachedPortraitDiagnostics.get(canvas);
      if(diagnostic)notePortrait(canvas,'visual','cached',diagnostic);
      return portraits.get(canvas)!;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = matchPortrait(areaGray(pixels, canvas.width, canvas.height), text,diagnostic=>{
      if(!text)cachedPortraitDiagnostics.set(canvas,diagnostic);
      notePortrait(canvas,text?'text':'visual','computed',diagnostic);
    },rankings.get(canvas));
    if (!text) portraits.set(canvas, result);
    return result;
  }
  const stars = await loadScannerJson<{ gray: number[][]; gold: number[][] }>('stars.json', initializationSignal);
  const templates = [stars.gray[0], stars.gold[0]];
  const countAtlas = await loadScannerJson<{ patterns: CountPattern[] }>('counter-patterns.json', initializationSignal);
  const countPatterns = countAtlas.patterns.map(prepareContrastPattern);
  const native = document.createElement("canvas");
  native.width = 140;
  native.height = 210;
  const context = native.getContext("2d", { willReadFrequently: true })!;
  const inspected = new WeakMap<HTMLCanvasElement,ReturnType<typeof inspectVisual>>();
  const nameAttempts = new WeakMap<HTMLCanvasElement, import("./name-diagnostics").NameAttempt[]>();
  const namePerformances=new WeakMap<HTMLCanvasElement,NameOcrMetrics>();
  function inspect(canvas: HTMLCanvasElement) {
    const previous = inspected.get(canvas);
    if (previous) return previous;
    const result = inspectVisual(canvas, context, templates);
    inspected.set(canvas, result);
    return result;
  }
  signal?.throwIfAborted();
  const reader = createNameReader(cards, status, signal,{rawResultPolicy:nameRawResultPolicy,contrastNameFallback:options.contrastNameFallback,
    onInitializationCleanupError:options.onInitializationCleanupError});
  await prepareOwnedRecognizerReader(reader,signal,()=>status("이름·장수 OCR / 각성 보석 인식 준비 완료"),options.onInitializationCleanupError);
  return {
    async inspect(canvas: HTMLCanvasElement) {
      return inspect(canvas);
    },
    catalog: cards,
    portrait,
    /** Evidence-only portrait check for a fixed-grid rescue crop. It cannot
     * confirm a card: callers may record the match, never publish an identity. */
    matchArtworkGray(gray: ArrayLike<number>) {
      const artwork = matchPortrait(gray);
      return artwork ? { id: artwork.card.id, name: artwork.card.name,
        correlation: artwork.portrait.correlation, margin: artwork.portrait.margin } : null;
    },
    identifyVisual(canvas: HTMLCanvasElement) {
      portraitAttempts.set(canvas,[]);
      const artwork = portrait(canvas);
      return artwork ? portraitIdentity(artwork) : null;
    },
    nameDiagnostics(canvas: HTMLCanvasElement) { return nameAttempts.get(canvas)?.slice() ?? []; },
    portraitDiagnostics(canvas:HTMLCanvasElement):PortraitDiagnostics|null {
      const attempts=portraitAttempts.get(canvas);
      return attempts?Object.freeze(attempts.slice()):null;
    },
    namePerformance(canvas:HTMLCanvasElement){return namePerformances.get(canvas);},
    nameOcrMetrics:()=>reader.nameOcrMetrics(),
    /** Final, bounded name-only re-read of a retained crop. It does not inspect
     * fields or publish a card; the caller must classify an exact match as a
     * duplicate only after the full inventory is confirmed. */
    async matchFinalName(canvas: HTMLCanvasElement) {
      const fields = inspect(canvas);
      const attempts: import("./name-diagnostics").NameAttempt[] = [];
      nameAttempts.set(canvas, attempts);
      return reader.matchForIdentify(canvas, {full:true, offsetY:fields.offsetY, allowRaw:true,
        acceptQuick:()=>true, onAttempt:attempt=>attempts.push(attempt)});
    },
    async identify(canvas: HTMLCanvasElement, full = true, captureStable = false, structural = false,budget?:import('./card-read-budget').CardReadBudget,allowPortraitRefinement=false,observeLabel?:NameLabelObserver,allowGrayNameFallback=false) {
      const attempts: import("./name-diagnostics").NameAttempt[] = [];
      nameAttempts.set(canvas, attempts);
      namePerformances.delete(canvas);
      portraitAttempts.set(canvas,[]);
      // Even a timeout at entry belongs to this invocation, never to the
      // previous short/full read of the same retained canvas.
      budget?.check();
      const fields = inspect(canvas);
      await rankPortrait(canvas);
      const artwork = portrait(canvas);
      if (artwork) return portraitIdentity(artwork);
      // The fast visual lanes keep the integer-only matcher. Spend the extra
      // registration work only on an explicitly admitted full retry,
      // before that retry starts its substantially longer OCR work.
      if(full&&allowPortraitRefinement&&structural){
        budget?.check();
        const pixels=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;
        const refined=(refinePortrait??=createPortraitMatcher(cards,portraitAtlas,screen.cards,{fractionalRegistration:true,competitors,extra:extraReferences}))(
          areaGray(pixels,canvas.width,canvas.height),undefined,diagnostic=>notePortrait(canvas,'refined','computed',diagnostic));
        budget?.check();
        if(refined)return portraitIdentity(refined);
      }
      const rejectBeforeOcr=(reason:string)=>{attempts.push({text:'',confidence:0,engine:'quality',
        variant:'이름 영역 사전 검사',reason,candidates:[]});return null;};
      if (fields.blankName) return rejectBeforeOcr('이름 첫 줄이 가려짐 · OCR 미실행');
      if (fields.labelPixels < 35 && !structural) return rejectBeforeOcr('이름 픽셀 부족 · OCR 미실행');
      const onAttempt = (attempt: import("./name-diagnostics").NameAttempt) => {
        attempts.push(attempt);
        if (attempts.length > 24) attempts.splice(8, 1);
      };
      const corroborate = (reading: NonNullable<Awaited<ReturnType<typeof reader.match>>>) =>
        !confirmCatalogName(reading, captureStable) ? portrait(canvas, 'nameAmbiguous' in reading && reading.nameAmbiguous ? undefined : { id: reading.card.id, rawText: reading.rawText,
          complete: reading.complete, canonicalName: reading.card.name,
          ocrConfidence: reading.ocrConfidence, score: reading.score, gap: reading.gap }) : null;
      let quickReading:NameReading|null|undefined,quickCorroborated:ReturnType<typeof portrait>|null=null;
      const text=await reader.matchForIdentify(canvas,{full,offsetY:fields.offsetY,allowRaw:structural,onAttempt,budget,observeLabel,allowGrayNameFallback,
        acceptQuick:reading=>{
          quickReading=reading;quickCorroborated=reading?corroborate(reading):null;
          return !!reading&&(confirmCatalogName(reading,captureStable)||!!quickCorroborated);
        },onMetrics:metrics=>{namePerformances.set(canvas,metrics);}});
      const corroborated=text===quickReading?quickCorroborated:text?corroborate(text):null;
      if (!text) return null;
      const nameEvidence = [{ rawText: text.rawText, complete: text.complete, normalizedText: normalizeName(text.rawText), engine: text.engine,
        readingId: text.readingId, fingerprint: text.fingerprint,
        ocrConfidence: text.ocrConfidence, score: text.score, gap: text.gap, exact: text.exact,
        ...('nameAmbiguous' in text ? {nameAmbiguous: text.nameAmbiguous} : {}),
        preprocessing: "preprocessing" in text ? text.preprocessing as NameEvidence["preprocessing"] : undefined,
        artwork: "artwork" in text ? text.artwork as NameEvidence["artwork"] : undefined,
        ctc: "ctc" in text ? text.ctc as NameEvidence["ctc"] : undefined,
        ...(corroborated ? {portrait: corroborated.portrait} : {}) }];
      const decision = fuseIdentity({
        card: text.card,
        exact: text.exact,
        ...('nameAmbiguous' in text ? {nameAmbiguous: text.nameAmbiguous} : {}),
        score: text.score,
        gap: text.gap,
        ocrConfidence: text.ocrConfidence,
        complete: text.complete,
        rawText: text.rawText,
        ...('artwork' in text ? {artwork: text.artwork as NameEvidence["artwork"]} : {}),
        ...('ctc' in text ? {ctc: text.ctc as NameEvidence["ctc"]} : {}),
      }, corroborated ? {card: corroborated.card, portrait: corroborated.portrait} : null, {stable: captureStable, artworkAccepted: !!corroborated});
      if (decision.kind === 'unresolved') {
        for (const attempt of attempts) if (attempt.text === text.rawText)
          attempt.reason = fusionUnresolvedReason(decision);
        return null;
      }
      if (decision.source !== 'name' && corroborated && corroborated.card.id === decision.card.id) {
        return {...portraitIdentity(corroborated), nameEvidence};
      }
      return {
        id: decision.card.id,
        name: decision.card.name,
        confidence: text.score,
        nameEvidence,
        review: decision.review,
        identitySource: fusionIdentitySource(decision),
        maxAwakening: text.card.maxAwakening,
      };
    },
    async total(
      source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
      box: Box,
      _allowText = true,
    ) {
      const header = crop(source, box);
      try {
        return await reader.total(header);
      } finally {
        header.width = 0;
      }
    },
    async metadata(
      source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
      layout: Layout,
    ) {
      const points = crop(source, layout.growthPoints),
        sort = crop(source, layout.sort);
      try {
        const result = await reader.metadata(points, sort);
        const arrow = document.createElement("canvas");
        arrow.width = 30;
        arrow.height = 30;
        arrow
          .getContext("2d")!
          .drawImage(
            sort,
            (sort.width * 170) / 210,
            (sort.height * 5) / 40,
            (sort.width * 30) / 210,
            (sort.height * 30) / 40,
            0,
            0,
            30,
            30,
          );
        const direction = readSortArrow(
          arrow.getContext("2d")!.getImageData(0, 0, 30, 30).data,
          30,
          30,
        );
        arrow.width = 0;
        if (result.sort && direction !== "unknown")
          result.sort.direction = direction;
        return result;
      } finally {
        points.width = 0;
        sort.width = 0;
      }
    },
    async read(canvas: HTMLCanvasElement, id?: string, corroborate = false, allowOcr = true,budget?:import('./card-read-budget').CardReadBudget) {
      budget?.check();
      if (!allowOcr) return readVisual(canvas, context, inspect(canvas), countPatterns, id ? byId.get(id)?.maxAwakening : undefined);
      if (id && byId.get(id)?.maxAwakening === 0)
        return { awakening: 0, extraCopies: 0 };
      const fields = inspect(canvas),
        level = fields.awakening;
      const full = readFullAwakening(canvas, context, fields, countPatterns);
      if (full) return full;
      if (fields.hasIcon === false)
        return { awakening: level, extraCopies: level === null ? null : 0,
          countDiagnostics: { maximum: level === null ? 15 : 15 - level * (level + 1) / 2,
            reason: fields.emptyEvidence ? '회색 카드 표식 · 빈 장수 배경 확인'+(level===null?' · 각성 영역 미확정':' · 0장 후보')
              : level === null ? "추가 카드 표시 없음 · 각성 영역 미확정" : "추가 카드 표시 없음 · 0장 후보",
            readings: [], iconPresent: false,...(fields.emptyEvidence?{emptyEvidence:fields.emptyEvidence}:{}) } satisfies CountDiagnostics };
      const maximum = level === null ? 15 : 15 - (level * (level + 1)) / 2;
      drawVisualRaster(canvas, context);
      const pattern = matchCountPattern(context.getImageData(0, 0, 140, 210).data, countPatterns, fields.offsetY, maximum, true, countContrastFloor(canvas.width), countStrongScore(canvas.width), countAgreementScale(canvas.width));
      const diagnostic: CountDiagnostics = { maximum, reason: fields.hasIcon === null ? '장수 숫자 미검출 또는 불명확' : pattern.reason, readings: [], pattern, iconPresent: fields.hasIcon ?? undefined };
      if (pattern.value !== null && !corroborate)
        return { awakening: level, extraCopies: pattern.value, countDiagnostics: diagnostic };
      if (!allowOcr)
        return { awakening: level, extraCopies: null, countDiagnostics: diagnostic };
      if (pattern.reason === "각성별 장수 상한 초과")
        return { awakening: level, extraCopies: null, countDiagnostics: diagnostic };
      const strip = document.createElement("canvas");
      strip.width = 48;
      strip.height = 20;
      strip
        .getContext("2d")!
        .drawImage(
          canvas,
          (90 * canvas.width) / 140,
          ((144 + fields.offsetY) * canvas.height) / 210,
          (48 * canvas.width) / 140,
          (20 * canvas.height) / 210,
          0,
          0,
          48,
          20,
        );
      try {
        const digitValue = await reader.count(strip, maximum, diagnostic,budget);
        if (pattern.value !== null) {
          diagnostic.patternOcrAgreed = digitValue === pattern.value;
          diagnostic.reason = digitValue === pattern.value ? "숫자 패턴과 독립 숫자 OCR 일치"
            : digitValue === null ? "숫자 OCR 보강 근거 부족" : "숫자 패턴과 숫자 OCR 불일치";
        } else if (pattern.candidate !== null && digitValue === pattern.candidate &&
          // Full-screen thresholds scaled for the crop size (countAgreementScale): score 0.30 and
          // gap 0.035 at full screen, 0.22/0.026 for wider resampled crops, 0.12/0.014 below 100 px.
          Number.isFinite(pattern.score) && pattern.score >= .30 * countAgreementScale(canvas.width) &&
          Number.isFinite(pattern.gap) && pattern.gap >= .035 * countAgreementScale(canvas.width)) {
          // A strong single-digit candidate can be corroborated even when a
          // trailing artwork stroke kept the template result null.
          diagnostic.patternOcrAgreed = true;
          diagnostic.reason = "숫자 후보와 독립 숫자 OCR 일치";
        }
        return {
          awakening: level,
          extraCopies: pattern.value ?? digitValue,
          countDiagnostics: diagnostic,
        };
      } finally {
        strip.width = 0;
      }
    },
    async dispose() {
      native.width = 0;
      endRankWorker();
      await reader.dispose();
    },
  };
}
