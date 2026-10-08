export interface CountPattern { value: number; bits: string; pixels: number }
export interface ContrastPattern { value: number; foreground: number[]; outline: number[]; plus: number[]; plusOutline: number[] }
export interface CountPatternReading {
  value: number | null;
  candidate: number | null;
  score: number;
  gap: number;
  reason: string;
}
export function prepareContrastPattern(pattern: CountPattern): ContrastPattern {
  const bytes = Uint8Array.from(atob(pattern.bits), c => c.charCodeAt(0));
  const mask = Array.from({ length: 960 }, (_, i) => (bytes[i >>> 3] >>> (i & 7)) & 1);
  const foreground: number[] = [], outline: number[] = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 48; x++) {
    const i = y * 48 + x;
    if (mask[i]) foreground.push(y * 50 + x);
    else if ([-1, 0, 1].some(dy => [-1, 0, 1].some(dx => {
      const sx = x + dx, sy = y + dy;
      return sx >= 0 && sx < 48 && sy >= 0 && sy < 20 && mask[sy * 48 + sx];
    }))) outline.push(y * 50 + x);
  }
  // The leftmost connected glyph is the '+'; require it independently so a
  // covered prefix cannot pass solely on the remaining digit strokes.
  const left = foreground.reduce((a, p) => p % 50 < a % 50 ? p : a, foreground[0]);
  const seed = Math.floor(left / 50) * 48 + left % 50;
  const plusMask = new Uint8Array(960), queue = [seed];
  plusMask[seed] = 1;
  for (let at = 0; at < queue.length; at++) {
    const p = queue[at], x = p % 48, y = Math.floor(p / 48);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = x + dx, sy = y + dy, next = sy * 48 + sx;
      if (sx >= 0 && sx < 48 && sy >= 0 && sy < 20 && mask[next] && !plusMask[next]) {
        plusMask[next] = 1; queue.push(next);
      }
    }
  }
  const plus = queue.map(p => Math.floor(p / 48) * 50 + p % 48), plusOutline: number[] = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 48; x++)
    if (!mask[y * 48 + x] && [-1, 0, 1].some(dy => [-1, 0, 1].some(dx => {
      const sx = x + dx, sy = y + dy;
      return sx >= 0 && sx < 48 && sy >= 0 && sy < 20 && plusMask[sy * 48 + sx];
    }))) plusOutline.push(y * 50 + x);
  return { value: pattern.value, foreground, outline, plus, plusOutline };
}
/** White centers and their dark outline survive bright artwork better than a white threshold. */
export function readContrastCount(rgba: ArrayLike<number>, patterns: ContrastPattern[]) {
  return matchCountPattern(rgba, patterns).value;
}
/** Rank all 15 values before applying the awakening limit: never turn an
 * out-of-range winner into a plausible but wrong second choice. Scores are
 * foreground/outline contrast, not calibrated recognition probabilities. */
export function matchCountPattern(rgba: ArrayLike<number>, patterns: ContrastPattern[], offsetY = 0, maximum = 15): CountPatternReading {
  const rejected = (reason: string): CountPatternReading => ({ value: null, candidate: null, score: 0, gap: 0, reason });
  if (!Number.isInteger(offsetY) || Math.abs(offsetY) > 6 || rgba.length !== 140 * 210 * 4)
    return rejected("장수 영역 크기 또는 위치 확인 필요");
  if (!packCount(rgba, 140, offsetY).hasIcon) return rejected("추가 카드 아이콘 없음");
  const gray = new Float32Array(50 * 22);
  for (let y = 0; y < 22; y++) for (let x = 0; x < 50; x++) {
    const i = ((y + 143 + offsetY) * 140 + x + 89) * 4;
    gray[y * 50 + x] = (.299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2]) / 255;
  }
  const scores = new Map<number, number>();
  for (const pattern of patterns) {
    if (!pattern.foreground.length || !pattern.outline.length) continue;
    let best = 0;
    for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) {
      let ink = 0, shadow = 0;
      const offset = dy * 50 + dx;
      let plusInk = 0, plusShadow = 0;
      for (const p of pattern.plus) plusInk += gray[p + offset];
      for (const p of pattern.plusOutline) plusShadow += gray[p + offset];
      if (!pattern.plus.length || !pattern.plusOutline.length ||
        plusInk / pattern.plus.length - plusShadow / pattern.plusOutline.length < .20) continue;
      for (const p of pattern.foreground) ink += gray[p + offset];
      for (const p of pattern.outline) shadow += gray[p + offset];
      best = Math.max(best, ink / pattern.foreground.length - shadow / pattern.outline.length);
    }
    scores.set(pattern.value, Math.max(scores.get(pattern.value) ?? 0, best));
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best || ranked.length < 15) return rejected("1~15 장수 템플릿 누락");
  const gap = best[1] - ranked[1][1];
  const reason = best[1] < .30 ? "숫자 획과 외곽선 대비 부족"
    : gap < .018 ? "장수 패턴 후보 간 차이 부족"
    : best[0] > maximum ? "각성별 장수 상한 초과"
    : "장수 전체 패턴 일치";
  return { value: reason === "장수 전체 패턴 일치" ? best[0] : null,
    candidate: best[0], score: best[1], gap, reason };
}
export function packCount(rgba: ArrayLike<number>, width = 140, offsetY = 0) {
  const bits = new Uint32Array(30);
  let pixels = 0, cyan = 0;
  for (let y = 141; y < 172; y++) for (let x = 56; x < 108; x++) {
    const i = ((y + offsetY) * width + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (g > 110 && b > 110 && g > r * 1.2 && b > r * 1.2) cyan++;
  }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 48; x++) {
    const i = ((y + 144 + offsetY) * width + x + 90) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (Math.min(r, g, b) > 155 && Math.max(r, g, b) - Math.min(r, g, b) < 85) {
      const index = y * 48 + x;
      bits[index >>> 5] |= 1 << (index & 31); pixels++;
    }
  }
  return { bits, pixels, hasIcon: cyan / (31 * 52) >= .025 };
}
