// Dev only: a new recording with a sealed recording's frames in another order, to test scans that
// do not start at the top (docs/dev-recording.md). The source is left untouched.
// Usage: node --import tsx scripts/derive-recording.mjs <id> <new-id> reverse
//        node --import tsx scripts/derive-recording.mjs <id> <new-id> middle=<frame index>
import {DEFAULT_RECORDING_ROOT,deriveRecording} from '../dev/recording-store.ts';
const [id,newId,kind]=process.argv.slice(2);
const middle=/^middle=(\d+)$/.exec(kind??'');
if(!id||!newId||!(kind==='reverse'||middle)){console.error('Usage: node --import tsx scripts/derive-recording.mjs <id> <new-id> reverse|middle=<frame>');process.exit(2);}
const started=Date.now();
const meta=await deriveRecording(DEFAULT_RECORDING_ROOT,id,newId,kind==='reverse'?'reverse':{middle:Number(middle[1])});
console.log(JSON.stringify({id:meta.id,frames:meta.frames,sha256:meta.sha256,note:meta.note,seconds:(Date.now()-started)/1000},null,1));
