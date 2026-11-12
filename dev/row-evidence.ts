import {InventoryEvidence,CURRENT_INVENTORY_CONSENSUS_POLICY} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {confirmedReadingCount} from '../src/features/card-scanner/session/recovery-completion';
import {timedCaptureOrder} from '../src/features/card-scanner/session/live-scan-policy';
import {observedCard,readFieldReliability,settleReadFields} from '../src/features/card-scanner/session/field-acceptance';
import type {ReadFieldValues} from '../src/features/card-scanner/session/field-acceptance';
import type {CatalogName} from '../src/features/card-scanner/recognition/card-dictionary';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer-types';
import {packCount} from '../src/features/card-scanner/recognition/count-pattern';
import {PREVIEW_ZERO_REASON,needsPreviewZeroProof,previewZeroReading,selectZeroPreview} from '../src/features/card-scanner/session/preview-zero';

/** Development prototype (docs/scanner-live-redesign.md 13.9, step 4). Not a scanner.
 *
 * The scanner's own acceptance and merge for the row-centred reading: every crop the row
 * reading names goes through the shared field acceptance (session/field-acceptance.ts) and
 * into an InventoryEvidence set up as the scanner sets up its own (empty seed, same consensus
 * and count-conflict policies). "Confirmed" is the scanner's `confirmedReadingCount` over the
 * projected cards, so the number can be compared with the scanner's "read" count.
 *
 * After the share it can run the scanner's end-of-scan check of stored previews (`confirmZeros`):
 * a card whose count is still missing or an unconfirmed zero is confirmed as zero only when a
 * kept crop of it shows an explicit empty counter and no later kept crop shows a positive count.
 * The scanner re-reads its saved preview pictures; this keeps the crops themselves (up to 8 per
 * card not yet confirmed), so the pixels read are not the same bytes.
 *
 * What it leaves out of the scanner: the header total, sort, positions, unknown-observation
 * lifecycle, freshness proofs, recovery and completion. It decides nothing about a finished scan. */
export interface RowEvidenceIdentity {
  readonly id:string;readonly name:string;readonly review:readonly string[];readonly maxAwakening?:number;
  readonly nameEvidence?:ScannedCard['nameEvidence'];
}
export interface RowEvidenceInput {
  readonly identity:RowEvidenceIdentity;
  /** The values read from the crop, or null when none were read. Not changed. */
  readonly values:ReadFieldValues|null;
  readonly time:number;readonly slot:number;
  /** A whole number that identifies the frame the crop came from. */
  readonly frameId:number;
  /** The crop's fields matched the same column of the frame before (the scanner's `stable`). */
  readonly stable:boolean;
  readonly borderAlignment:number;
  /** The crop, kept (as a copy) for the end-of-scan zero check while its card is not confirmed. */
  readonly image?:HTMLCanvasElement;
}
export interface RowZeroCheck {
  /** Cards that needed the check, cards it confirmed as zero (names), and crops re-read. */
  readonly checked:number;readonly resolved:readonly string[];readonly previewReads:number;
  /** Cards that needed the check but had no kept crop. */
  readonly withoutPreview:number;
  /** Diagnosis: for each card left unresolved, what every kept crop read (preferred first). */
  readonly unresolved:readonly {readonly name:string;readonly awakening:number;/** The preferred kept crop (PNG data URL), for a person to look at. */readonly picture?:string;/** Diagnosis: what other readings of that crop say. */readonly other?:unknown;readonly readings:readonly {readonly order:number;readonly stable:boolean;
    readonly readAwakening:number|null;readonly readCopies:number|null;readonly iconPresent:boolean|null;readonly zero:boolean;readonly positive:boolean;
    readonly counter:unknown}[]}[];
}
export interface RowEvidence {
  /** The scanner's end-of-scan check of stored previews, for cards whose count is still missing
   * or an unconfirmed zero. `read` is the reader's corroborating visual re-read of a crop. Run
   * once, after everything was read; a crop accepted afterwards cancels its card's result. */
  confirmZeros(read:(image:HTMLCanvasElement,id:string)=>Promise<ReadFieldValues>,
    /** Diagnosis only: other readings of an unresolved card's preferred crop, stored as given. */
    diagnose?:(image:HTMLCanvasElement,id:string)=>Promise<unknown>):Promise<RowZeroCheck>;
  /** Accept one named crop. Returns its values after acceptance (an unconfirmed zero is null). */
  accept(input:RowEvidenceInput):{awakening:number|null;extraCopies:number|null};
  /** Whether this crop's count is unconfirmed as read (whatever the reason). Such a crop is read
   * in full, with the text reader allowed, before it is accepted. Records nothing. */
  countUnconfirmed(input:Pick<RowEvidenceInput,'identity'|'values'|'stable'|'borderAlignment'>):boolean;
  /** Whether the scanner would read this crop's count again with the text reader before accepting
   * it (its `readAndRecordFields`): the count is unconfirmed, the awakening and a count pattern
   * were read, and the identity is not under review. Records nothing. */
  needsCountReread(input:Pick<RowEvidenceInput,'identity'|'values'|'stable'|'borderAlignment'>):boolean;
  /** Whether the card's values are confirmed by this run's observations (may lag by `refreshMs`). */
  confirmed(id:string):boolean;
  /** The projected cards and how many are confirmed, computed now. */
  /** `detail`: add the diagnosis of unconfirmed cards (their accepted crops and a picture). */
  summary(detail?:boolean):{confirmed:number;cards:{id:string;name:string;awakening:number|null;extraCopies:number|null;confirmed:boolean;review:readonly string[];observations:number;
    /** Diagnosis, unconfirmed cards only: each accepted crop as read (at most 60): time, slot, stable, border alignment, the count as read and after acceptance, reliability, whether an icon was seen, and the reader's reason. */
    log?:readonly unknown[];
    /** Diagnosis, unconfirmed cards only: the newest kept crop (PNG data URL), for a person to look at. */
    picture?:string}[]};
}

export function createRowEvidence(catalog:CatalogName[],refreshMs=150):RowEvidence {
  const sessionId=crypto.randomUUID();
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy:{version:3,sessionId}});
  let sequence=0,dirty=false,refreshed=-Infinity,projected:ScannedCard[]=[],confirmedIds=new Set<string>();
  /** Kept crops per card not yet confirmed, and the cards the zero check resolved. */
  const previews=new Map<string,{canvas:HTMLCanvasElement;order:number;stable:boolean}[]>(),PREVIEWS=8;
  const accepts=new Map<string,unknown[]>();
  const resolvedZero=new Map<string,NonNullable<ScannedCard['countDiagnostics']>>();
  const preferred=(a:{order:number;stable:boolean},b:{order:number;stable:boolean})=>Number(b.stable)-Number(a.stable)||b.order-a.order;
  const dropPreviews=(id:string)=>{for(const preview of previews.get(id)??[])preview.canvas.width=0;previews.delete(id);};
  const refresh=(force:boolean)=>{
    if(!dirty||(!force&&performance.now()-refreshed<refreshMs))return;
    projected=inventory.project(catalog).map(card=>{
      const diagnostics=resolvedZero.get(card.id);
      return diagnostics?{...card,extraCopies:0,countReliable:true,review:card.review.filter(reason=>!reason.includes('장수')&&!reason.includes('각성')),
        countDiagnostics:{...diagnostics,reason:diagnostics.reason||PREVIEW_ZERO_REASON}}:card;
    });
    const evidence={latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder,agreed:inventory.agreedFieldOrder};
    confirmedIds=new Set(projected.filter(card=>confirmedReadingCount({cards:[card],...evidence})===1).map(card=>card.id));
    // A confirmed card's crops are no longer needed.
    for(const id of previews.keys())if(confirmedIds.has(id)&&!resolvedZero.has(id))dropPreviews(id);
    dirty=false;refreshed=performance.now();
  };
  return {
    accept(input){
      const {identity,time,slot,stable,borderAlignment}=input;
      // Acceptance settles the values in place; the reader's own object is left alone.
      const values:ReadFieldValues=input.values?structuredClone(input.values):{awakening:null,extraCopies:null};
      const reliability=readFieldReliability(values,{stable,borderAlignment,maxAwakening:identity.maxAwakening});
      const asRead=values.extraCopies;
      const review=settleReadFields(values,identity.review,reliability);
      const order=timedCaptureOrder(0,time,slot),frame=`row:${input.frameId}`;
      const source:InventorySource={sessionId,frameId:input.frameId,observationId:String(++sequence),captureOrder:order,captureTime:time,phase:'input',slot,frame};
      // As in the scanner: the identity is accepted for this source first, then the name and values.
      inventory.acceptIdentity(source,identity.id);
      // As in the scanner: a name still under review is not confirmed by this observation.
      if(!identity.review.includes('이름 확인'))inventory.confirmName(source,identity.id,identity.name);
      const card=observedCard({identity:{...identity,review:[...identity.review],nameEvidence:identity.nameEvidence??[]},values,review,reliability,
        image:'',time,order,stable,position:{frame,slot,stable,sort:null}});
      inventory.recordObservation(source,card as unknown as ScannedCard,borderAlignment);
      const log=accepts.get(identity.id)??[];accepts.set(identity.id,log);
      if(log.length<60)log.push({time:Math.round(time*1000)/1000,slot,stable,alignment:Math.round(borderAlignment*100)/100,awakening:values.awakening,read:asRead,accepted:values.extraCopies,reliability,
        icon:values.countDiagnostics?.iconPresent??null,reason:values.countDiagnostics?.reason??null,pattern:values.countDiagnostics?.pattern?.value??null});
      // A new observation of the card replaces what the zero check concluded from older crops.
      resolvedZero.delete(identity.id);
      if(input.image&&input.image.width&&(!confirmedIds.has(identity.id)||values.extraCopies===null||values.awakening===null)){
        const canvas=Object.assign(document.createElement('canvas'),{width:140,height:210});
        canvas.getContext('2d',{willReadFrequently:true})!.drawImage(input.image,0,0,140,210);
        const kept=previews.get(identity.id)??[];previews.set(identity.id,kept);
        kept.push({canvas,order,stable});kept.sort(preferred);
        for(const extra of kept.splice(PREVIEWS))extra.canvas.width=0;
      }
      dirty=true;
      return {awakening:values.awakening,extraCopies:values.extraCopies};
    },
    countUnconfirmed(input){
      return !input.values||readFieldReliability(input.values,{stable:input.stable,borderAlignment:input.borderAlignment,maxAwakening:input.identity.maxAwakening})==='unconfirmed';
    },
    needsCountReread(input){
      const {values,identity}=input;
      return !!values&&values.awakening!==null&&values.countDiagnostics?.pattern?.value!=null&&!identity.review.length&&
        readFieldReliability(values,{stable:input.stable,borderAlignment:input.borderAlignment,maxAwakening:identity.maxAwakening})==='unconfirmed';
    },
    async confirmZeros(read,diagnose){
      dirty=true;refresh(true);
      const resolved:string[]=[];let checked=0,previewReads=0,withoutPreview=0;
      const unresolved:{name:string;awakening:number;picture?:string;other?:unknown;readings:RowZeroCheck['unresolved'][number]['readings'][number][]}[]=[];
      for(const card of projected){
        if(card.awakening===null||!needsPreviewZeroProof(card))continue;
        checked++;
        const kept=[...(previews.get(card.id)??[])].sort(preferred);
        if(!kept.length){withoutPreview++;continue;}
        // As in the scanner: every kept crop is read before deciding.
        const readings:{order:number;zero:boolean;positive:boolean;diagnostics:ScannedCard['countDiagnostics']}[]=[];
        const detail:RowZeroCheck['unresolved'][number]['readings'][number][]=[];
        for(const preview of kept){
          try{
            const values=await read(preview.canvas,card.id);previewReads++;
            const pixels=preview.canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,140,210).data;
            const packed=packCount(pixels,140,0,true);
            const reading=previewZeroReading({values,packed,card:{awakening:card.awakening,observations:card.observations},stillImage:false});
            readings.push({order:preview.order,...reading});
            detail.push({order:preview.order,stable:preview.stable,readAwakening:values.awakening,readCopies:values.extraCopies,
              iconPresent:values.countDiagnostics?.iconPresent??null,zero:reading.zero,positive:reading.positive,counter:{hasIcon:packed.hasIcon,...packed.diagnostic}});
          }catch{/* Try another kept crop. */}
        }
        const chosen=readings[selectZeroPreview(readings)];
        if(!chosen){unresolved.push({name:card.name,awakening:card.awakening,...(diagnose?{picture:kept[0].canvas.toDataURL('image/png')}:{}),
          ...(diagnose?{other:await diagnose(kept[0].canvas,card.id).catch(error=>String(error))}:{}),readings:detail});continue;}
        resolvedZero.set(card.id,chosen.diagnostics??{maximum:15,reason:'',readings:[]});
        inventory.confirmPreviewField(card.id,inventory.latestIdentityOrder.get(card.id)??card.captureOrder??0);
        resolved.push(card.name);
      }
      dirty=true;refresh(true);
      return {checked,resolved,previewReads,withoutPreview,unresolved};
    },
    confirmed(id){refresh(false);return confirmedIds.has(id);},
    summary(detail=false){
      refresh(true);
      return {confirmed:confirmedIds.size,cards:projected.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,
        confirmed:confirmedIds.has(card.id),review:card.review,observations:card.observations,
        ...(confirmedIds.has(card.id)||!detail?{}:{log:accepts.get(card.id)??[],
          ...(()=>{const newest=[...(previews.get(card.id)??[])].sort((a,b)=>b.order-a.order)[0];return newest?.canvas.width?{picture:newest.canvas.toDataURL('image/png')}:{};})()})}))};
    },
  };
}
