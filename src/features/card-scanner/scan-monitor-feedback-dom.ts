import type {ScanMonitorState} from './scan-monitor-store';
import type {ScannerFeedback,FeedbackDomBinding} from './scanner-feedback';

const committed=new WeakMap<ScannerFeedback,WeakSet<object>>();
const statuses=['unknown','waiting','reading','read','review','empty'] as const;
const clipping=new Set(['hidden','clip','scroll','auto']);
const MAX_BINDINGS=128;
const MAX_ANCESTORS=128;
type Bounds={left:number;top:number;right:number;bottom:number};

function bounds(rect:DOMRect):Bounds|null{
  if(![rect.left,rect.top,rect.right,rect.bottom,rect.width,rect.height].every(Number.isFinite)||
    rect.width<=0||rect.height<=0||rect.right<=rect.left||rect.bottom<=rect.top)return null;
  return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom};
}

/** DOM layout visibility only. Uses the target's owner window, including PiP;
 * it does not prove paint, animation completion, foreground or no occlusion. */
function visible(element:HTMLElement,root:HTMLElement):boolean{
  const document=element.ownerDocument,view=document.defaultView;
  if(!element.isConnected||!root.isConnected||root.ownerDocument!==document||!root.contains(element)||
    document.visibilityState!=='visible'||document.hidden||!view||view.closed||
    !Number.isFinite(view.innerWidth)||!Number.isFinite(view.innerHeight)||view.innerWidth<=0||view.innerHeight<=0)return false;
  const viewportWidth=Math.min(view.innerWidth,document.documentElement.clientWidth),viewportHeight=Math.min(view.innerHeight,document.documentElement.clientHeight);
  if(!Number.isFinite(viewportWidth)||!Number.isFinite(viewportHeight)||viewportWidth<=0||viewportHeight<=0)return false;
  let regions=Array.from(element.getClientRects()).map(bounds).filter((value):value is Bounds=>value!==null)
    .map(rect=>({left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(viewportWidth,rect.right),bottom:Math.min(viewportHeight,rect.bottom)}))
    .filter(rect=>rect.right>rect.left&&rect.bottom>rect.top);
  if(!regions.length)return false;
  let ancestor:HTMLElement|null=element,sawRoot=false,depth=0;
  while(ancestor){
    if(++depth>MAX_ANCESTORS||ancestor.ownerDocument!==document||!ancestor.isConnected)return false;
    if(ancestor===root)sawRoot=true;
    const style=view.getComputedStyle(ancestor),opacity=Number(style.opacity);
    if(!style.display||style.display==='none'||style.visibility!=='visible'||!Number.isFinite(opacity)||opacity<=0||style.contentVisibility==='hidden')return false;
    // Nontrivial ancestor transforms make a rectangular scrollport ambiguous.
    // The viewport target's own known translateY is checked separately below.
    if(ancestor!==element&&style.transform&&style.transform!=='none')return false;
    if(ancestor!==element&&(clipping.has(style.overflowX)||clipping.has(style.overflowY))){
      const border=bounds(ancestor.getBoundingClientRect());
      const {clientLeft,clientTop,clientWidth,clientHeight,offsetWidth,offsetHeight}=ancestor;
      if(!border||![clientLeft,clientTop,clientWidth,clientHeight,offsetWidth,offsetHeight].every(Number.isFinite)||
        clientLeft<0||clientTop<0||clientWidth<=0||clientHeight<=0||offsetWidth<=0||offsetHeight<=0)return false;
      // client metrics exclude borders/scrollbars. Scale CSS client coordinates
      // into the rect's coordinate space (e.g. CSS zoom) without guessing paint.
      const scaleX=(border.right-border.left)/offsetWidth,scaleY=(border.bottom-border.top)/offsetHeight;
      const clip={left:border.left+clientLeft*scaleX,top:border.top+clientTop*scaleY,
        right:border.left+(clientLeft+clientWidth)*scaleX,bottom:border.top+(clientTop+clientHeight)*scaleY};
      regions=regions.map(rect=>({
        left:clipping.has(style.overflowX)?Math.max(rect.left,clip.left):rect.left,
        right:clipping.has(style.overflowX)?Math.min(rect.right,clip.right):rect.right,
        top:clipping.has(style.overflowY)?Math.max(rect.top,clip.top):rect.top,
        bottom:clipping.has(style.overflowY)?Math.min(rect.bottom,clip.bottom):rect.bottom,
      })).filter(rect=>rect.right>rect.left&&rect.bottom>rect.top);
      if(!regions.length)return false;
    }
    ancestor=ancestor.parentElement;
  }
  return sawRoot;
}

function one(root:HTMLElement,selector:string):HTMLElement|null{
  const matches=root.querySelectorAll<HTMLElement>(selector);
  return matches.length===1?matches[0]:null;
}

function sameTarget(binding:FeedbackDomBinding){
  const expected=binding.join.target,actual=binding.target;
  return expected.kind===actual.kind&&expected.key===actual.key&&expected.status===actual.status;
}

function recentTarget(root:HTMLElement,snapshot:ScanMonitorState,binding:FeedbackDomBinding,busy:boolean):HTMLElement|null{
  const {slot,displayFrame,join,target}=binding,frame=snapshot.grid?.recentFrame;
  // The owned binding witnesses the actual grid projection. Original source
  // coordinates stay immutable; they need not equal the current display cell.
  if(!busy||target.kind!=='slot'||typeof slot!=='number'||!Number.isInteger(slot)||slot<0||slot>=40||
    typeof displayFrame!=='number'||!Number.isSafeInteger(displayFrame)||displayFrame<1||
    !join.source||join.source.phase!=='input'||!Number.isSafeInteger(join.source.slot)||join.source.slot<0||join.source.slot>=40||
    !['crop-queued','read-task-start','read-task-end'].includes(join.kind)||
    typeof join.processingFrame!=='number'||!Number.isSafeInteger(join.processingFrame)||join.processingFrame<1||
    typeof join.attemptId!=='number'||!Number.isSafeInteger(join.attemptId)||join.attemptId<0||
    !frame||frame.frame!==displayFrame||frame.cells[slot]?.status!==target.status||!sameTarget(binding))return null;
  const cell=one(root,'.monitor-capture-cells [data-monitor-recent-slot="'+slot+'"]');
  if(!cell||cell.tagName!=='SPAN'||cell.getAttribute('data-monitor-recent-slot')!==String(slot)||!cell.classList.contains('monitor-dot')||
    !cell.classList.contains('is-'+target.status)||statuses.some(status=>status!==target.status&&cell.classList.contains('is-'+status)))return null;
  const glyph=target.status==='read'?'✓':target.status==='reading'?'•':target.status==='review'?'!':'';
  return cell.textContent===glyph?cell:null;
}

function viewportTarget(root:HTMLElement,snapshot:ScanMonitorState,binding:FeedbackDomBinding,sharing:boolean):HTMLElement|null{
  const {top,join,target}=binding,grid=snapshot.grid;
  if(!sharing||grid?.liveTracking!==true||typeof top!=='number'||!Number.isInteger(top)||top<1||top>55||grid.liveTop!==top||
    join.kind!=='viewport'||join.source!==null||join.processingFrame!==null||join.previewSampleId===null||join.attemptId!==null||
    target.kind!=='scrollbar'||target.status!=='tracking'||!sameTarget(binding))return null;
  const element=one(root,'.monitor-map [data-monitor-viewport-top="'+top+'"]');
  if(!element||element.tagName!=='DIV'||!element.classList.contains('monitor-viewport')||
    element.getAttribute('data-monitor-viewport-top')!==String(top)||
    element.style.transform!=='translateY('+((top-1)*12)+'px)'||element.style.height!==Math.min(4,55-top+1)*12+'px')return null;
  const tops=grid.located?grid.cells.flatMap((cell,index)=>cell.row===undefined?[]:[cell.row-Math.floor(index/10)]):[];
  const registeredTop=tops.length&&tops.every(value=>value===tops[0])?tops[0]:undefined;
  return element.classList.contains('is-estimated')===(top!==registeredTop)?element:null;
}

/** Commit only this canonical publication's bounded, actually visible targets.
 * The orchestrator still owns source/attempt authority and the parent clock.
 * Missing/hidden/mismatched targets remain absent receipts in commitDone().
 * No state mutation, subscription, notification, timer or DOM write occurs. */
export function commitScanMonitorFeedback(root:HTMLElement|null,snapshot:ScanMonitorState|null,feedback:ScannerFeedback|undefined,
  {busy,sharing}:{busy:boolean;sharing:boolean}):void{
  if(!snapshot||!feedback)return;
  let seen=committed.get(feedback);
  if(!seen){seen=new WeakSet();committed.set(feedback,seen);}
  if(seen.has(snapshot))return;
  seen.add(snapshot); // StrictMode and reentrant observer callbacks stay inert.
  try{
    const bindings=feedback.bindings(snapshot);
    if(!root||!root.isConnected||!Array.isArray(bindings)||bindings.length>MAX_BINDINGS)return;
    for(const binding of bindings){
      try{
        const element=binding.surface==='recent-frame-grid'?recentTarget(root,snapshot,binding,busy):
          binding.surface==='live-scrollbar'?viewportTarget(root,snapshot,binding,sharing):null;
        if(!element)feedback.rejectDom(snapshot,binding,'target');
        else if(!visible(element,root))feedback.rejectDom(snapshot,binding,'visibility');
        else feedback.acknowledge(snapshot,binding);
      }catch{try{feedback.rejectDom(snapshot,binding,'inspection');}catch{/* Optional diagnostics. */}}
    }
  }catch{/* A diagnostic sink failure never acquires receipt authority. */}
  finally{try{feedback.commitDone(snapshot);}catch{/* Optional diagnostics. */}}
}
