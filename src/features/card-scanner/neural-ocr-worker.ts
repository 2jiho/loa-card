import * as ort from "onnxruntime-web/wasm";
import { decodeCtc } from "./ctc-decoder";
import { createCtcLexicon, joinCtcLines } from "./ctc-lexicon";
let decodeNames: ReturnType<typeof createCtcLexicon> | undefined;
let firstLine: { group: string; probabilities: Float32Array; text: string; confidence: number } | undefined;

const base = new URL(`${import.meta.env.BASE_URL}ocr/`, self.location.href)
  .href;
ort.env.wasm.wasmPaths = base;
// Pages cannot add COOP/COEP headers. Run SIMD in this dedicated worker with
// one WASM thread, so SharedArrayBuffer and crossOriginIsolated are unnecessary.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";
let engine:
  | Promise<{ session: ort.InferenceSession; characters: string[] }>
  | undefined;
function ready(model: "korean" | "digits") {
  return (engine ??= (async () => {
    const dictionary =
      model === "korean"
        ? "paddle-characters.json"
        : "paddle-v6-characters.json";
    const filename =
      model === "korean"
        ? "korean-v5-92f0b778.onnx"
        : "digits-v6-9ef676d6.onnx";
    const url = new URL(
      `${import.meta.env.BASE_URL}scanner/${dictionary}`,
      self.location.href,
    );
    const label = model === 'korean' ? '이름 모델' : '숫자 모델';
    const modelResponse = await fetch(`${base}${filename}`);
    if (!modelResponse.ok) throw new Error(`${label} 다운로드 실패 (${modelResponse.status})`);
    const total = Number(modelResponse.headers.get('Content-Length')) || undefined;
    const chunks: Uint8Array[] = [];
    let loaded = 0, lastReport = 0;
    const stream = modelResponse.body?.getReader();
    if (!stream) throw new Error(`${label} 다운로드 응답이 없습니다.`);
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      chunks.push(value); loaded += value.length;
      if (performance.now() - lastReport > 250) {
        self.postMessage({ progress: `${label} 다운로드 ${(loaded / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB` });
        lastReport = performance.now();
      }
    }
    if (!loaded) throw new Error(`${label} 파일이 비어 있습니다.`);
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    chunks.length = 0;
    self.postMessage({ progress: `${label} 준비 중` });
    const [session, response] = await Promise.all([
      ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
      fetch(url),
    ]);
    if (!response.ok) throw new Error("OCR 문자표를 불러올 수 없습니다.");
    return { session, characters: (await response.json()) as string[] };
  })());
}
async function recognize(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  model: "korean" | "digits",
  useLexicon = false,
  nameLine?: import("./neural-reader").NameLine,
) {
  const { session, characters } = await ready(model);
  const source = new OffscreenCanvas(width, height);
  source
    .getContext("2d")!
    .putImageData(
      new ImageData(new Uint8ClampedArray(data), width, height),
      0,
      0,
    );
  const resizedWidth = Math.ceil((48 * width) / height),
    inputWidth = Math.max(320, resizedWidth);
  const resized = new OffscreenCanvas(resizedWidth, 48);
  const context = resized.getContext("2d")!;
  context.drawImage(source, 0, 0, resizedWidth, 48);
  const rgba = context.getImageData(0, 0, resizedWidth, 48).data;
  const plane = 48 * inputWidth,
    tensor = new Float32Array(3 * plane);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < resizedWidth; x++) {
      const i = (y * resizedWidth + x) * 4,
        p = y * inputWidth + x;
      // The official model uses BGR, [-1, 1], and zero padding after resize.
      tensor[p] = rgba[i + 2] / 127.5 - 1;
      tensor[plane + p] = rgba[i + 1] / 127.5 - 1;
      tensor[2 * plane + p] = rgba[i] / 127.5 - 1;
    }
  const input = new ort.Tensor("float32", tensor, [1, 3, 48, inputWidth]);
  let output: ort.Tensor | undefined;
  try {
    const results = await session.run({ [session.inputNames[0]]: input });
    output = results[session.outputNames[0]];
    const [, steps, classes] = output.dims;
    if (classes !== characters.length)
      throw new Error("OCR 문자표 버전 불일치");
    const probabilities = output.data as Float32Array;
    const reading = decodeCtc(probabilities, steps, characters);
    let joined: import("./neural-reader").NeuralReading | undefined;
    if (nameLine?.line === 0) {
      firstLine = { group: nameLine.group, probabilities: probabilities.slice(), ...reading };
    } else if (nameLine?.line === 1) {
      if (firstLine?.group === nameLine.group && reading.text.trim()) {
        const data = joinCtcLines(firstLine.probabilities, probabilities, characters.length);
        const text = (firstLine.text+reading.text).normalize("NFKC");
        joined = { text, confidence: Math.min(firstLine.confidence, reading.confidence),
          candidates: decodeNames?.(data, data.length/characters.length, text) };
      }
      firstLine = undefined;
    }
    return { ...reading, joined, candidates: useLexicon ? decodeNames?.(probabilities, steps, reading.text) : undefined };
  } finally {
    input.dispose();
    output?.dispose();
    source.width = 0;
    resized.width = 0;
  }
}
type Request = {
  id: number;
  type: "ready" | "recognize";
  model: "korean" | "digits";
  width?: number;
  height?: number;
  data?: Uint8ClampedArray;
  lexicon?: import("./ctc-lexicon").LexiconEntry[];
  useLexicon?: boolean;
  nameLine?: import("./neural-reader").NameLine;
};
let jobs = Promise.resolve();
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  jobs = jobs.then(async () => {
    try {
      if (request.type === "ready" && request.model === "korean" && request.lexicon) {
        const { characters } = await ready(request.model);
        decodeNames = createCtcLexicon(characters, request.lexicon);
      }
      const result =
        request.type === "ready"
          ? (await ready(request.model), null)
          : await recognize(
              request.data!,
              request.width!,
              request.height!,
              request.model,
              request.useLexicon,
              request.nameLine,
            );
      self.postMessage({ id: request.id, result });
    } catch (error) {
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
