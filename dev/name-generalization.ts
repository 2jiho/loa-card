import {createNameReader} from '../src/features/card-scanner/recognition/name-reader';
import {inspectVisual} from '../src/features/card-scanner/recognition/visual-fields';

/** Held-out synthetic name test over all client-composed card templates.
 * It does not use any test video/frame and never writes recognition state. */
interface Row {
  id: string;
  expected: string;
  readId: string | null;
  readName: string | null;
  text: string;
  confidence: number;
  exact: boolean;
  ambiguous: boolean;
  error?: string;
}

const status = document.querySelector('[role=status]')!;
const out = document.getElementById('out')!;

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error(`image load failed: ${url}`));
    image.src = url;
  });
}

void (async () => {
  try {
    const [cards, stars] = await Promise.all([
      fetch('/scanner/cards.json').then(response => response.json()),
      fetch('/scanner/stars.json').then(response => response.json()),
    ]);
    const reader = createNameReader(cards.cards, message => { status.textContent = message; });
    await reader.ready();
    const rows: Row[] = [];
    for (const card of cards.cards) {
      try {
        const image = await loadImage(`/work/composed-card-templates/equipped/${card.id}.png`);
        const canvas = document.createElement('canvas');
        canvas.width = 140; canvas.height = 210;
        const context = canvas.getContext('2d', {willReadFrequently: true})!;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, 140, 210);
        const fields = inspectVisual(canvas, context, [stars.gray[0], stars.gold[0]]);
        const reading = await reader.matchForIdentify(canvas, {full: true, offsetY: fields.offsetY,
          allowRaw: true, acceptQuick: () => true, allowGrayNameFallback: true});
        rows.push({
          id: card.id, expected: card.name,
          readId: reading?.card?.id ?? null, readName: reading?.card?.name ?? null,
          text: reading?.rawText ?? '', confidence: reading?.ocrConfidence ?? 0,
          exact: reading?.exact === true, ambiguous: reading?.nameAmbiguous === true,
        });
        canvas.width = 0; canvas.height = 0;
      } catch (error) {
        rows.push({id: card.id, expected: card.name, readId: null, readName: null, text: '',
          confidence: 0, exact: false, ambiguous: false,
          error: error instanceof Error ? error.message : String(error)});
      }
      if (rows.length % 20 === 0) {
        status.textContent = `done ${rows.length}/${cards.cards.length}`;
        out.textContent = JSON.stringify(rows.slice(-3), null, 1);
      }
    }
    await reader.dispose();
    (window as unknown as {__nameGeneralization?: Row[]}).__nameGeneralization = rows;
    status.textContent = `complete ${rows.length}`;
    out.textContent = JSON.stringify({total: rows.length,
      correct: rows.filter(row => row.readId === row.id).length,
      exact: rows.filter(row => row.exact).length,
      ambiguous: rows.filter(row => row.ambiguous).length,
      missed: rows.filter(row => row.readId !== row.id).slice(0, 30)}, null, 1);
  } catch (error) {
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
})();
