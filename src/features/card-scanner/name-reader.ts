import { confirmCounter, parseCounterEvidence } from "./counter-evidence";
import type { CounterReading } from "./counter-evidence";
import type { CountDiagnostics } from "./recognizer";
import { parseGrowthPoints, parseCardSort } from "./capture-metadata";
import { createNeuralReader } from "./neural-reader";
import type { Worker, PSM } from "tesseract.js";
import { matchCardName } from "./card-dictionary";
import { createArtworkVerifier } from "./artwork-verifier";
import type { ArtworkEvidence } from "./artwork-verifier";
import { matchCtcCardName } from "./ctc-name-match";
import type { CatalogName } from "./card-dictionary";
import { confirmName } from "./name-confidence";
import type { NameMatchEvidence } from "./name-confidence";
import { softNamePixels, normalizeSoftNamePixels } from "./soft-name-pixels";
import { strongNameMask } from "./text-mask";
import { nameMask, nameSimilarity, packName } from "./name-pattern";
import { parseInventoryTotal } from "./ocr-values";
import { nameAttempt } from "./name-diagnostics";
import type { NameAttempt } from "./name-diagnostics";
import { ExactRegionResult } from './exact-region-result';

/** OCR supplies visible text; artwork can independently confirm a truncated name. */
export function createNameReader(cards: (CatalogName & { feature?: string })[], status?: (message: string) => void, signal?: AbortSignal) {
  const neural = createNeuralReader("korean", cards.map(({ id, name }) => ({ id, name })), status);
  const verifyArtwork = createArtworkVerifier(cards);
  const digits = createNeuralReader("digits", undefined, status);
  const abort = () => { neural.dispose(); digits.dispose(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const engines = new Map<string, Promise<Worker>>();
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
      preprocessing?: "soft-rarity";
    };
  }[] = [];
  const counters = new Map<string, number>();
  const pointsCache=new ExactRegionResult<NonNullable<ReturnType<typeof parseGrowthPoints>>>(1);
  const sortCache=new ExactRegionResult<NonNullable<ReturnType<typeof parseCardSort>>>(1);
  let disposed = false;
  async function worker(language: "kor" | "eng") {
    let engine = engines.get(language);
    if (!engine) {
      engine = (async () => {
        const { createWorker } = await import("tesseract.js");
        const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href)
          .href;
        const instance = await createWorker(language, 1, {
          workerPath: `${base}worker.min.js`,
          corePath: base,
          langPath: base.replace(/\/$/, ""),
          cachePath: `loacard-${language}-4.1.0`,
          workerBlobURL: false,
        });
        await instance.setParameters({
          tessedit_pageseg_mode: (language === "kor" ? "6" : "7") as PSM,
          user_defined_dpi: "300",
          tessedit_char_whitelist: "",
        });
        if (disposed) {
          await instance.terminate();
          throw new Error("OCR 종료");
        }
        return instance;
      })();
      engines.set(language, engine);
    }
    return engine;
  }
  async function recognize(source: HTMLCanvasElement, language: "kor" | "eng") {
    const instance = await worker(language);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { data } = await Promise.race([
        instance.recognize(source),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void instance.terminate();
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
    async count(source: HTMLCanvasElement, maximum: number, diagnostic?: CountDiagnostics) {
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
      const previous = counters.get(key);
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
      const first = await digits.recognize(source),
        second = await digits.recognize(rawTight);
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
        counters.set(key, count);
        if (counters.size > 1024) counters.delete(counters.keys().next().value!);
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
      const masked = await digits.recognize(tight);
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
            const data = await recognize(enlarged, "eng");
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
            const data = await recognize(enlarged, "eng");
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
    async match(source: HTMLCanvasElement, quick = false, offsetY = 0, allowRaw = false, onAttempt?: (attempt: NameAttempt) => void) {
      const label = document.createElement("canvas");
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
        label.width = 0;
        return null;
      }
      try {
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
          if (previous) return { ...previous.result, complete: allowRaw };
        }
        // Raw glyphs survive video compression better than saturation masks.
        const rawCrop = document.createElement("canvas");
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
        const confirmedReading = (reading: Reading) => confirmName({ ...reading,
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
          const grade = cards.find((c) => c.name === reading.card.name)?.rarity;
          const packed = masks.find((m) => m.grade === grade);
          // Partial names may share identical glyphs. Their artwork must be
          // checked on every capture, not reused from the name-mask cache.
          if (packed && confirmedReading(reading) && !("artwork" in reading && reading.artwork)) {
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
          const data = await neural.recognize(rawCrop, y === 0, { group: fingerprint, line: y === 0 ? 0 : 1 });
          if (y === 0) {
            firstText = data.text;
            firstConfidence = data.confidence;
            const result = primaryMatch(data.text, data.confidence) ?? lexiconMatch(data);
            if (result) {
              if (quick || confirmedReading(result)) {
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
              if (quick || confirmedReading(result)) {
                rawCrop.width = 0;
                return rememberName(result, 36);
              }
              retainCandidate(result, 36);
            }
          }
        }
        rawCrop.width = 0;
        variant = "원본 전체 이름 영역";
        const full = await neural.recognize(label, true),
          fullResult = primaryMatch(full.text, full.confidence) ?? lexiconMatch(full);
        if (fullResult) {
          if (quick || confirmedReading(fullResult)) return rememberName(fullResult, 36);
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
        if (corroborated) return rememberName({ ...corroborated,
          ocrConfidence: artworkConfidence * 100, ...diagnostics(corroborated.artwork.visiblePrefix, "paddle") }, 36);
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
              const data = await neural.recognize(soft, true);
              const result = primaryMatch(data.text, data.confidence) ?? lexiconMatch(data);
              const confirmed = result && confirmName({ ...result,
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
          await (
            await worker("kor")
          ).setParameters({ tessedit_pageseg_mode: pass.psm as PSM });
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
                const data = await recognize(enlarged, "kor");
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
                  if (confirmedReading(reading)) cache.push({
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
        await (
          await worker("kor")
        ).setParameters({ tessedit_pageseg_mode: "6" as PSM });
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
            const data = await recognize(enlarged, "kor");
            const result = /[ㄱ-ㅎㅏ-ㅣ]/.test(data.text)
              ? null
              : matchCardName(data.text, cards);
            if (onAttempt) onAttempt(nameAttempt(data.text, data.confidence, "tesseract", `흑백 원본 · ${height}px`, cards, !!result));
            if (result) return { ...result, ocrConfidence: data.confidence, ...diagnostics(data.text, "tesseract") };
          } finally {
            enlarged.width = 0;
          }
        }
        return null;
      } finally {
        label.width = 0;
      }
    },
    async dispose() {
      disposed = true;
      signal?.removeEventListener('abort', abort);
      neural.dispose();
      digits.dispose();
      await Promise.all(
        [...engines.values()].map(async (engine) => (await engine).terminate()),
      );
    },
  };
}
