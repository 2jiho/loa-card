import {createRecognizer} from '../src/features/card-scanner/recognition/recognizer';

interface Attempt {
  text: string;
  confidence: number;
  engine: string;
  reason: string;
  candidates: {id: string; name: string; score: number}[];
}

const status = document.querySelector('[role=status]')!;
const out = document.getElementById('out')!;
const ids = (new URLSearchParams(location.search).get('ids') ?? '3200119,3200703,3200803,3201017,3202044')
  .split(',').filter(Boolean);

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
    const rows = [];
    for (const id of ids) {
      const card = cards.cards.find((item: {id: string}) => item.id === id);
      const image = await loadImage(`/work/composed-card-templates/equipped/${id}.png`);
      const canvas = document.createElement('canvas');
      canvas.width = 140; canvas.height = 210;
      const context = canvas.getContext('2d', {willReadFrequently: true})!;
      context.drawImage(image, 0, 0, 140, 210);
      const reading = await recognizer.identify(canvas, true, true, true, undefined, true, undefined, true);
      const attempts: Attempt[] = (recognizer.nameDiagnostics(canvas) ?? []).map(attempt => ({
        text: attempt.text, confidence: attempt.confidence, engine: attempt.engine,
        reason: attempt.reason, candidates: attempt.candidates.slice(0, 4),
      }));
      const portrait = recognizer.portraitDiagnostics(canvas)?.[0]?.diagnostic;
      rows.push({
        id, expected: card?.name ?? null,
        readId: reading?.id ?? null, readName: reading?.name ?? null,
        identitySource: reading?.identitySource ?? null, review: reading?.review ?? [],
        evidence: reading?.nameEvidence?.[0] ?? null,
        nameAttempts: attempts,
        portrait: portrait ? {
          outcome: portrait.outcome, reason: portrait.reason,
          stages: portrait.stages.map(stage => ({
            stage: stage.stage, accepted: stage.decision.accepted,
            candidates: stage.candidates.map(candidate => ({
              id: candidate.id, upper: candidate.upper, lower: candidate.lower,
              correlation: candidate.correlation, margin: candidate.margin,
            })),
            independent: stage.decision.independent, text: stage.decision.text,
          })),
        } : null,
      });
      canvas.width = 0; canvas.height = 0;
      status.textContent = `${rows.length}/${ids.length}`;
      out.textContent = JSON.stringify(rows, null, 1);
    }
    await recognizer.dispose();
    (window as unknown as {__identityDiagnostic?: unknown}).__identityDiagnostic = rows;
    status.textContent = `complete ${rows.length}`;
  } catch (error) {
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
})();
