import {loadVerifiedReplayOriginal} from './replay-original';

type ReplayInput = {index:number;name:string;bytes:number;type:string;sha256?:string;url:string};
type ReportInput = Omit<ReplayInput,'url'>;
export type ReplayProof<T> = {readonly caseId:string;readonly input:Readonly<ReportInput>;readonly replay:T};

/** The proof is created only after the verified Blob itself was opened. */
export async function openVerifiedReplayCase<T>(caseId:string,input:ReplayInput,signal:AbortSignal,
 open:(blob:Blob,signal:AbortSignal)=>Promise<T>,options?:Parameters<typeof loadVerifiedReplayOriginal>[4]) {
 const snapshot=Object.freeze({...input});
 const blob=await loadVerifiedReplayOriginal(snapshot.url,snapshot.bytes,snapshot.sha256,signal,options);
 signal.throwIfAborted();
 const replay=await open(blob,signal);
 signal.throwIfAborted();
 const {url: _url,...description}=snapshot;
 return {replay,proof:Object.freeze({caseId,input:Object.freeze(description),replay}) as ReplayProof<T>};
}

/** Match the selected case and the exact opened object actually handed to the
 * replay input, so a previous run or a different manifest cannot lend proof. */
export function verifiedReplayRun<T>(proof:ReplayProof<T>|undefined,context:{caseId:string|null;inputs:ReportInput[];
 replay:T|undefined;started:boolean;outcome:string}) {
 if(!proof||!context.started||context.outcome==='cancelled'||proof.caseId!==context.caseId||
   proof.replay!==context.replay||context.inputs.length!==1)return false;
 const input=context.inputs[0],expected=proof.input;
 return input.index===expected.index&&input.name===expected.name&&input.bytes===expected.bytes&&
   input.type===expected.type&&input.sha256===expected.sha256;
}
