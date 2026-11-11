export interface Reference {
  id: string;
  name: string;
  rarity: number;
  feature?: string;
  maxAwakening?: number;
  aliases?: string[];
}
