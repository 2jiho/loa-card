/** Greedy CTC: index 0 is blank; adjacent repeats collapse unless separated by blank. */
export function decodeCtc(
  probabilities: Float32Array,
  steps: number,
  characters: string[],
) {
  if (probabilities.length !== steps * characters.length)
    throw new Error("OCR 문자표와 모델 출력이 맞지 않습니다.");
  let previous = -1,
    text = "",
    confidence = 0,
    count = 0;
  for (let step = 0; step < steps; step++) {
    const offset = step * characters.length;
    let best = 0;
    for (let c = 1; c < characters.length; c++)
      if (probabilities[offset + c] > probabilities[offset + best]) best = c;
    if (best !== 0 && best !== previous) {
      text += characters[best];
      confidence += probabilities[offset + best];
      count++;
    }
    previous = best;
  }
  return {
    text: text.normalize("NFKC"),
    confidence: count ? confidence / count : 0,
  };
}
