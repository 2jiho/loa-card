// Local vision reading via Ollama (/api/generate) with catalog-constrained prompts.
// Usage:
//   node dev/local-vision-read.mjs <frame.png> <hypotheses.json> [model] [ollamaHost]
// Output: JSON per cell: { row, col, answer, raw }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [framePath, hypPath, model = 'qwen3-vl:8b', host = 'http://127.0.0.1:11434'] = process.argv.slice(2);
if (!framePath || !hypPath) {
  console.error('usage: node dev/local-vision-read.mjs <frame.png> <hypotheses.json> [model] [host]');
  process.exit(1);
}

const hyp = JSON.parse(readFileSync(hypPath, 'utf8'));
const imageBase64 = readFileSync(framePath).toString('base64');
const namesPath = join('work', 'catalog-names.txt');
const catalogNames = readFileSync(namesPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);

const PROMPT = (cell) => `다음은 한국 게임(Lost Ark) 카드 인벤토리 프레임 이미지입니다.
카드 격자에서 행 ${cell.row}, 열 ${cell.col} 칸에 보이는 카드의 이름을 정식 카드 이름 목록에서만 골라 주세요.
- 정답 후보 목록은 아래와 같습니다. 이 목록에 정확히 있는 이름만 출력하세요.
- 읽을 수 없거나 목록에 없으면 "?"만 출력하세요.
- 이름만 출력하고 다른 설명은 하지 마세요.

목록:
${catalogNames.join('\n')}`;

async function ask(cell) {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: PROMPT(cell),
      images: [imageBase64],
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.response?.trim?.() ?? '';
}

const results = [];
for (const cell of hyp.cells) {
  let answer, error = null;
  try { answer = await ask(cell); } catch (e) { error = String(e); }
  results.push({ row: cell.row, col: cell.col, answer, error });
  console.log(`[${cell.row}-${cell.col}] ${answer ?? error}`);
}

const outFile = hypPath.replace(/\.json$/, '-local.json');
writeFileSync(outFile, JSON.stringify({ model, frame: framePath, results }, null, 2), 'utf8');
console.log('\nwritten', outFile);
