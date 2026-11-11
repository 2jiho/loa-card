import type {ObservationSource} from './observation-execution';
import type {ScrollCardLocation} from './scroll-card-location';

export const UNKNOWN_LIFECYCLE_LIMITS=Object.freeze({active:128,facts:20_000,groups:10_000});
export interface UnknownLimits {readonly active:number;readonly facts:number;readonly groups:number}
export interface UnknownSeed {
  readonly version:1;readonly sessionId:string;readonly origin:'scan'|'legacy-import';readonly limits:UnknownLimits;
}
export type UnknownKey=
  | {readonly kind:'group';readonly sessionId:string;readonly group:number}
  | {readonly kind:'legacy';readonly sessionId:string;readonly entryId:string};
export interface UnknownUpsert {
  readonly version:1;readonly kind:'upsert';readonly key:UnknownKey;readonly source:ObservationSource|null;
  readonly captureOrder:number|null;readonly captureTime:number|null;readonly pending:boolean;
  readonly reason:string;readonly location:Readonly<ScrollCardLocation>|null;
}
export interface UnknownRetire {
  readonly version:1;readonly kind:'retire';readonly cause:'confirmed-name';
  readonly key:Extract<UnknownKey,{kind:'group'}>;
  readonly proof:{readonly cardId:string;readonly source:ObservationSource};
}
export type UnknownFact=UnknownUpsert|UnknownRetire;
export type UnknownEntry=Omit<UnknownUpsert,'version'|'kind'>&{readonly ordinal:number};
export interface UnknownEffect {
  readonly changed:boolean;readonly accepted:boolean;
  readonly suppressedReason:'covered'|'older'|'tied'|'active-limit'|null;
  readonly upserted:UnknownEntry|null;readonly retiredVersions:readonly UnknownEntry[];
}
export type UnknownLoss='fact-limit'|'group-limit'|'event-sink-failed';
export interface UnknownSnapshot {
  readonly version:1;readonly scope:'unknown-lifecycle';readonly seed:UnknownSeed;
  readonly facts:number;readonly complete:boolean;readonly losses:readonly UnknownLoss[];
  readonly active:readonly UnknownEntry[];
  readonly proofs:readonly {readonly key:Extract<UnknownKey,{kind:'group'}>;readonly state:{readonly cardId:string;readonly order:number}|null}[];
}
export interface UnknownCheckpoint {
  readonly version:1;readonly complete:boolean;readonly events:number;readonly hash:string|null;
}
