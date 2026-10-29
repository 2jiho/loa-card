import type {PortraitMatchDiagnostic,PortraitDiagnosticCandidate,PortraitStageDiagnostic,PortraitNumericGateChecks,PortraitTextGateChecks,PortraitDiagnosticBox} from './portrait-matcher';

/** Optional observations only. These values never supply identity or retire a warning. */
export interface PortraitDiagnosticCall {
 readonly source:'computed'|'cached';
 readonly mode:'visual'|'refined'|'text';
 readonly diagnostic:PortraitMatchDiagnostic;
}
export type PortraitDiagnostics=readonly PortraitDiagnosticCall[];
export const MAX_PORTRAIT_DIAGNOSTIC_CALLS=3;
export const MAX_PORTRAIT_DIAGNOSTIC_BYTES=64*1024;
const encoder=new TextEncoder();
const stages=['normal','above-badge','refined-normal','refined-above-badge'] as const;
const reasons=['accepted','invalid-gray-size','insufficient-identities','missing-text-reference','fractional-disabled','not-near','all-stages-rejected'] as const;
function fail():never{throw TypeError('Invalid optional portrait diagnostics');}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const own=Reflect.ownKeys(value);if(own.length!==keys.length)fail();
 const copy:Record<string,unknown>={};
 for(const key of own){if(typeof key!=='string'||!keys.includes(key))fail();
  const field=Object.getOwnPropertyDescriptor(value,key);if(!field||!field.enumerable||!('value'in field))fail();copy[key]=field.value;}
 return copy;
}
function array<T>(value:unknown,maximum:number,parse:(entry:unknown)=>T):readonly T[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail();
 const length=Object.getOwnPropertyDescriptor(value,'length');if(!length||!('value'in length))fail();
 const count=integer(length.value,0,maximum),keys=Reflect.ownKeys(value);if(keys.length!==count+1)fail();
 const output:T[]=[];
 for(let index=0;index<count;index++){
  const field=Object.getOwnPropertyDescriptor(value,String(index));if(!field||!field.enumerable||!('value'in field))fail();output.push(parse(field.value));
 }
 return Object.freeze(output);
}
function number(value:unknown,minimum:number,maximum:number):number{
 if(typeof value!=='number'||!Number.isFinite(value)||value<minimum||value>maximum)fail();return value;
}
function integer(value:unknown,minimum:number,maximum:number):number{const result=number(value,minimum,maximum);if(!Number.isSafeInteger(result))fail();return result;}
function boolean(value:unknown):boolean{if(typeof value!=='boolean')fail();return value;}
function maybeBoolean(value:unknown):boolean|null{return value===null?null:boolean(value);}
function nullableNumber(value:unknown,minimum:number,maximum:number):number|null{return value===null?null:number(value,minimum,maximum);}
function enumeration<T extends string>(value:unknown,allowed:readonly T[]):T{if(typeof value!=='string'||!allowed.includes(value as T))fail();return value as T;}
function id(value:unknown):string{
 if(typeof value!=='string'||!value.length||value.length>96)fail();
 for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<32||code>=127&&code<=159)fail();}
 return value;
}
function box(value:unknown):Readonly<PortraitDiagnosticBox>{
 const input=object(value,['x','y','width','height']),x=number(input.x,0,24),y=number(input.y,0,32),width=number(input.width,0,24),height=number(input.height,0,32);
 if(!width||!height||x+width>24||y+height>32)fail();return Object.freeze({x,y,width,height});
}
function numericChecks(value:unknown):Readonly<PortraitNumericGateChecks>{
 const input=object(value,['upper','lower','correlation','margin','left','right']);
 return Object.freeze({upper:boolean(input.upper),lower:boolean(input.lower),correlation:boolean(input.correlation),margin:boolean(input.margin),left:maybeBoolean(input.left),right:maybeBoolean(input.right)});
}
function textChecks(value:unknown):Readonly<PortraitTextGateChecks>{
 const input=object(value,['upper','lower','correlation','margin','left','right','visibleLength','complete','hangulComplete','ocrConfidence','score','gap']);
 return Object.freeze({upper:boolean(input.upper),lower:boolean(input.lower),correlation:boolean(input.correlation),margin:boolean(input.margin),left:maybeBoolean(input.left),right:maybeBoolean(input.right),
  visibleLength:boolean(input.visibleLength),complete:maybeBoolean(input.complete),hangulComplete:maybeBoolean(input.hangulComplete),ocrConfidence:boolean(input.ocrConfidence),score:boolean(input.score),gap:boolean(input.gap)});
}
function candidate(value:unknown):PortraitDiagnosticCandidate{
 const input=object(value,['id','idTruncated','upper','lower','left','right','correlation','margin','evaluatedForAcceptance','registration','roi']);
 let registration:PortraitDiagnosticCandidate['registration']=null,roi:PortraitDiagnosticCandidate['roi']=null;
 if(input.registration!==null){const item=object(input.registration,['dx','dy','interpolation']),dx=number(item.dx,-1,1),dy=number(item.dy,-1,1);
  if(!Number.isInteger(dx*4)||!Number.isInteger(dy*4))fail();
  const interpolation=enumeration(item.interpolation,['integer','bilinear']);if((Number.isInteger(dx)&&Number.isInteger(dy))!==(interpolation==='integer'))fail();
  registration=Object.freeze({dx,dy,interpolation});}
 if(input.roi!==null){const item=object(input.roi,['upper','lower','left','right']);roi=Object.freeze({upper:box(item.upper),lower:box(item.lower),left:item.left===null?null:box(item.left),right:item.right===null?null:box(item.right)});}
 if((registration===null)!==(roi===null))fail();
 // Float32 normalization can exceed the mathematical unit interval by a tiny
 // rounding error. Preserve finite source values rather than clamp them.
 return Object.freeze({id:id(input.id),idTruncated:boolean(input.idTruncated),upper:number(input.upper,-1.0001,1.0001),lower:number(input.lower,-1.0001,1.0001),
  left:nullableNumber(input.left,-1.0001,1.0001),right:nullableNumber(input.right,-1.0001,1.0001),correlation:number(input.correlation,-1.0001,1.0001),
  margin:number(input.margin,-2.0002,2.0002),evaluatedForAcceptance:boolean(input.evaluatedForAcceptance),registration,roi});
}
function stage(value:unknown):PortraitStageDiagnostic{
 const input=object(value,['stage','queryCount','candidates','decision']),decision=object(input.decision,['textIdMatches','independent','text','accepted']);
 const independent=object(decision.independent,['evaluated','passed','checks']),text=object(decision.text,['evaluated','passed','checks']);
 return Object.freeze({stage:enumeration(input.stage,stages),queryCount:integer(input.queryCount,0,81),candidates:array(input.candidates,2,candidate),
  decision:Object.freeze({textIdMatches:maybeBoolean(decision.textIdMatches),independent:Object.freeze({evaluated:boolean(independent.evaluated),passed:maybeBoolean(independent.passed),checks:independent.checks===null?null:numericChecks(independent.checks)}),
   text:Object.freeze({evaluated:boolean(text.evaluated),passed:maybeBoolean(text.passed),checks:text.checks===null?null:textChecks(text.checks)}),accepted:boolean(decision.accepted)})});
}
function diagnostic(value:unknown):PortraitMatchDiagnostic{
 const input=object(value,['version','coordinateSpace','outcome','reason','fractionalRegistration','referenceIdentities','text','stages']);
 if(input.version!==1||input.coordinateSpace!=='gray-grid-24x32')fail();
 let text:PortraitMatchDiagnostic['text']=null;
 if(input.text!==null){const item=object(input.text,['id','idTruncated','ocrConfidence','score','gap','complete','visibleNameLength','canonicalNameLength']);
  text=Object.freeze({id:id(item.id),idTruncated:boolean(item.idTruncated),ocrConfidence:nullableNumber(item.ocrConfidence,0,100),score:nullableNumber(item.score,-2,2),gap:nullableNumber(item.gap,-2,2),
   complete:maybeBoolean(item.complete),visibleNameLength:integer(item.visibleNameLength,0,65536),canonicalNameLength:integer(item.canonicalNameLength,0,65536)});}
 return Object.freeze({version:1,coordinateSpace:'gray-grid-24x32',outcome:enumeration(input.outcome,['accepted','rejected','unavailable']),reason:enumeration(input.reason,reasons),
  fractionalRegistration:boolean(input.fractionalRegistration),referenceIdentities:integer(input.referenceIdentities,0,20000),text,stages:array(input.stages,4,stage)});
}

/** Malformed/missing metadata returns null without affecting scan authority.
 * A captured zero-call array remains []; no arbitrary input getter or toJSON
 * is evaluated, and successful snapshots own only deeply frozen whitelist data. */
export function parsePortraitDiagnostics(input:unknown):PortraitDiagnostics|null{
 try{
  const result=array(input,MAX_PORTRAIT_DIAGNOSTIC_CALLS,value=>{
   const call=object(value,['source','mode','diagnostic']);return Object.freeze({source:enumeration(call.source,['computed','cached']),mode:enumeration(call.mode,['visual','refined','text']),diagnostic:diagnostic(call.diagnostic)});
  });
  return encoder.encode(JSON.stringify(result)).byteLength<=MAX_PORTRAIT_DIAGNOSTIC_BYTES?result:null;
 }catch{return null;}
}
/** Read the optional outer field without invoking an accessor. Other unrelated
 * sidecar fields (including image encoders) are never read or serialized here. */
export function readPortraitDiagnostics(input:unknown):PortraitDiagnostics|null{
 try{if(!input||typeof input!=='object')return null;const field=Object.getOwnPropertyDescriptor(input,'portraitDiagnostics');
  return field&&field.enumerable&&'value'in field?parsePortraitDiagnostics(field.value):null;
 }catch{return null;}
}
