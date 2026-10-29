import { inspectVisual, portraitIdentity, readVisual, readFullAwakening } from './visual-fields';
import { observationPixels } from "./observation-pixels";
import { confirmName, confirmCatalogName } from "./name-confidence";
import { normalizeName } from "./card-dictionary";
import { readSortArrow } from "./capture-metadata";
import type { Layout } from "./detector";
import type { Box } from "./detector";
import { createNameReader } from "./name-reader";
import type {NameOcrMetrics,NameRawResultPolicy,NameReading} from './name-reader';
import { prepareContrastPattern, matchCountPattern } from "./count-pattern";
import type { CountPattern, CountPatternReading } from "./count-pattern";
import { nameMask } from "./name-pattern";
import { createPortraitMatcher } from "./portrait-matcher";
import type {PortraitMatchDiagnostic} from './portrait-matcher';
import type {PortraitDiagnosticCall,PortraitDiagnostics} from './portrait-diagnostics';
import { areaGray } from "./area-gray";
import type {NameLabelObserver} from './recognition-input-observer';
export interface Reference {
  id: string;
  name: string;
  rarity: number;
  feature?: string;
  maxAwakening?: number;
  aliases?: string[];
}
export interface CountDiagnostics {
  /** Set only by the numeric reader's multi-variant confirmation, including its cache. */
  ocrConfirmedValue?: number;
  patternOcrAgreed?: boolean;
  iconPresent?: boolean;
  emptyEvidence?: import('./count-pattern').CountEmptyEvidence;
  reliability?: import("./count-confidence").CountReliability;
  maximum: number;
  reason: string;
  readings: { engine: string; text: string; confidence: number; value: number | null }[];
  pattern?: CountPatternReading;
}
export interface NameEvidence {
  complete?: boolean;
  stable?: boolean;
  frame?: string;
  rawText: string;
  normalizedText?: string;
  engine: "paddle" | "tesseract" | "artwork";
  portrait?: import("./portrait-matcher").PortraitEvidence;
  readingId: string;
  fingerprint: string;
  ocrConfidence: number;
  score: number;
  gap: number;
  exact: boolean;
  preprocessing?: "soft-rarity" | "gray-first-line-v1" | "stretch-first-v1";
  artwork?: import("./artwork-verifier").ArtworkEvidence;
  ctc?: { relativeLikelihood: number; margin: number };
}
export interface ScannedCard {
  id: string;
  name: string;
  awakening: number | null;
  extraCopies: number | null;
  confidence: number;
  review: string[];
  image: string;
  time: number;
  observations: number;
  manual?: ("name" | "awakening" | "extraCopies")[];
  identitySource?: "name-pattern" | "artwork" | "dictionary";
  maxAwakening?: number;
  captureOrder?: number;
  countReliable?: boolean;
  countDiagnostics?: CountDiagnostics;
  nameEvidence?: NameEvidence[];
  nameConfirmedBy?: "repeat" | "sort";
  capturePosition?: { frame: string; slot: number; stable: boolean; sort: import("./capture-metadata").CardSort | null; location?:import('./scroll-card-location').ScrollCardLocation };
}
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
export async function createRecognizer(status: (message: string) => void, signal?: AbortSignal,
  options:{nameRawResultPolicy?:NameRawResultPolicy;contrastNameFallback?:boolean}={}) {
  const nameRawResultPolicy=options.nameRawResultPolicy??'resample';
  if(nameRawResultPolicy!=='resample'&&nameRawResultPolicy!=='continue')throw Error('Invalid name raw-result policy');
  status("카드 이름 사전·OCR 준비 중");
  const initializationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const response = await fetch(`${import.meta.env.BASE_URL}scanner/cards.json`, { signal: initializationSignal });
  if (!response.ok) throw new Error("카드 사전 로드 실패");
  const { cards } = (await response.json()) as { cards: Reference[] };
  const byId = new Map(cards.map((card) => [card.id, card]));
  const portraitResponse = await fetch(`${import.meta.env.BASE_URL}scanner/artwork-details.json`, { signal: initializationSignal });
  if (!portraitResponse.ok) throw new Error("카드 원화 대조 자료 로드 실패");
  const screenResponse=await fetch(`${import.meta.env.BASE_URL}scanner/screen-artwork-details.json`, { signal: initializationSignal });
  if(!screenResponse.ok)throw new Error('보조 카드 그림 기준 로드 실패');
  const screen=await screenResponse.json() as {cards:Record<string,string>};
  const portraitAtlas=await portraitResponse.json();
  const matchPortrait = createPortraitMatcher(cards,portraitAtlas,screen.cards);
  let refinePortrait:ReturnType<typeof createPortraitMatcher>|undefined;
  const portraits = new WeakMap<HTMLCanvasElement, ReturnType<typeof matchPortrait>>();
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
    });
    if (!text) portraits.set(canvas, result);
    return result;
  }
  const stars = (await (
    await fetch(`${import.meta.env.BASE_URL}scanner/stars.json`, { signal: initializationSignal })
  ).json()) as { gray: number[][]; gold: number[][] };
  const templates = [stars.gray[0], stars.gold[0]];
  const patternResponse = await fetch(`${import.meta.env.BASE_URL}scanner/counter-patterns.json`, { signal: initializationSignal });
  if (!patternResponse.ok) throw new Error("장수 패턴 로드 실패");
  const countAtlas = await patternResponse.json() as { patterns: CountPattern[] };
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
  const reader = createNameReader(cards, status, signal,{rawResultPolicy:nameRawResultPolicy,contrastNameFallback:options.contrastNameFallback});
  try { await reader.ready(); signal?.throwIfAborted(); }
  catch (error) { await reader.dispose(); throw error; }
  status("이름·장수 OCR / 각성 보석 인식 준비 완료");
  return {
    async inspect(canvas: HTMLCanvasElement) {
      return inspect(canvas);
    },
    catalog: cards,
    portrait,
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
    async identify(canvas: HTMLCanvasElement, full = true, captureStable = false, structural = false,budget?:import('./card-read-budget').CardReadBudget,allowPortraitRefinement=false,observeLabel?:NameLabelObserver,allowGrayNameFallback=false) {
      const attempts: import("./name-diagnostics").NameAttempt[] = [];
      nameAttempts.set(canvas, attempts);
      namePerformances.delete(canvas);
      portraitAttempts.set(canvas,[]);
      // Even a timeout at entry belongs to this invocation, never to the
      // previous short/full read of the same retained canvas.
      budget?.check();
      const fields = inspect(canvas);
      const artwork = portrait(canvas);
      if (artwork) return portraitIdentity(artwork);
      // The fast visual lanes keep the integer-only matcher. Spend the extra
      // registration work only on an explicitly admitted full retry,
      // before that retry starts its substantially longer OCR work.
      if(full&&allowPortraitRefinement&&structural){
        budget?.check();
        const pixels=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;
        const refined=(refinePortrait??=createPortraitMatcher(cards,portraitAtlas,screen.cards,{fractionalRegistration:true}))(
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
        !confirmCatalogName(reading, captureStable) ? portrait(canvas, { id: reading.card.id, rawText: reading.rawText,
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
      if (corroborated?.card.id === text.card.id) return {
        ...portraitIdentity(corroborated),
        nameEvidence: [{ rawText: text.rawText, complete: text.complete, normalizedText: normalizeName(text.rawText), engine: text.engine,
          readingId: text.readingId, fingerprint: text.fingerprint, ocrConfidence: text.ocrConfidence,
          score: text.score, gap: text.gap, exact: text.exact, portrait: corroborated.portrait }],
      };
      if (!confirmCatalogName(text, captureStable)) {
        for (const attempt of attempts) if (attempt.text === text.rawText)
          attempt.reason = "DB 유사 이름만 일치 · 독립 그림 근거 부족 · 미등록 카드 또는 이름 재관측 필요";
        return null;
      }
      return {
        id: text.card.id,
        name: text.card.name,
        confidence: text.score,
        nameEvidence: [{ rawText: text.rawText, complete: text.complete, normalizedText: normalizeName(text.rawText), engine: text.engine,
          readingId: text.readingId, fingerprint: text.fingerprint,
          ocrConfidence: text.ocrConfidence, score: text.score, gap: text.gap, exact: text.exact,
          preprocessing: "preprocessing" in text ? text.preprocessing as NameEvidence["preprocessing"] : undefined,
          artwork: "artwork" in text ? text.artwork as NameEvidence["artwork"] : undefined,
          ctc: "ctc" in text ? text.ctc as NameEvidence["ctc"] : undefined }],
        review:
          !confirmName({ ...text, artwork: "artwork" in text ? text.artwork as NameEvidence["artwork"] : undefined, ctc: "ctc" in text ? text.ctc as NameEvidence["ctc"] : undefined }, captureStable)
            ? ["이름 확인"]
            : ([] as string[]),
        identitySource: "artwork" in text && text.artwork ? "artwork" as const : "dictionary" as const,
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
      context.drawImage(canvas, 0, 0, 140, 210);
      const pattern = matchCountPattern(context.getImageData(0, 0, 140, 210).data, countPatterns, fields.offsetY, maximum);
      const diagnostic: CountDiagnostics = { maximum, reason: fields.hasIcon === null ? '추가 장수 영역 가림 또는 불명확' : pattern.reason, readings: [], pattern, iconPresent: fields.hasIcon ?? undefined };
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
      await reader.dispose();
    },
  };
}
