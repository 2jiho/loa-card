import type {CsvCatalogCard} from '../domain/inventory-csv';
import type {GrowthMaster} from '../domain/growth';
import type {RaidMaster} from '../domain/raid-progress';

export interface CardCatalog {
  version: string;
  cards: CsvCatalogCard[];
}

function baseUrl(): string {
  const env = (import.meta as unknown as {env?: {BASE_URL?: string}}).env;
  return env?.BASE_URL ?? '/';
}

function dataUrl(path: string): string {
  return `${baseUrl()}${path.replace(/^\//, '')}`;
}

async function loadJson(path: string, signal: AbortSignal | undefined, label: string): Promise<unknown> {
  const response = await fetch(dataUrl(path), {signal});
  if (!response.ok) throw new Error(`${label} (${response.status})`);
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCardCatalog(value: unknown): CardCatalog {
  if (!isRecord(value) || !Array.isArray(value.cards) || !value.cards.length) throw new Error('카드 사전 형식 오류');
  return {
    version: typeof value.version === 'string' ? value.version : '',
    cards: value.cards as CsvCatalogCard[],
  };
}

export function parseGrowthMaster(value: unknown): GrowthMaster {
  if (!isRecord(value) || !Array.isArray(value.cards) || !Array.isArray(value.books)) {
    throw new Error('도감 데이터 형식 오류');
  }
  return value as unknown as GrowthMaster;
}

export function parseRaidMaster(value: unknown): RaidMaster {
  if (!isRecord(value) || !Array.isArray(value.cards) || !Array.isArray(value.sets)) {
    throw new Error('레이드 카드 데이터 형식 오류');
  }
  return value as unknown as RaidMaster;
}

export async function loadCardCatalog(signal?: AbortSignal): Promise<CardCatalog> {
  return parseCardCatalog(await loadJson('scanner/cards.json', signal, '카드 사전 로드 실패'));
}

/** Read a scanner-owned JSON asset without moving its schema into data. */
export async function loadScannerJson<T>(name: string, signal?: AbortSignal): Promise<T> {
  return await loadJson(`scanner/${name}`, signal, `스캐너 자료 로드 실패: ${name}`) as T;
}

export async function loadGrowthMaster(signal?: AbortSignal): Promise<GrowthMaster> {
  return parseGrowthMaster(await loadJson('growth/master.json', signal, '도감 데이터를 불러오지 못했습니다.'));
}

export async function loadRaidMaster(signal?: AbortSignal): Promise<RaidMaster> {
  return parseRaidMaster(await loadJson('raid/master.json', signal, '레이드 카드 데이터를 불러오지 못했습니다.'));
}
