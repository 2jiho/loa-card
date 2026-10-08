import { DebugRecorder } from "./debug-capture";
import type { DebugCapture, DebugFrame } from "./debug-capture";
import { deleteDebugPart, loadDebugPart, saveDebugPart } from "./debug-store";
import { recorderSnapshotParts, recorderSnapshots } from "./recording-snapshots";

interface OriginalStorage {
  save: (part: DebugCapture) => Promise<void>;
  load: (id: string, part: number) => Promise<DebugCapture | undefined>;
  delete: (id: string, part: number) => Promise<void>;
}
/** Lossless capture supplements belong to recognition, independent of the
 * optional exported debug file. Only this scan's temporary parts are removed. */
export function createCaptureOriginals(settings: Pick<DebugCapture, "rowMode" | "captureOnly">,
  signal: AbortSignal,
  storage: OriginalStorage = { save: saveDebugPart, load: loadDebugPart, delete: deleteDebugPart },
  limits?: { bytes: number; frames: number }) {
  const recorder = new DebugRecorder({ ...settings, source: "screen", seed: [] }, storage.save, limits);
  return {
    add(frame: DebugFrame) { recorder.add(frame); },
    get active() { return !recorder.session.truncated; },
    get failure() { return recorder.failure; },
    parts: () => recorderSnapshotParts(recorder, storage.load, signal),
    frames: () => recorderSnapshots(recorder, storage.load, signal),
    async dispose() {
      await recorder.ready();
      const id = recorder.session.recordingId!;
      for (let part = 1; part <= recorder.archivedParts; part++) await storage.delete(id, part);
      recorder.unsavedParts.clear(); recorder.session.frames.length = 0;
    },
  };
}
