import type {ObservationSource} from './observation-execution';

/** Metadata bounds. They do not change crop queues or raster ownership. */
export const FRESHNESS_EVIDENCE_LIMITS=Object.freeze({groups:2048,facts:20_000});
export interface FreshnessLimits {readonly groups:number;readonly facts:number}
export interface FreshnessSeed {
  readonly version:1;readonly sessionId:string;readonly limits:FreshnessLimits;
}
/** Assigned once to a SavedObservation object. Its use source is a different
 * value: exact cached observations can be used by later acquisitions. */
export interface FreshnessBinding {
  readonly key:string;readonly order:number;readonly frame:string;readonly stable:boolean;
}
interface SourceFact {
  readonly version:1;readonly group:number;readonly time:number;readonly source:ObservationSource;
  readonly pixelKey:string;
}
export interface FreshnessAccepted extends SourceFact {
  readonly kind:'accepted';readonly binding:FreshnessBinding;
  readonly fieldRevision:string|null;readonly requiresProof:boolean;
}
export interface FreshnessRejected extends SourceFact {
  readonly kind:'rejected';readonly binding:FreshnessBinding|null;
}
export interface FreshnessIdentity {
  readonly version:1;readonly kind:'identity-linked';readonly binding:FreshnessBinding;
  readonly source:ObservationSource;readonly pixelKey:string;readonly id:string;readonly review:readonly string[];
}
export type FreshnessGuardKind='capture'|'recovery'|'final';
export interface FreshnessSettle {readonly version:1;readonly kind:'settle'}
export interface FreshnessGuard {
  readonly version:1;readonly kind:'guard-check';readonly guard:FreshnessGuardKind;
  readonly unresolved:number;readonly settled:boolean;
}
export type FreshnessFact=FreshnessAccepted|FreshnessRejected|FreshnessIdentity|FreshnessSettle|FreshnessGuard;
export type FreshnessLoss='fact-limit'|'event-sink-failed'|'association-conflict';
export interface FreshnessAcceptedEntry {
  readonly group:number;readonly time:number;readonly source:ObservationSource;
  readonly bindingKey:string;readonly pixelKey:string;readonly fieldRevision:string|null;
}
export interface FreshnessPendingEntry {
  readonly group:number;readonly time:number;readonly source:ObservationSource;readonly bindingKey:string|null;readonly pixelKey:string;
}
export interface FreshnessLineage {
  readonly binding:FreshnessBinding;readonly pixelKey:string;readonly originSource:ObservationSource;
  readonly identity:{readonly id:string;readonly review:readonly string[];readonly source:ObservationSource;readonly pixelKey:string}|null;
}
export interface FreshnessSnapshot {
  readonly version:1;readonly scope:'freshness-evidence';readonly seed:FreshnessSeed;
  readonly facts:number;readonly complete:boolean;readonly losses:readonly FreshnessLoss[];
  readonly lostChange:boolean;readonly accepted:readonly FreshnessAcceptedEntry[];
  readonly pending:readonly FreshnessPendingEntry[];readonly lineages:readonly FreshnessLineage[];
  readonly guards:readonly {readonly guard:FreshnessGuardKind;readonly unresolved:number;readonly settled:boolean;readonly fact:number}[];
}
export interface FreshnessCheckpoint {
  readonly version:1;readonly complete:boolean;readonly events:number;readonly hash:string|null;
}
