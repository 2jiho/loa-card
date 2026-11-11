import { assertNextDebugPart, replayDebugFrames } from "./debug-capture";
import type { DebugCapture, DebugRecorder } from "./debug-capture";

/** Read the original snapshots used by both initial scanning and file replay.
 * Parts stay compressed until consumed, instead of decoding the whole desktop history. */
export async function* recorderSnapshotParts(recorder: Pick<DebugRecorder, "ready" | "session" | "unsavedParts">,
  load: (recordingId: string, part: number) => Promise<DebugCapture | undefined>, signal: AbortSignal) {
  await recorder.ready(); signal.throwIfAborted();
  const last = recorder.session, count = last.part ?? 1;
  let first: DebugCapture | undefined, elapsed = -1;
  for (let part = 1; part <= count; part++) {
    signal.throwIfAborted();
    const session = part === count ? last : recorder.unsavedParts.get(part) ?? await load(last.recordingId!, part);
    if (!session?.frames.length) throw new Error(`${part}번 원본 캡처 구간을 찾지 못했습니다.`);
    if (first) assertNextDebugPart(first, session, part, elapsed);
    else first = { ...session, frames: [], seed: [] };
    yield session;
    elapsed = session.frames.at(-1)!.elapsed;
  }
}

export async function* recorderSnapshots(recorder: Pick<DebugRecorder, "ready" | "session" | "unsavedParts">,
  load: (recordingId: string, part: number) => Promise<DebugCapture | undefined>, signal: AbortSignal) {
  for await (const part of recorderSnapshotParts(recorder, load, signal))
    yield* replayDebugFrames(part, signal);
}
