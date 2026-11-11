import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';

/** Held-out synthetic identity test over all client-composed card templates.
 * It exercises the production portrait-first + name/artwork path. */
interface Row {
  id: string;
  expected: string;
  readId: string | null;
  readName: string | null;
  identitySource: string | null;
  review: string[];
  text: string;
  confidence: number;
  engine: string | null;
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
    const cards = await fetch('/scanner/cards.json').then(response => response.json());
    const recognizer = await createRecognizer(message => { status.textContent = message; });
    const rows: Row[] = [];
    for (const card of cards.cards) {
      try {
        const image = await loadImage(`/work/composed-card-templates/equipped/${card.id}.png`);
        const canvas = document.createElement('canvas');
        canvas.width = 140; canvas.height = 210;
        const context = canvas.getContext('2d', {willReadFrequently: true})!;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, 140, 210);
        const reading = await recognizer.identify(canvas, true, true, true, undefined, true, undefined, true);
        const evidence = reading?.nameEvidence?.[0];
        rows.push({
          id: card.id,
          expected: card.name,
          readId: reading?.id ?? null,
          readName: reading?.name ?? null,
          identitySource: reading?.identitySource ?? null,
          review: reading?.review ?? [],
          text: evidence?.rawText ?? '',
          confidence: evidence?.ocrConfidence ?? 0,
          engine: evidence?.engine ?? null,
        });
        canvas.width = 0; canvas.height = 0;
      } catch (error) {
        rows.push({
          id: card.id, expected: card.name, readId: null, readName: null,
          identitySource: null, review: [], text: '', confidence: 0, engine: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (rows.length % 20 === 0) {
        status.textContent = `done ${rows.length}/${cards.cards.length}`;
        out.textContent = JSON.stringify(rows.slice(-3), null, 1);
      }
    }
    await recognizer.dispose();
    (window as unknown as {__identityGeneralization?: Row[]}).__identityGeneralization = rows;
    status.textContent = `complete ${rows.length}`;
    out.textContent = JSON.stringify({
      total: rows.length,
      correct: rows.filter(row => row.readId === row.id).length,
      artwork: rows.filter(row => row.identitySource === 'artwork').length,
      missed: rows.filter(row => row.readId !== row.id).slice(0, 30),
    }, null, 1);
  } catch (error) {
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
})();
