const grades = ['일반', '고급', '희귀', '영웅', '전설'] as const;
export function cardRarityName(rarity:number|undefined) {
  return rarity===undefined ? '등급 미확인' : grades[rarity] ?? '등급 미확인';
}
export function cardRarityClass(rarity:number|undefined) {
  return `card-rarity${rarity!==undefined&&grades[rarity] ? ` card-rarity-${rarity}` : ''}`;
}
