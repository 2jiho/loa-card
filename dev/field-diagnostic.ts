import {packCount, prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import {inspectVisual, readVisual} from '../src/features/card-scanner/recognition/visual-fields';

interface Variant {
  name: string;
  draw: (context: CanvasRenderingContext2D, image: HTMLImageElement) => void;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error(`image load failed: ${url}`));
    image.src = url;
  });
}

void (async () => {
  const status = document.querySelector('[role=status]')!;
  const out = document.getElementById('out')!;
  try {
    const [stars, patternData] = await Promise.all([
      fetch('/scanner/stars.json').then(response => response.json()),
      fetch('/scanner/counter-patterns.json').then(response => response.json()),
    ]);
    const templates = [stars.gray[0], stars.gold[0]];
    const patterns = patternData.patterns.map(prepareContrastPattern);
    const cases = (new URLSearchParams(location.search).get('files') ?? 'd49e0e31,4f7e1dab')
      .split(',').filter(Boolean);
    const variants: Variant[] = [
      {name: 'crop-0-0', draw: (context, image) => context.drawImage(image, 0, 0, 140, 210, 0, 0, 140, 210)},
      {name: 'crop-1-1', draw: (context, image) => context.drawImage(image, 1, 1, 140, 210, 0, 0, 140, 210)},
      {name: 'crop-1-2', draw: (context, image) => context.drawImage(image, 1, 2, 140, 210, 0, 0, 140, 210)},
      {name: 'resize-full', draw: (context, image) => context.drawImage(image, 0, 0, image.width, image.height, 0, 0, 140, 210)},
    ];
    const results = [];
    for (const source of cases) {
      const image = await loadImage(`/work/label-candidates/${source}/3200813.jpg`);
      for (const variant of variants) {
        const canvas = document.createElement('canvas');
        canvas.width = 140; canvas.height = 210;
        const context = canvas.getContext('2d', {willReadFrequently: true})!;
        variant.draw(context, image);
        const pixels = context.getImageData(0, 0, 140, 210).data;
        const fields = inspectVisual(canvas, context, templates, pixels);
        const read = readVisual(canvas, context, fields, patterns, 5, pixels);
        const pack = packCount(pixels, 140, fields.offsetY, true);
        results.push({
          source, variant: variant.name, fields,
          pack: {hasIcon: pack.hasIcon, emptyEvidence: pack.emptyEvidence, diagnostic: pack.diagnostic},
          read,
        });
        canvas.width = 0; canvas.height = 0;
      }
      status.textContent = `${results.length}`;
      out.textContent = JSON.stringify(results, null, 1);
    }
    (window as unknown as {__fieldDiagnostic?: unknown}).__fieldDiagnostic = results;
    status.textContent = `complete ${results.length}`;
  } catch (error) {
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
})();
