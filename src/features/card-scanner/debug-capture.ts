import type { ScannedCard } from "./recognizer";

export interface DebugFrame { image: string; time: number; elapsed: number }
export interface DebugCapture {
  kind: "loacard-capture";
  version: 1;
  createdAt: string;
  source: "screen" | "video" | "images";
  rowMode: "all" | "top" | "stable";
  captureOnly: boolean;
  seed: ScannedCard[];
  frames: DebugFrame[];
  truncated: boolean;
  recordingId?: string;
  part?: number;
}
export const MAX_DEBUG_BYTES = 128 * 1024 * 1024;
export const MAX_DEBUG_FRAMES = 600;
export class DebugRecorder {
  session: DebugCapture;
  private bytes = 0;
  totalFrames = 0;
  archivedParts = 0;
  failure = "";
  exportBundle?: Blob;
  exportPreparing?: Promise<Blob>;
  continuous?: import("./continuous-capture").ContinuousRecording;
  readonly unsavedParts = new Map<number, DebugCapture>();
  private pending = Promise.resolve();
  private archive?: (session: DebugCapture) => Promise<void>;
  private limits: { bytes: number; frames: number };
  constructor(settings: Pick<DebugCapture, "source" | "rowMode" | "captureOnly" | "seed">,
    archive?: (session: DebugCapture) => Promise<void>,
    limits = { bytes: MAX_DEBUG_BYTES, frames: MAX_DEBUG_FRAMES }) {
    this.archive = archive;
    this.limits = limits;
    this.session = { ...settings, seed: structuredClone(settings.seed),
      kind: "loacard-capture", version: 1, createdAt: new Date().toISOString(),
      frames: [], truncated: false, ...(archive ? { recordingId: crypto.randomUUID(), part: 1 } : {}) };
  }
  add(frame: DebugFrame) {
    if (this.session.truncated) return;
    if (frame.image.length > this.limits.bytes) {
      this.failure = "단일 프레임이 기록 구간 용량을 초과했습니다.";
      this.session.truncated = true; return;
    }
    if (this.session.frames.length >= this.limits.frames || this.bytes + frame.image.length > this.limits.bytes) {
      if (!this.archive) { this.session.truncated = true; return; }
      const completed = this.session;
      this.pending = this.pending.then(() => this.archive!(completed)).catch(() => {
        this.unsavedParts.set(completed.part!, completed);
        this.failure = "브라우저 저장 공간 부족 또는 저장 오류로 기록이 중단됐습니다.";
        this.session.truncated = true;
      });
      this.archivedParts++;
      this.session = { ...completed, part: completed.part! + 1, seed: [], frames: [], truncated: false };
      this.bytes = 0;
    }
    this.bytes += frame.image.length;
    this.session.frames.push(frame);
    this.totalFrames++;
  }
  async ready() { await this.pending; }
}
export function parseDebugCapture(text: string): DebugCapture {
  if (text.length > MAX_DEBUG_BYTES * 2) throw new Error("디버그 파일이 너무 큽니다.");
  const data = JSON.parse(text) as DebugCapture;
  const image = (value: unknown) => typeof value === "string" && /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
  const seedImage = (value:unknown) => image(value) || typeof value === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value);
  if (!data || data.kind !== "loacard-capture" || data.version !== 1 ||
      !["screen", "video", "images"].includes(data.source) ||
      !["all", "top", "stable"].includes(data.rowMode) || typeof data.captureOnly !== "boolean" ||
      !Array.isArray(data.frames) || !data.frames.length || data.frames.length > MAX_DEBUG_FRAMES ||
      !Array.isArray(data.seed) || data.seed.length > 1000)
    throw new Error("LoaCard 캡처 디버그 파일 형식이 아닙니다.");
  if ((data.recordingId !== undefined || data.part !== undefined) &&
      (typeof data.recordingId !== "string" || !data.recordingId || !Number.isInteger(data.part) || data.part! < 1))
    throw new Error("기록 구간 정보가 올바르지 않습니다.");
  let previous = -1, bytes = 0;
  for (const frame of data.frames) {
    if (!image(frame.image) || !Number.isFinite(frame.time) || frame.time < 0 ||
        !Number.isFinite(frame.elapsed) || frame.elapsed < 0 || frame.elapsed < previous)
      throw new Error("캡처 프레임 또는 시간 정보가 올바르지 않습니다.");
    previous = frame.elapsed;
    bytes += frame.image.length;
  }
  if (bytes > MAX_DEBUG_BYTES) throw new Error("캡처 프레임 용량이 한도를 초과했습니다.");
  for (const card of data.seed) {
    if (!card || typeof card.id !== "string" || typeof card.name !== "string" ||
        !Array.isArray(card.review) || card.review.some(value => typeof value !== "string") ||
        !seedImage(card.image) || !Number.isFinite(card.confidence) || !Number.isFinite(card.observations) ||
        !Number.isFinite(card.time) ||
        (card.awakening !== null && (!Number.isInteger(card.awakening) || card.awakening < 0 || card.awakening > 5)) ||
        (card.extraCopies !== null && (!Number.isInteger(card.extraCopies) || card.extraCopies < 0 || card.extraCopies > 15)))
      throw new Error("디버그 파일의 시작 카드 목록이 올바르지 않습니다.");
  }
  return data;
}

/** Decode only the current full-size frame; a whole session must not allocate
 * hundreds of decoded desktop images simultaneously. These are captured video
 * frames, not still images that can be assumed stable on their first reading. */
export async function* replayDebugFrames(session: DebugCapture, signal: AbortSignal) {
  for (const [index, frame] of session.frames.entries()) {
    signal.throwIfAborted();
    const image = new Image();
    image.src = frame.image;
    try {
      await image.decode();
      signal.throwIfAborted();
      yield { element: image, image: frame.image, time: frame.time, percent: (index + 1) / session.frames.length * 100 };
    } finally { image.src = ""; }
  }
}

export function assertNextDebugPart(first: DebugCapture, next: DebugCapture, part: number, elapsed: number) {
  if (!first.recordingId || next.recordingId !== first.recordingId || next.part !== part ||
      next.source !== first.source || next.rowMode !== first.rowMode || next.captureOnly !== first.captureOnly ||
      next.frames[0].elapsed < elapsed || next.seed.length)
    throw new Error("같은 기록의 연속 구간을 1번부터 빠짐없이 선택하세요.");
}
