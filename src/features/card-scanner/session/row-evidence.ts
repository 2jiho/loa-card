import {InventoryEvidence,CURRENT_INVENTORY_CONSENSUS_POLICY} from './inventory-evidence';
import type {InventorySource} from './inventory-evidence';
import {confirmedReadingCount} from './recovery-completion';
import {timedCaptureOrder} from './live-scan-policy';
import {agreesWithEarlierReading,observedCard,readFieldReliability,settleReadFields,textCountReading} from './field-acceptance';
import type {TextCountReading} from './field-acceptance';
import type {ReadFieldValues} from './field-acceptance';
import type {CatalogName} from '../recognition/card-dictionary';
import type {ScannedCard} from '../recognition/recognizer-types';
import {packCount} from '../recognition/count-pattern';
import type {CardPictureReply,CardPictureRequest} from './card-picture-worker';
import {PREVIEW_ZERO_REASON,needsPreviewZeroProof,previewZeroReading,selectZeroPreview} from './preview-zero';

/** Acceptance and merge for the row-centred scan (docs/scanner-pipeline.md, section 5): every crop
 * the row reading names goes through the shared field acceptance (session/field-acceptance.ts) and
 * into an InventoryEvidence (empty seed, the recorded-name consensus and count-conflict policies).
 * "Confirmed" is `confirmedReadingCount` over the projected cards: values this scan's observations
 * confirm, latest by capture time.
 *
 * It also runs the end-of-scan check of kept crops (`confirmZeros`): a card whose count is still
 * missing or an unconfirmed zero is confirmed as zero only when a kept crop of it shows an explicit
 * empty counter and no later kept crop shows a positive count (up to 8 crops kept per card not yet
 * confirmed). And it keeps one small screen picture per card for the card list.
 *
 * It decides nothing about a finished scan: the header total and completion are
 * orchestration/row-scanner-state.ts. */
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
   * after everything was read, and it may also run while the share goes on (a card it resolved is
   * not checked again): a crop accepted afterwards cancels its card's result, and a card that gets
   * a new observation during a run is left for the next one. */
  confirmZeros(read:(image:HTMLCanvasElement,id:string,/** The crop's width as captured (the kept copy is 140 wide). */width:number)=>Promise<ReadFieldValues>,
    /** Diagnosis only: other readings of an unresolved card's preferred crop, stored as given. */
    diagnose?:(image:HTMLCanvasElement,id:string,width:number)=>Promise<unknown>):Promise<RowZeroCheck>;
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
  /** The merged cards as the scanner projects them (values as accepted; a zero the check confirmed
   * is shown as zero), and how many are confirmed, computed now. */
  /** The cards so far. With `pictures`, each card carries a picture from the screen: a card still to
   * check the crop it was last read from, the others their own small picture (the caller asks for
   * them once frames are no longer being taken, as encoding costs main-thread time). */
  cards(pictures?:boolean):{readonly cards:readonly ScannedCard[];readonly confirmed:number};
  /** For the card strip of the interface: the cards as they were first read, newest last (at most
   * 16), with a small picture of the crop and whether its values were read. Presentation only. */
  activity():readonly {readonly id:number;readonly image:string;readonly name:string;readonly status:'read'|'review'}[];
  /** Resolves once every card picture asked for so far is encoded (they are encoded off the main thread). */
  picturesSettled():Promise<void>;
  /** Ends the picture worker. */
  dispose():void;
  summary(detail?:boolean):{confirmed:number;cards:{id:string;name:string;awakening:number|null;extraCopies:number|null;confirmed:boolean;review:readonly string[];observations:number;
    /** Diagnosis, unconfirmed cards only: each accepted crop as read (at most 60): time, slot, stable, border alignment, the count as read and after acceptance, reliability, whether an icon was seen, and the reader's reason. */
    log?:readonly unknown[];
    /** Diagnosis, unconfirmed cards only: the newest kept crop (PNG data URL), for a person to look at. */
    picture?:string}[]};
}

export function createRowEvidence(catalog:CatalogName[],refreshMs=150,
  /** Development diagnosis: cards whose accepted crops (pictures and full count readings) are kept and
   * reported by summary(true) whether or not they are confirmed. */
  options:{trace?:readonly string[]}={}):RowEvidence {
  const traced=new Set(options.trace??[]);
  const traces=new Map<string,{time:number;slot:number;stable:boolean;awakening:number|null;read:number|null;accepted:number|null;reliability:string;count:unknown;canvas:HTMLCanvasElement}[]>();
  const sessionId=crypto.randomUUID();
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,countConflictPolicy:{version:3,sessionId}});
  let sequence=0,dirty=false,refreshed=-Infinity,projected:ScannedCard[]=[],confirmedIds=new Set<string>();
  /** Kept crops per card not yet confirmed, and the cards the zero check resolved. */
  const previews=new Map<string,{canvas:HTMLCanvasElement;order:number;stable:boolean;width:number;alignment:number;url?:string}[]>(),PREVIEWS=8;
  /** The interface's card strip (activity()). */
  const strip:{id:number;card:string;image:string;name:string;status:'read'|'review'}[]=[];let stripId=0;
  // One small picture per card (the card list's tile size), made when the card is first read and
  // made again once from a still frame if the first was taken while the list moved: the card list
  // shows the card as it was on screen, not the game's artwork.
  // The picture is scaled by createImageBitmap and encoded in a worker (session/card-picture-worker.ts),
  // so that a picture per card costs the scan's main thread nothing; it arrives a moment later.
  // (Encoding on the main thread, even with toBlob, took about a second of it per scan.)
  let encoding=0,settled:(()=>void)[]=[],encoder:Worker|undefined,encoderFailed=false,pictureId=0;
  const encoded=new Map<number,(url:string|null)=>void>();
  const finish=()=>{if(--encoding===0){const waiting=settled;settled=[];for(const resolve of waiting)resolve();}};
  const thumbnail=(image:HTMLCanvasElement,done:(url:string)=>void)=>{
    if(typeof Worker==='undefined'||typeof createImageBitmap==='undefined')return;
    encoding++;
    const id=++pictureId;
    void createImageBitmap(image,{resizeWidth:80,resizeHeight:120,resizeQuality:'medium'}).then(bitmap=>{
      if(encoderFailed){bitmap.close();finish();return;}
      if(!encoder){
        encoder=new Worker(new URL('./card-picture-worker.ts',import.meta.url),{type:'module'});
        encoder.onmessage=(event:MessageEvent<CardPictureReply>)=>{const reply=encoded.get(event.data.id);encoded.delete(event.data.id);reply?.(event.data.url);};
        // A worker that fails (it could not load) is not used again: every picture asked for gets an
        // answer (none), so the end of the scan never waits for one.
        encoder.onerror=encoder.onmessageerror=()=>{encoderFailed=true;encoder?.terminate();encoder=undefined;for(const reply of encoded.values())reply(null);encoded.clear();};
      }
      encoded.set(id,url=>{if(url)done(url);finish();});
      encoder.postMessage({id,bitmap} satisfies CardPictureRequest,[bitmap]);
    }).catch(finish);
  };
  const cardPictures=new Map<string,{url:string;stable:boolean;version:number}>();
  const accepts=new Map<string,unknown[]>();
  /** Per card: its fresh text readings of the count that agreed with the patterns' candidate (see accept). */
  const textReads=new Map<string,TextCountReading[]>();
  const resolvedZero=new Map<string,NonNullable<ScannedCard['countDiagnostics']>>();
  /** Observations accepted per card, to notice one arriving while the zero check reads that card's crops. */
  const acceptCount=new Map<string,number>();
  const preferred=(a:{order:number;stable:boolean},b:{order:number;stable:boolean})=>Number(b.stable)-Number(a.stable)||b.order-a.order;
  const dropPreviews=(id:string)=>{for(const preview of previews.get(id)??[])preview.canvas.width=0;previews.delete(id);};
  const refresh=(force:boolean)=>{
    if(!dirty||(!force&&performance.now()-refreshed<refreshMs))return;
    projected=inventory.project(catalog).map(card=>{
      const diagnostics=resolvedZero.get(card.id);
      return diagnostics?{...card,extraCopies:0,countReliable:true,review:card.review.filter(reason=>!reason.includes('장수')),
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
      let reliability=readFieldReliability(values,{stable,borderAlignment,maxAwakening:identity.maxAwakening});
      // Two readings of this card from different frames, each a fresh text reading that agrees with the
      // count patterns' first candidate on an intact card, confirm the count (where the patterns cannot
      // read the digits, as on a 1920x1080 window, a still list was the only other way). A reading
      // reused from the cache or a retry of the same frame is not another one.
      const reading=textCountReading(values,{frameId:input.frameId,time,borderAlignment});
      if(reading){
        const seen=textReads.get(identity.id)??[];
        if(reliability==='unconfirmed'&&agreesWithEarlierReading(seen,reading))reliability='repeated-pattern';
        seen.push(reading);textReads.set(identity.id,seen.slice(-6));
      }
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
      if(traced.has(identity.id)&&input.image?.width){
        const kept=traces.get(identity.id)??[];traces.set(identity.id,kept);
        if(kept.length<60)kept.push({time:Math.round(time*1000)/1000,slot,stable,awakening:values.awakening,read:asRead,accepted:values.extraCopies,reliability,
          count:values.countDiagnostics?{...values.countDiagnostics,readings:undefined}:null,
            canvas:(()=>{const copy=Object.assign(document.createElement('canvas'),{width:input.image!.width,height:input.image!.height});copy.getContext('2d')!.drawImage(input.image!,0,0);return copy;})()});
      }
      // A new observation of the card replaces what the zero check concluded from older crops.
      resolvedZero.delete(identity.id);
      // The strip shows each card once, when it is first read.
      const picture=cardPictures.get(identity.id),id=identity.id;
      if(input.image&&input.image.width&&(!picture||(!picture.stable&&stable))){
        const version=(picture?.version??0)+1;
        cardPictures.set(id,{url:picture?.url??'',stable,version});
        thumbnail(input.image,url=>{
          const now=cardPictures.get(id);
          if(now?.version===version)now.url=url;
          // The strip entry made before its picture was ready takes it now.
          for(const item of strip)if(item.card===id&&!item.image)item.image=url;
        });
      }
      if(!acceptCount.has(id)&&cardPictures.has(id)){
        strip.push({id:++stripId,card:id,image:cardPictures.get(id)!.url,name:identity.name,
          status:values.awakening!==null&&values.extraCopies!==null?'read':'review'});
        if(strip.length>16)strip.shift();
      }
      acceptCount.set(identity.id,(acceptCount.get(identity.id)??0)+1);
      if(input.image&&input.image.width&&(!confirmedIds.has(identity.id)||values.extraCopies===null||values.awakening===null)){
        const canvas=Object.assign(document.createElement('canvas'),{width:140,height:210});
        canvas.getContext('2d',{willReadFrequently:true})!.drawImage(input.image,0,0,140,210);
        const kept=previews.get(identity.id)??[];previews.set(identity.id,kept);
        kept.push({canvas,order,stable,width:input.image.width,alignment:borderAlignment});kept.sort(preferred);
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
      // The check may run while crops are still being accepted: a card that gets a new observation
      // after the check began (it may have changed what the card needs) is left for the next run.
      const acceptsAtStart=new Map(acceptCount);
      for(const card of projected){
        if(card.awakening===null||!needsPreviewZeroProof(card))continue;
        // A zero settles the count only: a card whose awakening itself is in doubt is not settled by it.
        if(card.review.some(reason=>reason.includes('각성')&&!reason.includes('장수')))continue;
        checked++;
        const acceptsBefore=acceptsAtStart.get(card.id)??0;
        const kept=[...(previews.get(card.id)??[])].sort(preferred);
        if(!kept.length){withoutPreview++;continue;}
        // As in the scanner: every kept crop is read before deciding.
        const readings:{order:number;zero:boolean;positive:boolean;diagnostics:ScannedCard['countDiagnostics']}[]=[];
        const detail:RowZeroCheck['unresolved'][number]['readings'][number][]=[];
        for(const preview of kept){
          try{
            const values=await read(preview.canvas,card.id,preview.width);previewReads++;
            const pixels=preview.canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,140,210).data;
            const packed=packCount(pixels,140,0,true);
            const reading=previewZeroReading({values,packed,card:{awakening:card.awakening,observations:card.observations},stillImage:false});
            // A kept crop proves zero only on the terms its acceptance had: a still list or an intact
            // card, and the card's own awakening. Re-reading the crop acceptance refused proves nothing
            // new. A positive count in any kept crop still vetoes.
            const eligible=(preview.stable||preview.alignment>=.8)&&values.awakening===card.awakening;
            readings.push({order:preview.order,...reading,zero:reading.zero&&eligible});
            detail.push({order:preview.order,stable:preview.stable,readAwakening:values.awakening,readCopies:values.extraCopies,
              iconPresent:values.countDiagnostics?.iconPresent??null,zero:reading.zero,positive:reading.positive,counter:{hasIcon:packed.hasIcon,...packed.diagnostic}});
          }catch{/* Try another kept crop. */}
        }
        if((acceptCount.get(card.id)??0)!==acceptsBefore)continue;
        const chosen=readings[selectZeroPreview(readings)];
        if(!chosen){unresolved.push({name:card.name,awakening:card.awakening,...(diagnose?{picture:kept[0].canvas.toDataURL('image/png')}:{}),
          ...(diagnose?{other:await diagnose(kept[0].canvas,card.id,kept[0].width).catch(error=>String(error))}:{}),readings:detail});continue;}
        resolvedZero.set(card.id,chosen.diagnostics??{maximum:15,reason:'',readings:[]});
        inventory.confirmPreviewField(card.id,inventory.latestIdentityOrder.get(card.id)??card.captureOrder??0);
        resolved.push(card.name);
      }
      dirty=true;refresh(true);
      return {checked,resolved,previewReads,withoutPreview,unresolved};
    },
    confirmed(id){refresh(false);return confirmedIds.has(id);},
    activity(){return strip.map(({card:_card,...item})=>({...item}));},
    picturesSettled(){return encoding===0?Promise.resolve():new Promise<void>(resolve=>{settled.push(resolve);});},
    dispose(){encoder?.terminate();encoder=undefined;for(const reply of encoded.values())reply(null);encoded.clear();},
    cards(pictures=false){
      refresh(true);
      if(!pictures)return {cards:projected,confirmed:confirmedIds.size};
      // A card still to check shows the screen crop it was last read from (the newest kept one);
      // every other card its own small picture from the screen.
      return {confirmed:confirmedIds.size,cards:projected.map(card=>{
        const own=cardPictures.get(card.id)?.url||undefined;
        if(confirmedIds.has(card.id))return own?{...card,image:own}:card;
        const newest=[...(previews.get(card.id)??[])].sort((a,b)=>b.order-a.order)[0];
        if(!newest?.canvas.width)return own?{...card,image:own}:card;
        newest.url??=newest.canvas.toDataURL('image/jpeg',.9);
        return {...card,image:newest.url};
      })};
    },
    summary(detail=false){
      refresh(true);
      return {confirmed:confirmedIds.size,cards:projected.map(card=>({id:card.id,name:card.name,awakening:card.awakening,extraCopies:card.extraCopies,
        confirmed:confirmedIds.has(card.id),review:card.review,observations:card.observations,
        ...(detail&&traces.has(card.id)?{trace:traces.get(card.id)!.map(({canvas,...item})=>({...item,picture:canvas.toDataURL('image/png')}))}:{}),
        ...(confirmedIds.has(card.id)||!detail?{}:{log:accepts.get(card.id)??[],
          ...(()=>{const newest=[...(previews.get(card.id)??[])].sort((a,b)=>b.order-a.order)[0];return newest?.canvas.width?{picture:newest.canvas.toDataURL('image/png')}:{};})()})}))};
    },
  };
}
