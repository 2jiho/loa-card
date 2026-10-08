import { dictionarySimilarity, normalizeName } from "./card-dictionary";
import type { CatalogName } from "./card-dictionary";

export interface NameAttempt {
  text: string; confidence: number; engine: string; variant: string;
  reason: string; candidates: { id: string; name: string; score: number }[];
}
/** Diagnostic candidates are never used to force a card identity. */
export function nameAttempt(text: string, confidence: number, engine: string, variant: string,
  cards: CatalogName[], accepted: boolean): NameAttempt {
  const query = normalizeName(text);
  const candidates = query.length >= 2 ? cards
    .filter(card => Math.abs(normalizeName(card.name).length - query.length) <= 2)
    .map(card => ({ id: card.id, name: card.name, score: dictionarySimilarity(text, card.name) }))
    .sort((a, b) => b.score - a.score).slice(0, 3) : [];
  const reason = accepted ? "DB 후보 판독 · 최종 확정 조건 별도 검사"
    : !query ? "문자 판독 없음" : confidence < 50 ? "OCR 신뢰도 부족"
    : /[ㄱ-ㅎㅏ-ㅣ]/.test(text) ? "불완전한 한글 획"
    : cards.some(card => normalizeName(card.name).startsWith(query)) ? "이름 접미사 미관측"
    : "DB 이름 유사도 또는 후보 구분 조건 미달";
  return { text: text.slice(0, 120), confidence, engine, variant, reason, candidates };
}
