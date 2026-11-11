import type {CountEmptyEvidence, CountPatternReading} from './count-pattern';
import type {CountReliability} from './count-confidence';
import type {PortraitEvidence} from './portrait-matcher';
import type {ArtworkEvidence} from './artwork-verifier';
import type {CardSort} from './capture-metadata';
import type {ScrollCardLocation} from '../session/scroll-card-location';

export type {Reference} from './reference-types';

export interface CountDiagnostics {
  /** Set only by the numeric reader's multi-variant confirmation, including its cache. */
  ocrConfirmedValue?: number;
  patternOcrAgreed?: boolean;
  iconPresent?: boolean;
  emptyEvidence?: CountEmptyEvidence;
  reliability?: CountReliability;
  maximum: number;
  reason: string;
  readings: { engine: string; text: string; confidence: number; value: number | null }[];
  pattern?: CountPatternReading;
}

export interface NameEvidence {
  complete?: boolean;
  /** The visible exact text is also part of another catalog name. */
  nameAmbiguous?: boolean;
  stable?: boolean;
  frame?: string;
  rawText: string;
  normalizedText?: string;
  engine: "paddle" | "tesseract" | "artwork";
  portrait?: PortraitEvidence;
  readingId: string;
  fingerprint: string;
  ocrConfidence: number;
  score: number;
  gap: number;
  exact: boolean;
  preprocessing?: "soft-rarity" | "gray-first-line-v1" | "stretch-first-v1";
  artwork?: ArtworkEvidence;
  ctc?: { relativeLikelihood: number; margin: number };
}

export interface ScannedCard {
  id: string;
  name: string;
  awakening: number | null;
  extraCopies: number | null;
  confidence: number;
  review: string[];
  image: string;
  time: number;
  observations: number;
  manual?: ("name" | "awakening" | "extraCopies")[];
  identitySource?: "name-pattern" | "artwork" | "dictionary";
  maxAwakening?: number;
  captureOrder?: number;
  countReliable?: boolean;
  countDiagnostics?: CountDiagnostics;
  nameEvidence?: NameEvidence[];
  nameConfirmedBy?: "repeat" | "sort";
  capturePosition?: { frame: string; slot: number; stable: boolean; sort: CardSort | null; location?: ScrollCardLocation };
}
