import test from 'node:test';
import assert from 'node:assert/strict';
import {commitScanMonitorFeedback} from '../src/features/card-scanner/scan-monitor-feedback-dom';
import type {ScannerFeedback,FeedbackDomBinding} from '../src/features/card-scanner/scanner-feedback';
import type {ScanMonitorState} from '../src/features/card-scanner/scan-monitor-store';

const rectangle=(left=20,top=20,width=10,height=10)=>({left,top,width,height,right:left+width,bottom:top+height}) as DOMRect;
class OwnerDocument{
  visibilityState='visible';hidden=false;
  documentElement={clientWidth:340,clientHeight:860};
  defaultView:{innerWidth:number;innerHeight:number;closed:boolean;getComputedStyle:(element:StubElement)=>CSSStyleDeclaration}|null;
  constructor(){this.defaultView={innerWidth:340,innerHeight:860,closed:false,getComputedStyle:element=>{
    assert.equal(element.ownerDocument,this,'styles must use the target owner window');
    if(element.styleFailure)throw Error('style unavailable');return element.computed as unknown as CSSStyleDeclaration;
  }};}
}
class StubElement{
  tagName='SPAN';isConnected=true;parentElement:StubElement|null=null;
  classNames=new Set<string>();classList={contains:(name:string)=>this.classNames.has(name)};
  textContent='';attributes=new Map<string,string>();style={transform:'',height:''};
  computed={display:'block',visibility:'visible',opacity:'1',contentVisibility:'visible',overflowX:'visible',overflowY:'visible',transform:'none'};
  rectangles=[rectangle()];styleFailure=false;rectFailure=false;
  clientLeft=0;clientTop=0;clientWidthOverride:number|undefined;clientHeightOverride:number|undefined;
  get clientWidth(){return this.clientWidthOverride??this.getBoundingClientRect().width;}
  get clientHeight(){return this.clientHeightOverride??this.getBoundingClientRect().height;}
  get offsetWidth(){return this.getBoundingClientRect().width;}
  get offsetHeight(){return this.getBoundingClientRect().height;}
  matches=new Map<string,StubElement[]>();
  ownerDocument:OwnerDocument;
  constructor(document:OwnerDocument){this.ownerDocument=document;}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  getClientRects(){if(this.rectFailure)throw Error('rect unavailable');return this.rectangles;}
  getBoundingClientRect(){return this.rectangles[0]??rectangle(0,0,0,0);}
  contains(element:StubElement){let current:StubElement|null=element;for(let depth=0;current&&depth<130;depth++,current=current.parentElement)if(current===this)return true;return false;}
  querySelectorAll(selector:string){return this.matches.get(selector)??[];}
  asElement(){return this as unknown as HTMLElement;}
}
const snapshot=():ScanMonitorState=>({currentRunRead:1,expected:384,capacity:450,hasInput:true,grid:{located:true,liveTracking:true,liveTop:2,
  cells:Array.from({length:40},(_,slot)=>({status:'waiting',row:2+Math.floor(slot/10)})),
  recentFrame:{frame:4,cells:Array.from({length:40},(_,slot)=>({status:slot===3?'read':'waiting'}))}}});
function recentBinding():FeedbackDomBinding{
  const target={kind:'slot',key:'recent-4-3',status:'read'};
  return {publication:{},fact:{},surface:'recent-frame-grid',slot:3,displayFrame:4,target,join:{id:1,kind:'read-task-end',
    source:{sessionId:'session-1',frameId:901,observationId:'trace-1',captureOrder:10,captureTime:40_000,phase:'input',slot:3},
    processingFrame:4,previewSampleId:null,attemptId:2,atMs:100,target}} as unknown as FeedbackDomBinding;
}
function viewportBinding():FeedbackDomBinding{
  const target={kind:'scrollbar',key:'viewport-2',status:'tracking'};
  return {publication:{},fact:{},surface:'live-scrollbar',top:2,target,join:{id:2,kind:'viewport',source:null,
    processingFrame:null,previewSampleId:77,attemptId:null,atMs:100,target}} as unknown as FeedbackDomBinding;
}
function fixture(binding=recentBinding()){
  const document=new OwnerDocument(),root=new StubElement(document),target=new StubElement(document),ancestor=new StubElement(document);
  root.tagName='SECTION';root.rectangles=[rectangle(0,0,340,800)];root.parentElement=ancestor;ancestor.rectangles=[rectangle(0,0,340,860)];
  target.parentElement=root;
  if(binding.surface==='recent-frame-grid'){
    target.classNames=new Set(['monitor-dot','is-read']);target.textContent='✓';target.attributes.set('data-monitor-recent-slot','3');
    root.matches.set('.monitor-capture-cells [data-monitor-recent-slot="3"]',[target]);
  }else{
    target.tagName='DIV';target.classNames=new Set(['monitor-viewport']);target.attributes.set('data-monitor-viewport-top','2');
    target.attributes.set('aria-hidden','true');target.style={transform:'translateY(12px)',height:'48px'};
    root.matches.set('.monitor-map [data-monitor-viewport-top="2"]',[target]);
  }
  const state=snapshot(),calls={bindings:0,acknowledgements:0,samples:0,done:0,snapshots:[] as object[],rejections:[] as string[]};
  let list:readonly FeedbackDomBinding[]=[binding],allow=true,onAck:(()=>void)|undefined;
  const feedback={bindings(value:object){calls.bindings++;assert.equal(value,state);return list;},
    rejectDom(value:object,item:FeedbackDomBinding,reason:string){assert.equal(value,state);assert.equal(item,binding);calls.rejections.push(reason);},
    acknowledge(value:object,item:FeedbackDomBinding){calls.acknowledgements++;assert.equal(value,state);assert.equal(item,binding);
      onAck?.();if(allow)calls.samples++;return allow;},
    commitDone(value:object){calls.done++;calls.snapshots.push(value);assert.equal(value,state);},
  } as unknown as ScannerFeedback;
  const commit=(status={busy:true,sharing:true})=>commitScanMonitorFeedback(root.asElement(),state,feedback,status);
  return {document,root,target,ancestor,state,binding,feedback,calls,commit,setBindings(value:readonly FeedbackDomBinding[]){list=value;},deny(){allow=false;},onAck(action:()=>void){onAck=action;}};
}

test('exact recent-frame source/slot/status and visible glyph acknowledge the original canonical object',()=>{
  const value=fixture();value.commit();
  assert.equal(value.calls.samples,1);assert.equal(value.calls.done,1);assert.equal(value.calls.snapshots[0],value.state);
  // The acquisition frame namespace deliberately differs from processingFrame.
  assert.equal(value.binding.join.source!.frameId,901);assert.equal(value.state.grid!.recentFrame!.frame,4);
});

test('DOM failures distinguish mismatched targets, hidden targets and inspection errors without claiming receipts',()=>{
  for(const reason of ['target','visibility','inspection']){
    const value=fixture();
    if(reason==='target')value.target.textContent='wrong';
    if(reason==='visibility')value.target.computed.display='none';
    if(reason==='inspection')value.target.styleFailure=true;
    value.commit();value.commit();
    assert.deepEqual(value.calls.rejections,[reason]);
    assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);
  }
});

test('identical green appearance cannot acknowledge another display frame, display slot or canonical status',()=>{
  const changes=[
    (value:ReturnType<typeof fixture>)=>{(value.binding as {displayFrame:number}).displayFrame=5;},
    (value:ReturnType<typeof fixture>)=>{(value.binding as {slot:number}).slot=4;},
    (value:ReturnType<typeof fixture>)=>{value.state.grid!.recentFrame!.frame=5;},
    (value:ReturnType<typeof fixture>)=>{value.state.grid!.recentFrame!.cells[3].status='review';},
    (value:ReturnType<typeof fixture>)=>{value.state.grid!.recentFrame=undefined;},
    (value:ReturnType<typeof fixture>)=>{value.state.grid!.recentFrame!.cells.length=3;},
  ];
  for(const change of changes){const value=fixture();change(value);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('owned moved projection keeps original coordinates while acknowledging the current display cell',()=>{
  const binding=recentBinding();
  (binding.join as {processingFrame:number}).processingFrame=100;
  (binding.join.source as {slot:number}).slot=12;
  (binding.target as {key:string}).key='frame:100:slot:12';
  const value=fixture(binding);value.commit();
  assert.equal(value.calls.samples,1);assert.equal(value.calls.done,1);
  assert.equal(binding.join.processingFrame,100);assert.equal(binding.join.source!.slot,12);
  assert.equal(binding.displayFrame,4);assert.equal(binding.slot,3);assert.equal(binding.join.atMs,100);
});

test('moved projection never selects an original-slot marker instead of the witnessed display slot',()=>{
  const binding=recentBinding();(binding.join as {processingFrame:number}).processingFrame=100;
  (binding.join.source as {slot:number}).slot=12;(binding.target as {key:string}).key='frame:100:slot:12';
  const value=fixture(binding);value.root.matches.clear();
  value.target.attributes.set('data-monitor-recent-slot','12');
  value.root.matches.set('.monitor-capture-cells [data-monitor-recent-slot="12"]',[value.target]);
  value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);
});

test('missing display witness and malformed original metadata cannot fall back to equal coordinates or colors',()=>{
  const changes=[
    (value:ReturnType<typeof fixture>)=>{(value.binding as {displayFrame:unknown}).displayFrame=undefined;},
    (value:ReturnType<typeof fixture>)=>{(value.binding as {slot:unknown}).slot=undefined;},
    (value:ReturnType<typeof fixture>)=>{(value.binding.join as {processingFrame:number}).processingFrame=0;},
    (value:ReturnType<typeof fixture>)=>{(value.binding.join.source as {slot:number}).slot=40;},
    (value:ReturnType<typeof fixture>)=>{(value.binding.join as {attemptId:number}).attemptId=-1;},
  ];
  for(const change of changes){const value=fixture();change(value);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('actual marker class and glyph must both match without conflicting status classes',()=>{
  for(const change of [
    (target:StubElement)=>{target.textContent='!';},
    (target:StubElement)=>{target.classNames=new Set(['monitor-dot','is-review']);},
    (target:StubElement)=>{target.classNames.add('is-review');},
    (target:StubElement)=>{target.tagName='DIV';},
    (target:StubElement)=>{target.attributes.set('data-monitor-recent-slot','4');},
  ]){const value=fixture();change(value.target);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('waiting, reading and review match their actual rendered glyphs',()=>{
  for(const [status,glyph] of [['waiting',''],['reading','•'],['review','!']] as const){
    const binding=recentBinding();(binding.target as {status:string}).status=status;
    (binding.join as {kind:string}).kind=status==='reading'?'read-task-start':status==='waiting'?'crop-queued':'read-task-end';
    (binding.join as {attemptId:number}).attemptId=status==='waiting'?0:2;
    const value=fixture(binding);value.state.grid!.recentFrame!.cells[3].status=status;
    value.target.classNames=new Set(['monitor-dot','is-'+status]);value.target.textContent=glyph;
    value.commit();assert.equal(value.calls.samples,1);assert.equal(value.calls.done,1);
  }
});

test('missing, duplicate, disconnected or foreign-owner targets produce no receipt',()=>{
  for(const change of [
    (value:ReturnType<typeof fixture>)=>{value.root.matches.clear();},
    (value:ReturnType<typeof fixture>)=>{value.root.matches.set('.monitor-capture-cells [data-monitor-recent-slot="3"]',[value.target,value.target]);},
    (value:ReturnType<typeof fixture>)=>{value.target.isConnected=false;},
    (value:ReturnType<typeof fixture>)=>{value.root.isConnected=false;},
    (value:ReturnType<typeof fixture>)=>{value.target.parentElement=null;},
    (value:ReturnType<typeof fixture>)=>{value.target.ownerDocument=new OwnerDocument();},
  ]){const value=fixture();change(value);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('hidden owner documents and missing or closed owner windows cannot acknowledge',()=>{
  for(const change of [
    (document:OwnerDocument)=>{document.visibilityState='hidden';document.hidden=true;},
    (document:OwnerDocument)=>{document.defaultView=null;},
    (document:OwnerDocument)=>{document.defaultView!.closed=true;},
    (document:OwnerDocument)=>{document.defaultView!.innerWidth=0;},
  ]){const value=fixture();change(value.document);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('positive client geometry and an actual owner-viewport intersection are required',()=>{
  for(const rect of [rectangle(10,10,0,10),rectangle(-30,10,10,10),rectangle(400,10,10,10),rectangle(10,900,10,10),rectangle(NaN,10,10,10)]){
    const value=fixture();value.target.rectangles=[rect];value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);
  }
  const value=fixture();value.target.rectangles=[rectangle(-5,10,10,10)];value.commit();assert.equal(value.calls.samples,1);
});

test('hidden or transparent ancestors and clipped-away target rectangles cannot acknowledge',()=>{
  for(const change of [
    (value:ReturnType<typeof fixture>)=>{value.target.computed.display='none';},
    (value:ReturnType<typeof fixture>)=>{value.root.computed.visibility='hidden';},
    (value:ReturnType<typeof fixture>)=>{value.ancestor.computed.opacity='0';},
    (value:ReturnType<typeof fixture>)=>{value.root.computed.contentVisibility='hidden';},
    (value:ReturnType<typeof fixture>)=>{value.root.computed.overflowY='hidden';value.root.rectangles=[rectangle(0,0,340,10)];},
  ]){const value=fixture();change(value);value.commit();assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);}
});

test('scrollbar and border strips are excluded from viewport and ancestor scrollports',()=>{
  const viewport=fixture();viewport.document.documentElement.clientWidth=320;viewport.target.rectangles=[rectangle(330,20,5,10)];
  viewport.commit();assert.equal(viewport.calls.samples,0);assert.equal(viewport.calls.done,1);
  const clipped=fixture();clipped.root.rectangles=[rectangle(0,0,200,800)];clipped.root.computed.overflowX='auto';
  clipped.root.clientLeft=5;clipped.root.clientWidthOverride=180;clipped.target.rectangles=[rectangle(190,20,5,10)];
  clipped.commit();assert.equal(clipped.calls.samples,0);assert.equal(clipped.calls.done,1);
  const inside=fixture();inside.root.rectangles=[rectangle(0,0,200,800)];inside.root.computed.overflowX='auto';
  inside.root.clientLeft=5;inside.root.clientWidthOverride=180;inside.target.rectangles=[rectangle(170,20,10,10)];
  inside.commit();assert.equal(inside.calls.samples,1);
});

test('ambiguous transformed ancestors and cyclic ancestry do not acquire visibility authority',()=>{
  const transformed=fixture();transformed.ancestor.computed.transform='matrix(0, 1, -1, 0, 0, 0)';transformed.commit();
  assert.equal(transformed.calls.samples,0);assert.equal(transformed.calls.done,1);
  const cyclic=fixture();cyclic.ancestor.parentElement=cyclic.root;cyclic.commit();assert.equal(cyclic.calls.samples,0);assert.equal(cyclic.calls.done,1);
});

test('PiP consults its own document and styles while the unrelated parent document is hidden',()=>{
  const parent=new OwnerDocument();parent.visibilityState='hidden';parent.hidden=true;
  parent.defaultView!.getComputedStyle=()=>{assert.fail('parent window must not inspect a PiP target');};
  const pip=fixture();pip.commit();assert.equal(pip.calls.samples,1);assert.equal(pip.calls.done,1);
  const hiddenPip=fixture();hiddenPip.document.visibilityState='hidden';hiddenPip.commit();assert.equal(hiddenPip.calls.samples,0);
});

test('viewport receipt requires actual live top, inline transform/height and estimated class',()=>{
  const value=fixture(viewportBinding());value.commit();assert.equal(value.calls.samples,1);assert.equal(value.calls.done,1);
  for(const change of [
    (item:ReturnType<typeof fixture>)=>{item.state.grid!.liveTracking=false;},
    (item:ReturnType<typeof fixture>)=>{item.state.grid!.liveTop=3;},
    (item:ReturnType<typeof fixture>)=>{item.target.attributes.set('data-monitor-viewport-top','3');},
    (item:ReturnType<typeof fixture>)=>{item.target.style.transform='translateY(24px)';},
    (item:ReturnType<typeof fixture>)=>{item.target.style.height='36px';},
    (item:ReturnType<typeof fixture>)=>{item.target.classNames.add('is-estimated');},
  ]){const item=fixture(viewportBinding());change(item);item.commit();assert.equal(item.calls.samples,0);assert.equal(item.calls.done,1);}
  const estimated=fixture(viewportBinding());estimated.state.grid!.located=false;estimated.target.classNames.add('is-estimated');estimated.commit();assert.equal(estimated.calls.samples,1);
});

test('recent targets require busy and viewport targets require sharing despite stale matching DOM',()=>{
  const recent=fixture();recent.commit({busy:false,sharing:true});assert.equal(recent.calls.samples,0);
  const viewport=fixture(viewportBinding());viewport.commit({busy:true,sharing:false});assert.equal(viewport.calls.samples,0);
});

test('StrictMode repeats and reentrant effects never duplicate acknowledgements or closure',()=>{
  const value=fixture();value.onAck(()=>value.commit());value.commit();value.commit();value.commit();
  assert.equal(value.calls.bindings,1);assert.equal(value.calls.samples,1);assert.equal(value.calls.done,1);
});

test('orchestrator rejection retains attempt authority even when all DOM checks match',()=>{
  const binding=recentBinding();(binding.join as {processingFrame:number}).processingFrame=100;
  (binding.join.source as {slot:number}).slot=12;
  const value=fixture(binding);value.deny();value.commit();assert.equal(value.calls.acknowledgements,1);assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);
});

test('no root and DOM getter failures still close the publication once without throwing',()=>{
  const absent=fixture();commitScanMonitorFeedback(null,absent.state,absent.feedback,{busy:true,sharing:true});
  assert.equal(absent.calls.samples,0);assert.equal(absent.calls.done,1);
  for(const change of [(value:ReturnType<typeof fixture>)=>{value.target.rectFailure=true;},(value:ReturnType<typeof fixture>)=>{value.ancestor.styleFailure=true;}]){
    const value=fixture();change(value);assert.doesNotThrow(()=>value.commit());assert.equal(value.calls.samples,0);assert.equal(value.calls.done,1);
  }
});

test('unexpected oversized binding lists cannot expand DOM work',()=>{
  const value=fixture();value.setBindings(Array.from({length:129},()=>value.binding));value.commit();
  assert.equal(value.calls.acknowledgements,0);assert.equal(value.calls.done,1);
});

test('no canonical snapshot or feedback creates no authority or measurement work',()=>{
  const value=fixture();commitScanMonitorFeedback(value.root.asElement(),null,value.feedback,{busy:true,sharing:true});
  commitScanMonitorFeedback(value.root.asElement(),value.state,undefined,{busy:true,sharing:true});
  assert.equal(value.calls.bindings,0);assert.equal(value.calls.done,0);
});
