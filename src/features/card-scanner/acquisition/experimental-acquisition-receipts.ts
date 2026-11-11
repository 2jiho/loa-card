import type {Box,Layout} from './detector';
import type {ExperimentalExactReceipt} from './card-acquisition';

/** Diagnostic-only transport binding. A validated edge says that the same
 * acquisition worker compared pixels; it is not an ObservationSource, card ID,
 * freshness proof, or a replayable receipt. */
export function createExperimentalAcquisitionReceiptBridge() {
 const frames=new Map<number,{layout:Layout;width:number;height:number;slots:Set<number>}>();
 let generation:string|undefined, last=0, evictedThrough=0, closed=false;
 const validBox=(v:unknown):v is Box=>{
  if(!v||typeof v!=='object')return false;
  const b=v as Box;
  return [b.x,b.y,b.width,b.height].every(Number.isSafeInteger)&&b.width>0&&b.height>0;
 };
 const finiteBox=(v:unknown):v is Box=>{
  if(!v||typeof v!=='object')return false;
  const b=v as Box;
  return [b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0;
 };
 const same=(a:Box,b:Box,dy=0)=>a.x===b.x&&a.y+dy===b.y&&a.width===b.width&&a.height===b.height;
 const snapshot=(layout:Layout,width:number,height:number,slots:readonly number[])=>{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||
    !layout||!finiteBox(layout.area)||!Number.isFinite(layout.scale)||layout.scale<=0||
    !Array.isArray(layout.cells)||layout.cells.length>40||layout.cells.some(b=>!finiteBox(b))||
    slots.some(s=>!Number.isSafeInteger(s)||s<0||s>=layout.cells.length)||new Set(slots).size!==slots.length)
    throw Error('Invalid experimental acquisition frame');
  return {layout:{...layout,area:{...layout.area},cells:layout.cells.map(b=>({...b}))},width,height,slots:new Set(slots),
    supported:validBox(layout.area)&&layout.cells.every(validBox)};
 };
 const invalid=()=>{frames.clear();generation=undefined;throw Error('Invalid experimental acquisition receipt');};
 function accept(id:number,layout:Layout,width:number,height:number,slots:readonly number[],value:unknown):{edges:readonly ExperimentalExactReceipt[];unavailable:number;unsupported:boolean} {
  if(closed||!Number.isSafeInteger(id)||id<=last)throw Error('Invalid experimental acquisition order');
  let current:ReturnType<typeof snapshot>;
  try{current=snapshot(layout,width,height,slots);}catch{return invalid();}
  if(!Array.isArray(value)||value.length>40)return invalid();
  // Fractional detector geometry is a normal capture; it is simply outside
  // this exact integer-geometry experiment and must not interrupt scanning.
  if(!current.supported){if(value.length)return invalid();last=id;return {edges:[],unavailable:0,unsupported:true};}
  const used=new Set<number>(),out:ExperimentalExactReceipt[]=[];let unavailable=0;
  for(const raw of value){
   if(!raw||typeof raw!=='object')return invalid();
   const r=raw as ExperimentalExactReceipt,a=r.from,b=r.to,ga=r.fromGeometry,gb=r.toGeometry;
   if(!a||!b||!ga||!gb||typeof a.generation!=='string'||a.generation.length<1||a.generation.length>160||
      b.generation!==a.generation||generation!==undefined&&generation!==a.generation||
      !Number.isSafeInteger(a.frameId)||a.frameId<1||a.frameId>=id||b.frameId!==id||
      !Number.isSafeInteger(a.slot)||a.slot<0||a.slot>=40||!Number.isSafeInteger(b.slot)||!current.slots.has(b.slot)||used.has(b.slot)||
      !Number.isSafeInteger(r.dy))return invalid();
   const prior=frames.get(a.frameId);
   const bounds=(v:typeof ga.bounds):Box=>({x:v?.left,y:v?.top,width:v?.width,height:v?.height});
   if(!validBox(ga.box)||!validBox(gb.box)||!validBox(ga.content)||!validBox(gb.content)||
      !validBox(ga.area)||!validBox(gb.area)||!validBox(bounds(ga.bounds))||!validBox(bounds(gb.bounds))||
      ga.frameWidth!==width||ga.frameHeight!==height||
      gb.frameWidth!==width||gb.frameHeight!==height||gb.scale!==layout.scale||ga.scale!==gb.scale||
      !same(gb.area,layout.area)||!same(ga.area,gb.area)||!same(gb.box,layout.cells[b.slot])||
      !same(ga.box,gb.box,r.dy)||!same(ga.content,gb.content,r.dy)||!same(bounds(ga.bounds),bounds(gb.bounds),r.dy))return invalid();
   used.add(b.slot);
   // A bounded bridge can no longer authenticate an evicted originating frame.
   // Report that edge as unavailable rather than ending acquisition or silently
   // asserting equality. Unknown non-evicted sources are malformed messages.
   if(!prior){if(a.frameId>evictedThrough)return invalid();unavailable++;continue;}
   if(!prior.slots.has(a.slot)||ga.frameWidth!==prior.width||ga.frameHeight!==prior.height||
      ga.scale!==prior.layout.scale||!same(ga.area,prior.layout.area)||!same(ga.box,prior.layout.cells[a.slot]))return invalid();
   generation??=a.generation;
   // structuredClone severs accidental references held by the message sender.
   out.push(structuredClone(r));
  }
  last=id;frames.set(id,current);
  while(frames.size>160){const oldest=frames.keys().next().value!;frames.delete(oldest);evictedThrough=Math.max(evictedThrough,oldest);}
  return {edges:out,unavailable,unsupported:false};
 }
 return {accept,close(){closed=true;frames.clear();generation=undefined;}};
}
