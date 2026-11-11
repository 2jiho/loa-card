import {executionSummary,exactPixels} from './exact-recording-codec';
import {recordedCoverage} from './reproduction-coverage';
import type {ReproductionFile} from './scan-reproduction';

/** Checks recorded event scope and each stored pixel hash, one frame at a
 * time. Even success cannot prove that the OS delivered every physical frame. */
export async function validateArchiveExact(file:ReproductionFile,signal:AbortSignal):Promise<boolean> {
  signal.throwIfAborted();
  const exact=file.metadata.exact;
  if(!file.exact||!exact||recordedCoverage(file.metadata)!=='declared-complete')return false;
  const summary=await executionSummary(file.exact,signal,exact);
  // An absent or mismatching input checkpoint is not evidence that the
  // recorded admission/ownership sequence was complete. Older captures with
  // no input ledger remain protected and fall back to raw preservation.
  if(summary.recordingComplete!==true||!summary.input.supported||!summary.input.settled||
    summary.input.matchesCapturedState!==true||!summary.input.pipeline.supported||
    summary.input.pipeline.started<1||summary.input.pipeline.linked!==summary.input.pipeline.started||
    !summary.rasterProof?.supported||!summary.rasterProof.complete||summary.rasterProof.matches!==true||
    !summary.inventory.supported||summary.inventory.matchesCapturedState!==true||
    !summary.grid.supported||summary.grid.matchesCapturedState!==true||
    !summary.unknownLifecycle.supported||!summary.unknownLifecycle.complete||summary.unknownLifecycle.matchesCapturedState!==true||
    summary.unknownLifecycle.liveEvidenceLost!==false||
    !summary.freshness.supported||!summary.freshness.complete||summary.freshness.matchesCapturedState!==true||
    !summary.obstruction.supported||!summary.obstruction.complete||summary.obstruction.matchesCapturedState!==true)return false;
  let frames=0;
  for await(const frame of exactPixels(file.exact,signal,exact.storageVersion===1?1:0,exact.policy)){
    signal.throwIfAborted();if(!frame.pixels.length)return false;frames++;
  }
  return frames===exact.frames&&frames>0;
}
