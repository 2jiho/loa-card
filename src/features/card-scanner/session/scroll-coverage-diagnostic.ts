import type {ScrollGap} from './scroll-coverage';

/** Image-free debug facts, never card identity or completion evidence. */
export type ScrollCoverageDiagnostic =
 | {version:1;sessionId:string;ordinal:number;kind:'seed'|'reset'|'checkpoint'}
 | {version:1;sessionId:string;ordinal:number;kind:'offer';processingFrame:number;inputId:number|null;
    captureTime:number;phase:'input'|'recovery';position:number;pageSpan:number;slots:string;
    gaps:ScrollGap[];gapsTruncated:boolean};

/** Parse the serialized facts strictly rather than silently filling fields. */
export function parseScrollCoverageDiagnostic(input:unknown):ScrollCoverageDiagnostic {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid coverage diagnostic');
 const value=input as Record<string,unknown>;
 const keys=value.kind==='offer'?['version','sessionId','ordinal','kind','processingFrame','inputId','captureTime','phase','position','pageSpan','slots','gaps','gapsTruncated']:['version','sessionId','ordinal','kind'];
 if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw Error('Invalid coverage fields');
 const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
 const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
 if(value.version!==1||typeof value.sessionId!=='string'||!value.sessionId||value.sessionId.length>128||!integer(value.ordinal))throw Error('Invalid coverage identity');
 if(value.kind==='seed'||value.kind==='reset'||value.kind==='checkpoint')return {version:1,sessionId:value.sessionId,ordinal:value.ordinal as number,kind:value.kind};
 if(value.kind!=='offer'||!integer(value.processingFrame)||!(value.inputId===null||integer(value.inputId))||!finite(value.captureTime)||(value.captureTime as number)<0||
  (value.phase!=='input'&&value.phase!=='recovery')||!finite(value.position)||(value.position as number)<0||(value.position as number)>1||
  !finite(value.pageSpan)||(value.pageSpan as number)<=0||(value.pageSpan as number)>1||typeof value.slots!=='string'||!/^[01]{40}$/.test(value.slots)||
  typeof value.gapsTruncated!=='boolean'||!Array.isArray(value.gaps)||value.gaps.length>64)throw Error('Invalid coverage offer');
 const gaps=value.gaps.map((gap:unknown)=>{if(!gap||typeof gap!=='object'||Array.isArray(gap))throw Error('Invalid coverage gap');
  const g=gap as Record<string,unknown>;if(Object.keys(g).length!==2||!finite(g.from)||!finite(g.to)||(g.from as number)<0||(g.to as number)<(g.from as number)||(g.to as number)>2)throw Error('Invalid coverage gap');
  return {from:g.from as number,to:g.to as number};});
 return {version:1,sessionId:value.sessionId,ordinal:value.ordinal as number,kind:'offer',processingFrame:value.processingFrame as number,inputId:value.inputId as number|null,
  captureTime:value.captureTime as number,phase:value.phase,position:value.position as number,pageSpan:value.pageSpan as number,slots:value.slots,gaps,gapsTruncated:value.gapsTruncated};
}
