// Dev only: copy a sealed server recording into a new one with the current
// lossless codec. Usage: node --import tsx scripts/transcode-recording.mjs <id> <new-id>
import {DEFAULT_RECORDING_ROOT,transcodeRecording} from '../dev/recording-store.ts';
const [id,newId]=process.argv.slice(2);
if(!id||!newId){console.error('Usage: node --import tsx scripts/transcode-recording.mjs <id> <new-id>');process.exit(2);}
const started=Date.now();
const meta=await transcodeRecording(DEFAULT_RECORDING_ROOT,id,newId);
console.log(JSON.stringify({id:meta.id,frames:meta.frames,complete:meta.complete,codec:meta.codec,sha256:meta.sha256,seconds:(Date.now()-started)/1000},null,1));
