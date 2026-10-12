import { inspectVisual, portraitIdentity, readVisual, readFullAwakening } from './visual-fields';
import { observationPixels } from "./observation-pixels";
import { confirmName, confirmCatalogName } from "./name-confidence";
import { normalizeName } from "./card-dictionary";
import { readSortArrow } from "./capture-metadata";
import type { Layout } from "./detector";
import type { Box } from "./detector";
import { createNameReader } from "./name-reader";
import { prepareContrastPattern, matchCountPattern } from "./count-pattern";
import type { CountPattern, CountPatternReading } from "./count-pattern";
import { nameMask } from "./name-pattern";
import { createPortraitMatcher } from "./portrait-matcher";
import { areaGray } from "./area-gray";
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
  preprocessing?: "soft-rarity";
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
  capturePosition?: { frame: string; slot: number; stable: boolean; sort: import("./capture-metadata").CardSort | null };
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
export async function createRecognizer(status: (message: string) => void, signal?: AbortSignal) {
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
  const matchPortrait = createPortraitMatcher(cards, await portraitResponse.json(), screen.cards);
  const portraits = new WeakMap<HTMLCanvasElement, ReturnType<typeof matchPortrait>>();
  function portrait(canvas: HTMLCanvasElement, text?: import("./portrait-matcher").PortraitTextEvidence & { id: string }) {
    if (!text && portraits.has(canvas)) return portraits.get(canvas)!;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = matchPortrait(areaGray(pixels, canvas.width, canvas.height), text);
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
  const inspected = new WeakMap<
    HTMLCanvasElement,
    {
      labelPixels: number;
      blankName: boolean;
      awakening: number | null;
      offsetY: number;
      hasIcon: boolean;
      hasNameBand: boolean;
    }
  >();
  const nameAttempts = new WeakMap<HTMLCanvasElement, import("./name-diagnostics").NameAttempt[]>();
  function inspect(canvas: HTMLCanvasElement) {
    const previous = inspected.get(canvas);
    if (previous) return previous;
    const result = inspectVisual(canvas, context, templates);
    inspected.set(canvas, result);
    return result;
  }
  signal?.throwIfAborted();
  const reader = createNameReader(cards, status, signal);
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
      const artwork = portrait(canvas);
      return artwork ? portraitIdentity(artwork) : null;
    },
    nameDiagnostics(canvas: HTMLCanvasElement) { return nameAttempts.get(canvas)?.slice() ?? []; },
    async identify(canvas: HTMLCanvasElement, full = true, captureStable = false, structural = false) {
      const fields = inspect(canvas);
      const attempts: import("./name-diagnostics").NameAttempt[] = [];
      nameAttempts.set(canvas, attempts);
      const artwork = portrait(canvas);
      if (artwork) return portraitIdentity(artwork);
      if (fields.blankName) return null;
      if (fields.labelPixels < 35 && !structural) return null;
      const onAttempt = (attempt: import("./name-diagnostics").NameAttempt) => {
        attempts.push(attempt);
        if (attempts.length > 24) attempts.splice(8, 1);
      };
      let text = await reader.match(canvas, true, fields.offsetY, structural, onAttempt);
      const corroborate = (reading: NonNullable<Awaited<ReturnType<typeof reader.match>>>) =>
        !confirmCatalogName(reading, captureStable) ? portrait(canvas, { id: reading.card.id, rawText: reading.rawText,
          complete: reading.complete, canonicalName: reading.card.name,
          ocrConfidence: reading.ocrConfidence, score: reading.score, gap: reading.gap }) : null;
      let corroborated = text ? corroborate(text) : null;
      if (!text || (!confirmCatalogName(text, captureStable) && !corroborated)) {
        if (full) {
          text = await reader.match(canvas, false, fields.offsetY, structural, onAttempt);
          corroborated = text ? corroborate(text) : null;
        }
      }
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
    async read(canvas: HTMLCanvasElement, id?: string, corroborate = false, allowOcr = true) {
      if (!allowOcr) return readVisual(canvas, context, inspect(canvas), countPatterns, id ? byId.get(id)?.maxAwakening : undefined);
      if (id && byId.get(id)?.maxAwakening === 0)
        return { awakening: 0, extraCopies: 0 };
      const fields = inspect(canvas),
        level = fields.awakening;
      const full = readFullAwakening(canvas, context, fields, countPatterns);
      if (full) return full;
      if (!fields.hasIcon)
        return { awakening: level, extraCopies: level === null ? null : 0,
          countDiagnostics: { maximum: level === null ? 15 : 15 - level * (level + 1) / 2,
            reason: level === null ? "추가 카드 표시 없음 · 각성 영역 미확정" : "추가 카드 표시 없음 · 0장 후보",
            readings: [], iconPresent: false } satisfies CountDiagnostics };
      const maximum = level === null ? 15 : 15 - (level * (level + 1)) / 2;
      context.drawImage(canvas, 0, 0, 140, 210);
      const pattern = matchCountPattern(context.getImageData(0, 0, 140, 210).data, countPatterns, fields.offsetY, maximum);
      const diagnostic: CountDiagnostics = { maximum, reason: pattern.reason, readings: [], pattern, iconPresent: true };
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
        const digitValue = await reader.count(strip, maximum, diagnostic);
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
