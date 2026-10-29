import {InventoryEvidence, hashInventoryEvidence, parseInventoryEvent, parseInventorySeed} from './inventory-evidence';
import {yieldForCapture} from './input-source';

export type InventoryCheckpoint = Readonly<
  | {complete:true;hash:string;error?:string}
  | {complete:false;error?:string}
>;
export interface InventoryReplaySummary {
  readonly supported:boolean;
  readonly events:number;
  readonly cards:number;
  readonly hash:string|null;
  readonly expectedHash:string|null;
  readonly matchesCapturedState:boolean|null;
}

export function parseInventoryCheckpoint(value:unknown):InventoryCheckpoint {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('잘못된 목록 검증점');
  const checkpoint=value as Record<string,unknown>;
  if(typeof checkpoint.complete!=='boolean'||Object.keys(checkpoint).some(key=>!['complete','hash','error'].includes(key))||
    checkpoint.error!==undefined&&(typeof checkpoint.error!=='string'||checkpoint.error.length>2000))throw Error('잘못된 목록 검증점');
  if(checkpoint.complete){
    if(typeof checkpoint.hash!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint.hash))throw Error('잘못된 목록 검증 해시');
    return Object.freeze({complete:true,hash:checkpoint.hash,...(checkpoint.error===undefined?{}:{error:checkpoint.error as string})});
  }
  if(Object.hasOwn(checkpoint,'hash'))throw Error('잘못된 목록 검증점');
  return Object.freeze({complete:false,...(checkpoint.error===undefined?{}:{error:checkpoint.error as string})});
}

/** Replays arrival order of pixel-free inventory evidence. An explicit seed,
 * including an empty seed, marks this component as supported. Seed values do
 * not establish current-run proof. Archive readers own event order and loss
 * validation; a matching component hash alone never proves archive completeness. */
export class InventoryEvidenceReplay {
  private readonly signal:AbortSignal;
  private inventory:InventoryEvidence|undefined;
  private events=0;
  private expectedHash:string|null=null;

  constructor(signal:AbortSignal){this.signal=signal;}

  /** Read the proof produced by the shared inventory reducer at this exact
   * event boundary. Seed cards intentionally contribute no current-run proof. */
  get confirmedFieldOrder():ReadonlyMap<string,number> {
    if(!this.inventory)throw Error('목록 시작 상태 없이 최신 필드 근거를 읽을 수 없습니다.');
    return this.inventory.confirmedFieldOrder;
  }

  seed(value:unknown):void {
    this.signal.throwIfAborted();
    const seed=parseInventorySeed(value);
    if(this.inventory)throw Error('목록 시작 상태가 중복되었습니다.');
    this.inventory=new InventoryEvidence(seed.cards);this.expectedHash=null;
  }

  accept(value:unknown):void {
    this.signal.throwIfAborted();
    const event=parseInventoryEvent(value);
    if(!this.inventory)throw Error('목록 시작 상태 없이 목록 이벤트를 재생할 수 없습니다.');
    this.inventory.apply(event);this.events++;this.expectedHash=null;
  }

  checkpoint(value:unknown):void {
    this.signal.throwIfAborted();
    const checkpoint=parseInventoryCheckpoint(value);
    this.expectedHash=checkpoint.complete?checkpoint.hash:null;
  }

  async summary():Promise<InventoryReplaySummary> {
    this.signal.throwIfAborted();
    // Snapshot before yielding so the counts and both hashes describe one instant.
    const snapshot=this.inventory?.snapshot(),events=this.events,expectedHash=this.expectedHash;
    await yieldForCapture(this.signal);
    const hash=snapshot?await hashInventoryEvidence(snapshot):null;
    this.signal.throwIfAborted();
    return {supported:!!snapshot,events,cards:snapshot?.cards.length??0,hash,expectedHash,
      matchesCapturedState:hash!==null&&expectedHash!==null?hash===expectedHash:null};
  }
}
