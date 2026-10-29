/** Diagnostic provenance only. These facts do not authorize card positions,
 * coverage, current capacity, completion, or a particular total row count. */
export const MAX_SCROLL_CAPTURE_FACT_BYTES=4096;
export const SCROLL_CAPTURE_SAMPLE_WIDTH=16;
export const SCROLL_CAPTURE_SAMPLE_HEIGHT=942;
// The existing strip reader admits integer thumb heights from4% through30%
// of this fixed942px sample and excludes46px of arrow/track boundaries.
// This is a measurement-recipe bound, not an assumption about51 scroll steps.
// A future change to that readback recipe must update these diagnostic bounds.
const track=SCROLL_CAPTURE_SAMPLE_HEIGHT-46;
const minimumThumb=Math.ceil(SCROLL_CAPTURE_SAMPLE_HEIGHT*.04),maximumThumb=Math.floor(SCROLL_CAPTURE_SAMPLE_HEIGHT*.3);
export const MIN_SCROLL_CAPTURE_PAGE_SPAN=minimumThumb/(track-minimumThumb);
export const MAX_SCROLL_CAPTURE_PAGE_SPAN=maximumThumb/(track-maximumThumb);
const MAX_ID=160,MAX_DIMENSION=65_536,MAX_SOURCE_BYTES=128*1024*1024;
const encoder=new TextEncoder();

/** All names are explicit: acquisitionFrameId is the worker request identity,
 * canonicalSourceFrameId is a reserved/committed physical-source identifier;
 * its presence does not prove a successful storage acknowledgement.
 * observationFrameId is the opaque alias for fresh observations from this
 * capture. A cell borrowing saved lineage can retain its prior observation
 * alias; the frame-level fact does not replace that cell's provenance.
 * processingFrame is the scanner invocation ordinal. These IDs are not
 * timestamps or interchangeable identifiers. */
export interface CaptureFrameIdentity {
 readonly sessionId:string;
 readonly processingFrame:number;
 readonly acquisitionFrameId:number;
 readonly canonicalSourceFrameId:number|null;
 readonly observationFrameId:string;
 readonly inputId:number|null;
 readonly captureTime:number;
 readonly phase:'input'|'recovery';
 readonly sourceWidth:number;
 readonly sourceHeight:number;
}
export interface ScrollDiagnosticBox {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export interface RawScrollGeometry {readonly position:number;readonly pageSpan:number}
export type ScrollCaptureState='measured'|'unreadable'|'out-of-bounds'|'not-located'|'queue-full';
export interface ScrollCaptureFact {
 readonly version:1;
 readonly source:CaptureFrameIdentity;
 readonly state:ScrollCaptureState;
 readonly bar:ScrollDiagnosticBox|null;
 /** Actual16x942 readScrollGeometry output before row quantization.
  * Null is an unavailable measurement, never position zero. */
 readonly geometry:RawScrollGeometry|null;
 /** Last available successful header fact in the SAME session, or null.
  * The reference does not assert that its source is current or equally fresh. */
 readonly headerFactId:number|null;
}
export interface InventoryHeaderFact {
 readonly version:1;
 /** A header-read invocation ID, not completion order or capture chronology. */
 readonly factId:number;
 readonly source:CaptureFrameIdentity;
 readonly purpose:'initial'|'auto-completion'|'ended-capture';
 /** The box in the original captured frame, not the small header canvas. */
 readonly headerBox:ScrollDiagnosticBox;
 readonly owned:number;
 readonly capacity:number;
}

function fail(detail:string):never{throw TypeError('Invalid scroll/header capture diagnostic: '+detail);}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||
  ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object');
 const own=Reflect.ownKeys(value);
 if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail('unexpected or missing fields');
 for(const key of own){const property=Object.getOwnPropertyDescriptor(value,key)!;
  if(!('value' in property)||!property.enumerable)fail('own enumerable data property');}
 return value as Record<string,unknown>;
}
function identifier(value:unknown):string{
 if(typeof value!=='string'||!value.length||value.length>MAX_ID)fail('identifier length');
 for(const character of value){const code=character.charCodeAt(0);if(code<32||code>=127&&code<=159)fail('identifier control character');}
 return value;
}
function integer(value:unknown,minimum=1,maximum=Number.MAX_SAFE_INTEGER):number{
 if(!Number.isSafeInteger(value)||(value as number)<minimum||(value as number)>maximum)fail('integer bounds');return value as number;
}
function finite(value:unknown,minimum=0,maximum=Number.MAX_VALUE):number{
 if(typeof value!=='number'||!Number.isFinite(value)||value<minimum||value>maximum)fail('finite number bounds');return value;
}
function nullableId(value:unknown):number|null{return value===null?null:integer(value);}
function frame(value:unknown):CaptureFrameIdentity{
 const entry=record(value,['sessionId','processingFrame','acquisitionFrameId','canonicalSourceFrameId','observationFrameId','inputId','captureTime','phase','sourceWidth','sourceHeight']);
 if(entry.phase!=='input'&&entry.phase!=='recovery')fail('frame phase');
 const sourceWidth=integer(entry.sourceWidth,1,MAX_DIMENSION),sourceHeight=integer(entry.sourceHeight,1,MAX_DIMENSION);
 if(sourceWidth*sourceHeight*4>MAX_SOURCE_BYTES)fail('source raster limit');
 return Object.freeze({sessionId:identifier(entry.sessionId),processingFrame:integer(entry.processingFrame),acquisitionFrameId:integer(entry.acquisitionFrameId),
  canonicalSourceFrameId:nullableId(entry.canonicalSourceFrameId),observationFrameId:identifier(entry.observationFrameId),inputId:nullableId(entry.inputId),
  captureTime:finite(entry.captureTime),phase:entry.phase,sourceWidth,sourceHeight});
}
function box(value:unknown):ScrollDiagnosticBox{
 const entry=record(value,['x','y','width','height']);
 const x=finite(entry.x,-MAX_DIMENSION,MAX_DIMENSION),y=finite(entry.y,-MAX_DIMENSION,MAX_DIMENSION),
  width=finite(entry.width,0,MAX_DIMENSION),height=finite(entry.height,0,MAX_DIMENSION);
 if(width===0||height===0)fail('positive box dimensions');return Object.freeze({x,y,width,height});
}
function inside(source:CaptureFrameIdentity,value:ScrollDiagnosticBox){return value.x>=0&&value.y>=0&&value.x+value.width<=source.sourceWidth&&value.y+value.height<=source.sourceHeight;}
function geometry(value:unknown):RawScrollGeometry{
 const entry=record(value,['position','pageSpan']),position=finite(entry.position,0,1),
  pageSpan=finite(entry.pageSpan,MIN_SCROLL_CAPTURE_PAGE_SPAN,MAX_SCROLL_CAPTURE_PAGE_SPAN);
 return Object.freeze({position,pageSpan});
}
function bounded<T extends ScrollCaptureFact|InventoryHeaderFact>(value:T):T{
 // Only the detached whitelist reaches JSON.stringify; input getters/toJSON
 // cannot run. Never truncate identifiers, numbers, or individual fields.
 if(encoder.encode(JSON.stringify(value)).byteLength>MAX_SCROLL_CAPTURE_FACT_BYTES)fail('serialized4KiB limit');
 return Object.freeze(value);
}
export function parseScrollCaptureFact(value:unknown):ScrollCaptureFact{
 const entry=record(value,['version','source','state','bar','geometry','headerFactId']);if(entry.version!==1)fail('version');
 if(!['measured','unreadable','out-of-bounds','not-located','queue-full'].includes(entry.state as string))fail('measurement state');
 const source=frame(entry.source),bar=entry.bar===null?null:box(entry.bar),raw=entry.geometry===null?null:geometry(entry.geometry),state=entry.state as ScrollCaptureState;
 if(state==='not-located'?(bar!==null||raw!==null):bar===null)fail('state/bar relationship');
 if(state==='measured'?(raw===null||!inside(source,bar!)):raw!==null)fail('state/geometry relationship');
 if(state==='unreadable'&&!inside(source,bar!))fail('unreadable must have an in-bounds measured strip');
 if(state==='out-of-bounds'&&inside(source,bar!))fail('out-of-bounds reason must match the box');
 // A full reader queue exits before the strip readback. Retain the actual box
 // and unavailable geometry without asserting bounds, readability or position.
 return bounded({version:1,source,state,bar,geometry:raw,headerFactId:nullableId(entry.headerFactId)});
}
export function parseInventoryHeaderFact(value:unknown):InventoryHeaderFact{
 const entry=record(value,['version','factId','source','purpose','headerBox','owned','capacity']);if(entry.version!==1)fail('version');
 if(!['initial','auto-completion','ended-capture'].includes(entry.purpose as string))fail('header read purpose');
 // Preserve the current OCR parser's diagnostic range (<=2000), rather than
 // hiding a surprising successful read because the known game maximum is550.
 // This does not declare2000 valid slots or change the actual header parser.
 const owned=integer(entry.owned,0,2000),capacity=integer(entry.capacity,1,2000);if(owned>capacity)fail('owned exceeds capacity');
 return bounded({version:1,factId:integer(entry.factId),source:frame(entry.source),purpose:entry.purpose as InventoryHeaderFact['purpose'],headerBox:box(entry.headerBox),owned,capacity});
}
