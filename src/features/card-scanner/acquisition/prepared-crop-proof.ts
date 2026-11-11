import type {Box} from './detector';
import type {PixelRaster} from './pixel-raster';
import {pixelHash} from '../reproduction/recording-frame-integrity';
import {parseMeasuredSourceRasterReceipt,type MeasuredSourceRasterReceipt} from './source-raster-receipt';

/** A bounded diagnostic from one prepared acquisition Worker invocation.
 * This is not an authenticated ObservationSource, OCR input, card identity,
 * unobstructed image, or a scan-completion proof. A consumer must separately
 * validate the measured frame against the input and its canonical-store ACK. */
export interface PreparedCropProof {
  readonly version:1;
  readonly scope:'prepared-worker-crop';
  readonly frame:MeasuredSourceRasterReceipt;
  readonly total:number;
  readonly checked:number;
  readonly unsupported:number;
  readonly mismatch:number;
  readonly overBudget:number;
  readonly hashFailed:number;
  /** Bytes submitted for hashing, including a failed or later-invalidated digest. */
  readonly bytesHashed:number;
  /** Recheck of this Worker readback against its original measured hash. This
   * is not a canonical ACK, capture-source attestation, or OCR proof. */
  readonly frameCheck:'match'|'mismatch'|'failed'|'unsupported'|'not-needed';
  readonly frameBytesHashed:number;
  /** Deadline reached or a previous digest remains in flight. Neither is a
   * negative crop result; hashFailed includes unexamined cells in this case. */
  readonly timedOut:boolean;
  readonly hashBusy:boolean;
  readonly crops:readonly {readonly slot:number;readonly content:Readonly<Box>;readonly sha256:string}[];
}

export const PREPARED_CROP_PROOF_LIMITS=Object.freeze({cells:40,totalBytes:8*1024*1024,cellBytes:1024*1024,frameBytes:32*1024*1024,deadlineMs:750});
type Crop={readonly slot:number;readonly content:Box;readonly complete:boolean;readonly pixels?:PixelRaster};

type DigestResult={kind:'ok';value:string;started:true}|{kind:'failed'|'timed-out'|'busy';started:boolean};
/** One Worker owns one prover. A timed-out digest may continue internally, so
 * no subsequent digest is started until it settles. The late task owns only
 * its bounded snapshot; it cannot mutate source pixels or create a proof. */
export function createPreparedCropProver(options:{deadlineMs?:number;hash?:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>}={}){
  const deadlineMs=options.deadlineMs??PREPARED_CROP_PROOF_LIMITS.deadlineMs,hash=options.hash??pixelHash;
  if(!Number.isFinite(deadlineMs)||deadlineMs<=0||deadlineMs>5000||typeof hash!=='function')throw Error('Invalid prepared crop proof deadline');
  let running=false;
  async function digest(bytes:Uint8Array<ArrayBuffer>,deadline:number):Promise<DigestResult>{
    const delay=deadline-performance.now();
    if(delay<=0)return {kind:'timed-out',started:false};
    if(running)return {kind:'busy',started:false};
    running=true;
    const task=Promise.resolve().then(()=>hash(bytes)).then(
      value=>({kind:'ok' as const,value,started:true as const}),()=>({kind:'failed' as const,started:true as const}));
    // Attach both handlers before racing, so a late rejection is observed.
    void task.then(()=>{running=false;},()=>{running=false;});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([task,new Promise<DigestResult>(resolve=>{
      timer=setTimeout(()=>resolve({kind:'timed-out',started:true}),delay);
    })]);}finally{if(timer!==undefined)clearTimeout(timer);}
  }
  return {measure:(frame:MeasuredSourceRasterReceipt,source:Uint8ClampedArray,cells:readonly Crop[])=>
    preparedCropProof(frame,source,cells,digest,performance.now()+deadlineMs)};
}

/** Compare only integer, in-frame, complete and opaque 1:1 RGBA crops with
 * the same detector readback. One bounded snapshot/digest is in flight at a
 * time. Both buffers are checked again after the digest resolves, before the
 * caller transfers them. Unsupported or changed pixels are not negatives and
 * cannot justify an identity or completion decision. */
async function preparedCropProof(frame:MeasuredSourceRasterReceipt,source:Uint8ClampedArray,cells:readonly Crop[],
  digest:(bytes:Uint8Array<ArrayBuffer>,deadline:number)=>Promise<DigestResult>,deadline:number):Promise<PreparedCropProof> {
  const measured=parseMeasuredSourceRasterReceipt(frame),{width,height}=measured;
  if(!(source instanceof Uint8ClampedArray)||source.length!==width*height*4||!Array.isArray(cells)||
     cells.length>PREPARED_CROP_PROOF_LIMITS.cells)throw Error('Invalid prepared crop proof source');
  let unsupported=0,mismatch=0,overBudget=0,hashFailed=0,bytesHashed=0,frameBytesHashed=0;
  let timedOut=false,hashBusy=false;
  let frameCheck:PreparedCropProof['frameCheck']='not-needed';
  const crops:{slot:number;content:Readonly<Box>;sha256:string;data:Uint8ClampedArray;
    input:Crop;index:number;originalBox:Box;originalPixels:PixelRaster}[]=[];
  const finish=()=>Object.freeze({version:1 as const,scope:'prepared-worker-crop' as const,frame:measured,total:cells.length,
    checked:crops.length,unsupported,mismatch,overBudget,hashFailed,bytesHashed,frameCheck,frameBytesHashed,timedOut,hashBusy,
    crops:Object.freeze(crops.map(({data:_data,input:_input,index:_index,originalBox:_originalBox,originalPixels:_originalPixels,...crop})=>Object.freeze(crop)))});
  if(source.byteLength>PREPARED_CROP_PROOF_LIMITS.frameBytes){unsupported=cells.length;frameCheck='unsupported';return finish();}
  const slots=new Map<number,number>();
  for(const cell of cells)if(Number.isSafeInteger(cell?.slot)&&cell.slot>=0&&cell.slot<40)
    slots.set(cell.slot,(slots.get(cell.slot)??0)+1);
  for(const [index,cell] of cells.entries()){
    if(timedOut||hashBusy){hashFailed++;continue;}
    const inputBox=cell?.content,pixels=cell?.pixels;
    if(!cell||!Number.isSafeInteger(cell.slot)||cell.slot<0||cell.slot>=40||slots.get(cell.slot)!==1||
       !inputBox||![inputBox.x,inputBox.y,inputBox.width,inputBox.height].every(Number.isSafeInteger)||
       inputBox.x<0||inputBox.y<0||inputBox.width<1||inputBox.height<1||inputBox.x+inputBox.width>width||inputBox.y+inputBox.height>height||
       cell.complete!==true||!pixels||pixels.width!==inputBox.width||pixels.height!==inputBox.height||
       !(pixels.data instanceof Uint8ClampedArray)||pixels.data.length!==inputBox.width*inputBox.height*4){unsupported++;continue;}
    const box=Object.freeze({x:inputBox.x,y:inputBox.y,width:inputBox.width,height:inputBox.height}),data=pixels.data,slot=cell.slot;
    const bytes=box.width*box.height*4;
    if(bytes>PREPARED_CROP_PROOF_LIMITS.cellBytes||bytesHashed+bytes>PREPARED_CROP_PROOF_LIMITS.totalBytes){overBudget++;continue;}
    const compare=(expected?:Uint8Array):'equal'|'transparent'|'changed'=>{
      for(let y=0;y<box.height;y++)for(let x=0;x<box.width;x++){
        const src=((box.y+y)*width+box.x+x)*4,dst=(y*box.width+x)*4;
        if(source[src+3]!==255||data[dst+3]!==255)return 'transparent';
        for(let c=0;c<4;c++)if(source[src+c]!==data[dst+c]||expected&&expected[dst+c]!==data[dst+c])return 'changed';
      }
      return 'equal';
    };
    const before=compare();
    if(before!=='equal'){if(before==='transparent')unsupported++;else mismatch++;continue;}
    const snapshot=new Uint8Array(data),result=await digest(snapshot,deadline);
    if(result.started)bytesHashed+=bytes;
    if(result.kind!=='ok'){
      timedOut=result.kind==='timed-out';hashBusy=result.kind==='busy';hashFailed++;continue;
    }
    if(typeof result.value!=='string'||!/^[a-f0-9]{64}$/.test(result.value)||compare(snapshot)!=='equal'){hashFailed++;continue;}
    crops.push({slot,content:box,sha256:result.value,data,input:cell,index,originalBox:inputBox,originalPixels:pixels});
  }
  if(timedOut||hashBusy){frameCheck='failed';hashFailed+=crops.length;crops.length=0;}
  else if(crops.length){
    // The earlier measured hash was computed from this readback before the
    // detector ran. Rehash a snapshot after crop work and check the borrowed
    // bytes synchronously after await; otherwise a changed frame could be
    // paired with the older receipt. This is bounded separately from crops.
    const snapshot=new Uint8Array(source),result=await digest(snapshot,deadline);
    if(result.started)frameBytesHashed=snapshot.byteLength;
    if(result.kind==='ok')frameCheck=typeof result.value==='string'&&result.value===measured.hash&&
      snapshot.every((value,index)=>value===source[index])?'match':'mismatch';
    else {frameCheck='failed';timedOut=result.kind==='timed-out';hashBusy=result.kind==='busy';}
    if(frameCheck!=='match'){hashFailed+=crops.length;crops.length=0;}
    else for(let i=crops.length-1;i>=0;i--){
      const {content:box,data,input,index,originalBox,originalPixels,slot}=crops[i];
      // The caller must transfer the same cell and raster we compared. A
      // replacement, even with equal-looking pixels, was never hashed.
      let equal=cells[index]===input&&input.slot===slot&&input.complete===true&&input.content===originalBox&&
        originalBox.x===box.x&&originalBox.y===box.y&&originalBox.width===box.width&&originalBox.height===box.height&&
        input.pixels===originalPixels&&originalPixels.data===data&&originalPixels.width===box.width&&originalPixels.height===box.height&&
        data.length===box.width*box.height*4;
      for(let y=0;y<box.height&&equal;y++)for(let x=0;x<box.width*4;x++)
        if(source[((box.y+y)*width+box.x)*4+x]!==data[y*box.width*4+x]){equal=false;break;}
      if(!equal){hashFailed++;crops.splice(i,1);}
    }
  }
  return finish();
}
