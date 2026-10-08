import { MAX_DEBUG_BYTES, parseDebugCapture, assertNextDebugPart, replayDebugFrames } from "./debug-capture";
import type { DebugCapture } from "./debug-capture";
import type { ContinuousRecording } from "./continuous-capture";

const MAGIC = "LOACARD1\n";
const VIDEO_MAGIC = "LOACARD2\n";
export interface DebugPartRange { offset: number; length: number }
const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
export async function isDebugBundle(file: Blob) { return [MAGIC, VIDEO_MAGIC].includes(await file.slice(0, MAGIC.length).text()); }

/** Blob components avoid concatenating all large JSON parts into a single JS string. */
export async function createDebugBundle(count: number, load: (part: number) => Promise<DebugCapture | undefined>, recording?: ContinuousRecording) {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("기록 구간 수가 올바르지 않습니다.");
  const output: BlobPart[] = [recording ? VIDEO_MAGIC : MAGIC, uint32(count)];
  let first: DebugCapture | undefined, elapsed = -1;
  for (let part = 1; part <= count; part++) {
    const session = await load(part);
    if (!session?.frames.length) throw new Error(`${part}번 기록 구간을 찾지 못했습니다. 전체 기록을 저장하지 못했습니다.`);
    if (part === 1 && session.part !== undefined && session.part !== 1) throw new Error("첫 기록 구간이 누락됐습니다.");
    if (first) assertNextDebugPart(first, session, part, elapsed);
    else first = { ...session, frames: [], seed: [] };
    elapsed = session.frames.at(-1)!.elapsed;
    const blob = new Blob([JSON.stringify(session)], { type: "application/json" });
    if (blob.size > MAX_DEBUG_BYTES * 2) throw new Error("기록 구간 용량이 너무 큽니다.");
    output.push(uint32(blob.size), blob);
  }
  if (recording) {
    const metadata = new Blob([JSON.stringify({ type: recording.blob.type, duration: recording.duration, size: recording.blob.size })]);
    output.push(uint32(metadata.size), metadata, recording.blob);
  }
  return new Blob(output, { type: "application/octet-stream" });
}

/** Index byte ranges, then load/decode just one part at a time, even for >256MB files. */
export async function indexDebugBundle(file: Blob): Promise<DebugPartRange[]> {
  if (!await isDebugBundle(file)) throw new Error("LoaCard 기록 파일 형식이 아닙니다.");
  const header = await file.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer();
  if (header.byteLength !== 4) throw new Error("기록 파일이 잘렸습니다.");
  const count = new DataView(header).getUint32(0, true);
  if (!count || count > 10000) throw new Error("기록 구간 수가 올바르지 않습니다.");
  const ranges: DebugPartRange[] = [];
  let offset = MAGIC.length + 4;
  for (let i = 0; i < count; i++) {
    const bytes = await file.slice(offset, offset + 4).arrayBuffer();
    if (bytes.byteLength !== 4) throw new Error("기록 파일이 잘렸습니다.");
    const length = new DataView(bytes).getUint32(0, true);
    offset += 4;
    if (!length || length > MAX_DEBUG_BYTES * 2 || offset + length > file.size) throw new Error("기록 구간 용량이 올바르지 않거나 파일이 잘렸습니다.");
    ranges.push({ offset, length }); offset += length;
  }
  if (await file.slice(0, MAGIC.length).text() === VIDEO_MAGIC) await readContinuousRecording(file, ranges);
  else if (offset !== file.size) throw new Error("기록 파일에 예상하지 못한 데이터가 있습니다.");
  return ranges;
}
export async function readContinuousRecording(file: Blob, ranges: DebugPartRange[]): Promise<ContinuousRecording | undefined> {
  if (await file.slice(0, MAGIC.length).text() !== VIDEO_MAGIC) return;
  const last = ranges.at(-1);
  if (!last) throw new Error("연속 기록 구간이 없습니다.");
  let offset = last.offset + last.length;
  const header = await file.slice(offset, offset + 4).arrayBuffer();
  if (header.byteLength !== 4) throw new Error("연속 기록 정보가 잘렸습니다.");
  const size = new DataView(header).getUint32(0, true); offset += 4;
  if (!size || size > 4096 || offset + size > file.size) throw new Error("연속 기록 정보가 올바르지 않습니다.");
  const metadata = JSON.parse(await file.slice(offset, offset + size).text()); offset += size;
  if (typeof metadata.type !== "string" || !/^video\/webm(?:;codecs=(?:vp8|vp9)(?:,opus)?)?$/.test(metadata.type)
    || !Number.isFinite(metadata.duration) || metadata.duration <= 0
    || !Number.isInteger(metadata.size) || metadata.size < 1 || metadata.size > 256 * 1024 * 1024
    || offset + metadata.size !== file.size) throw new Error("연속 영상 용량 또는 형식이 올바르지 않거나 파일이 잘렸습니다.");
  return { blob: file.slice(offset, file.size, metadata.type), duration: metadata.duration };
}
export async function readDebugBundlePart(file: Blob, range: DebugPartRange) {
  return parseDebugCapture(await file.slice(range.offset, range.offset + range.length).text());
}
export async function* replayDebugBundle(file: Blob, ranges: DebugPartRange[], signal: AbortSignal) {
  let first: DebugCapture | undefined, elapsed = -1;
  for (const [i, range] of ranges.entries()) {
    signal.throwIfAborted();
    const session = await readDebugBundlePart(file, range);
    if (i === 0 && session.part !== undefined && session.part !== 1) throw new Error("첫 기록 구간이 누락됐습니다.");
    if (first) assertNextDebugPart(first, session, i + 1, elapsed);
    else first = { ...session, frames: [], seed: [] };
    for await (const input of replayDebugFrames(session, signal))
      yield { ...input, percent: (i + input.percent / 100) / ranges.length * 100 };
    elapsed = session.frames.at(-1)!.elapsed;
  }
}
