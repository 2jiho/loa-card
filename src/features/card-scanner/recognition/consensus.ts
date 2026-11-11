import type {ScannedCard} from './recognizer-types';
import {calculateRecordedNameV1,RECORDED_NAME_V1} from './consensus-recorded-name-v1';
import type {RecordedNameV1Options} from './consensus-recorded-name-v1';

/** Default for newly produced data. A future default must not modify v1. */
export const CURRENT_INVENTORY_CONSENSUS_POLICY=RECORDED_NAME_V1;
type ConsensusOptions=RecordedNameV1Options;

/** Current default, which may be advanced by a future version. */
export function consensus(observations:ScannedCard[],options:ConsensusOptions={}):ScannedCard {
  return calculateRecordedNameV1(observations,options,false).card;
}
export function consensusWithRepresentative(observations:ScannedCard[],options:ConsensusOptions={}):
  {card:ScannedCard;representativeIndex:number} {
  return calculateRecordedNameV1(observations,options,true);
}

/** Explicit seed-v5 dispatch. Legacy repeat is intentionally unavailable. */
export function recordedNameV1Consensus(observations:ScannedCard[],options:{skipHistoricalSeedIdentity?:boolean}={},
  trackRepresentative=false):{card:ScannedCard;representativeIndex:number} {
  return calculateRecordedNameV1(observations,options,trackRepresentative);
}
