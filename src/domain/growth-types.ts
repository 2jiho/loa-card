export type Cost = { xp: number; silver: number; copies: number };
export type GrowthCard = { id: string; name: string; rarity: number; steps: Cost[] };
export type BookEffect = { threshold: number; requiredCount: number; target: string; value: number };
export type CollectionEffect = { requiredCount: number; stats: { stat: string; value: number }[] };
export type GrowthBook = { id: string; name: string; cardIds: string[]; effects: BookEffect[]; collectionEffects?: CollectionEffect[] };
export type GrowthMaster = {
  version: string;
  targets: { id: string; name: string }[];
  stats?: { id: string; name: string }[];
  cards: GrowthCard[];
  books: GrowthBook[];
};
export type OwnedCard = {
  id: string;
  awakening: number | null;
  extraCopies: number | null;
  review: string[];
  countReliable?: boolean;
};
export type GrowthComparisonRequest = {
  master: GrowthMaster;
  cards: OwnedCard[];
  xp: number;
  target: string;
};
