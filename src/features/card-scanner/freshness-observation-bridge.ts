import {FreshnessEvidence} from './freshness-evidence';
import type {FreshCompletionDebt} from './fresh-observation';
import type {ObservationSource} from './observation-execution';
import type {SavedObservation} from './saved-acquisition';

interface Binding {readonly key:string;readonly order:number;readonly frame:string;readonly stable:boolean}
interface Lineage {
  readonly binding:Binding;
  pixelKey:string;
  source:ObservationSource;
  identityUse?:{readonly source:ObservationSource;readonly pixelKey:string};
}
function sourceData(source:ObservationSource):ObservationSource {
  return {sessionId:source.sessionId,frameId:source.frameId,observationId:source.observationId,
    captureOrder:source.captureOrder,captureTime:source.captureTime,phase:source.phase,slot:source.slot};
}

/** Logical object lineage is explicit and separate from every acquisition use.
 * The weak map neither owns pixels nor outlives the scanner's saved objects.
 * Exact pixel/source caches decide reuse before this bridge; it never matches
 * artwork, frame numbers, timestamps, or fieldRevision to invent an alias. */
export class FreshnessObservationBridge implements FreshCompletionDebt<SavedObservation> {
  private readonly lineages=new WeakMap<SavedObservation,Lineage>();
  private nextKey=0;
  private readonly evidence:FreshnessEvidence;
  constructor(evidence:FreshnessEvidence){this.evidence=evidence;}

  use(observation:SavedObservation,pixelKey:string,source:ObservationSource):void {
    const old=this.lineages.get(observation);
    if(old) {
      if(old.binding.order!==observation.order||old.binding.frame!==observation.frame||old.binding.stable!==observation.stable)
        throw Error('정확한 관측 연결이 변경되었습니다.');
      old.source=sourceData(source);old.pixelKey=pixelKey;return;
    }
    this.lineages.set(observation,{binding:Object.freeze({key:`observation:${++this.nextKey}`,
      order:observation.order,frame:observation.frame,stable:observation.stable}),pixelKey,source:sourceData(source)});
  }

  private lineage(observation:SavedObservation):Lineage {
    const lineage=this.lineages.get(observation);
    if(!lineage)throw Error('획득 원본 없는 최신 관측 연결');
    return lineage;
  }

  remember(group:number,pixelKey:string,time:number,observation:SavedObservation,fieldRevision?:string,requiresProof=false):void {
    const lineage=this.lineage(observation);
    if(pixelKey!==lineage.pixelKey)throw Error('최신 관측 픽셀 연결 불일치');
    this.evidence.apply({version:1,kind:'accepted',group,time,source:lineage.source,binding:lineage.binding,
      pixelKey,fieldRevision:fieldRevision??null,requiresProof});
    // An exact saved object can survive bounded reducer metadata eviction.
    // Restore only its real prior read source, never the current frame by guess.
    if(observation.identity&&lineage.identityUse)this.linkIdentity(observation,lineage.identityUse.source,lineage.identityUse.pixelKey);
  }

  rejectChanged(group:number,time:number,observation?:SavedObservation):void {
    if(!observation)throw Error('원본 없는 최신 관측 거절');
    const lineage=this.lineage(observation);
    this.evidence.apply({version:1,kind:'rejected',group,time,source:lineage.source,
      binding:lineage.binding,pixelKey:lineage.pixelKey});
    if(observation.identity&&lineage.identityUse)this.linkIdentity(observation,lineage.identityUse.source,lineage.identityUse.pixelKey);
  }

  linkIdentity(observation:SavedObservation|undefined,source:ObservationSource,pixelKey:string):void {
    if(!observation)return;
    const lineage=this.lineages.get(observation);
    if(!lineage)return; // Recovery-only objects never create fictitious live debt.
    const readSource=sourceData(source);
    lineage.identityUse={source:readSource,pixelKey};
    if(!observation.identity||!this.evidence.hasBinding(lineage.binding.key))return;
    this.evidence.apply({version:1,kind:'identity-linked',binding:lineage.binding,source:readSource,pixelKey,
      id:observation.identity.id,review:observation.identity.review});
  }

  unresolvedChanges():number {return this.evidence.settle();}
}
