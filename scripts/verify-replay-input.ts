/** Read-only, file-backed replay audit. This is not a scanner run. */
import {openAsBlob} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {exactPixels,executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {recordedCoverage} from '../src/features/card-scanner/reproduction/reproduction-coverage';
import {auditDeliveredInputs} from '../src/features/card-scanner/session/delivered-input-coverage';

/** Audits the existing codec rather than implementing a second decoder.
 * `blob` can be file-backed; individual payloads are decoded sequentially.
 * No pixel buffers or card/event values are retained in the report. */
export async function verifyReplayInput(blob:Blob,signal:AbortSignal) {
 const file=await openReproduction(blob,signal), metadata=file.metadata, exact=metadata.exact;
 const scope={payloadPixelsDecoded:false,recognitionRecomputed:false,liveTimingReplayed:false,
   videoDecoded:false,originalCaptureAuthenticated:false};
 if(!file.exact||!exact)return {version:metadata.version,recordedCoverage:recordedCoverage(metadata),
   exact:{supported:false as const,reason:'no-exact-stream' as const},
   deliveredInputCoverage:{status:'unknown' as const,scope:'recorded-admission-arrivals' as const,
     sourceDeliveryCompleteness:'unproven' as const,callbackPixelBinding:'unproven' as const,reason:'no-exact-stream' as const},scope};

 // This separately validates event ordering, totals, codec/storage metadata and
 // any supported state checkpoints. Completeness is the producer's declaration.
 const summary=await executionSummary(file.exact,signal,exact);
 const deliveredInputCoverage=await auditDeliveredInputs(file.exact,signal,summary.acquisitionEvidence?.pixelCoverage);
 let decodedFrames=0;
 for await(const frame of exactPixels(file.exact,signal,exact.storageVersion===1?1:0,exact.policy)){
   decodedFrames++;
   // exactPixels validates the decoded RGBA against the per-frame hash and
   // enforces strictly increasing frame IDs before yielding.
   if(!frame.pixels.length)throw Error('Empty decoded frame');
 }
 if(decodedFrames!==exact.frames)throw Error('Decoded frame count does not match recording metadata');
 const channel=(value:{supported:boolean;matchesCapturedState?:boolean|null})=>
   ({supported:value.supported,matchesCapturedState:value.matchesCapturedState??null});
 return {version:metadata.version,recordedCoverage:recordedCoverage(metadata),
   exact:{supported:true as const,declaredComplete:exact.complete,decodedFrames,events:summary.events,
     decodedPixelHashesVerified:decodedFrames>0,recordingComplete:summary.recordingComplete,
     state:{grid:channel(summary.grid),input:channel(summary.input),inventory:channel(summary.inventory),
       unknown:channel(summary.unknownLifecycle),freshness:channel(summary.freshness)},
     rasterProof:summary.rasterProof?{supported:summary.rasterProof.supported,complete:summary.rasterProof.complete,
       matches:summary.rasterProof.matches}:null},
   deliveredInputCoverage,scope:{...scope,payloadPixelsDecoded:decodedFrames>0}};
}

async function main(args:string[]){
 if(args.length!==1)throw Error('Usage: node --import tsx scripts/verify-replay-input.ts <file.loareplay>');
 const blob=await openAsBlob(resolve(args[0]));
 const result=await verifyReplayInput(blob,new AbortController().signal);
 process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
