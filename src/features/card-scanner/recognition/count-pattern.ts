export interface CountPattern { value: number; bits: string; pixels: number }
/** User-confirmed semantics: the cyan card stack + white `+N` is the card
 * count (additional copies). The gold/gray card marker at the left is not a
 * count icon; the fixed count mask starts at x=56 to exclude it. */
export interface ContrastPattern { value: number; foreground: number[]; outline: number[]; plus: number[]; plusOutline: number[] }
export type CountEmptyEvidence = 'gray-card-marker-and-visible-background';
export const COUNT_UNEXPLAINED_TRAILING_GLYPH = '단일 숫자 후보 뒤 미설명 숫자 획';
export const COUNT_SUPERSET_STROKES = '더 많은 획의 숫자 획이 보임';
export interface CountPatternReading {
  value: number | null;
  candidate: number | null;
  score: number;
  gap: number;
  reason: string;
  emptyEvidence?: CountEmptyEvidence;
  /** With a trailing-stroke veto: the score a single-digit candidate needs to count as strong
   * at this crop size (countStrongScore). Absent: the 2560x1440 value. */
  strongScore?: number;
  /** The contrast floor used for a resampled crop (countContrastFloor). Absent: 0.30. Later
   * checks of the score (count-confidence.ts, count-corroboration.ts) scale by it. */
  contrastFloor?: number;
  /** For a crop narrower than 100 pixels: the factor on the score a candidate needs when an
   * independent digit OCR read the same value (countAgreementScale). Absent: as contrastFloor. */
  agreementScale?: number;
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
/** Whether a crop is resampled before it is read: every crop is drawn at 140x210, and only a
 * 2560x1440 full-screen card is 140 pixels wide. A width that is not known counts as native. */
function resampledCrop(cropWidth:number|undefined):boolean {
  return typeof cropWidth==='number'&&cropWidth>0&&Math.round(cropWidth)!==140;
}
/** The contrast a count pattern needs, for a crop of this width before it is drawn at 140x210.
 *
 * The digits are drawn white with a dark outline. Any crop that is not 140 pixels wide is
 * resampled to 140 before it is read, which blurs the outline into the artwork behind it. The
 * same card's count scores 0.64 (1920x1080, crop 105) and 0.69 (a 2560x1440 window drawn at 0.98,
 * crop 137) of its 2560x1440 full-screen score (medians over about 287 cards): the drop comes
 * from resampling at all, not from how much. Resampled crops therefore need 0.22, native crops
 * keep 0.30. Readings between 0.22 and 0.30: 1080p 681 on three shares, none with a wrong first
 * candidate; windowed 1440 225 on two shares, 5 wrong (소나벨 +10 read 13), all with a runner-up
 * gap of 0.002 or less, which the 0.018 gap rule rejects. The gap, the trailing-stroke veto and the
 * awakening limit are unchanged, and a pattern reading is still only one observation. */
export function countContrastFloor(cropWidth:number|undefined):number {
  return resampledCrop(cropWidth)?.22:.30;
}
/** The score a single-digit candidate needs, despite an unexplained trailing stroke, to count as
 * strong (count-confidence.ts; it still needs the runner-up gap and an agreeing independent OCR).
 *
 * 0.45 was set on 2560x1440 full-screen crops. A resampled crop scores lower (see
 * countContrastFloor): 0.55..0.68 (p10..p90) of the full-screen score at 1920x1080 and
 * 0.64..0.73 in a window drawn at 0.98. Resampled crops therefore need 0.45 x 0.6 = 0.27.
 * Measured case: 구스토 (+1 in front of a white coat) scores 0.50 at full screen and 0.29 at
 * 1080p with the same veto, gap 0.12 and OCR reading 1. */
export function countStrongScore(cropWidth:number|undefined):number {
  return resampledCrop(cropWidth)?.27:.45;
}
/** The runner-up gap that goes with a strong trailing-glyph candidate: 0.10 at full screen, scaled
 * like the score (strongScore / 0.45, i.e. 0.06 for a resampled crop). Measured case: 구스토 in a
 * 2560x1440 window drawn at 0.98 scores 0.32 with gap 0.066 (full screen: 0.50, gap 0.13), with the
 * independent OCR reading 1; it is drawn the same way in every frame, so showing it again cannot
 * help. The agreeing OCR value stays required. */
export function countStrongGap(reading:{strongScore?:number}|undefined):number {
  const score=reading?.strongScore;
  return typeof score==='number'&&score>0&&score<.45?.10*score/.45:.10;
}
/** A score threshold set on 2560x1440 full-screen crops, for the crop a reading came from: scaled
 * by that crop's contrast floor (0.22 / 0.30 for a resampled crop, see countContrastFloor). */
export function countScoreAtCropSize(fullScreenThreshold:number,reading:{contrastFloor?:number}|undefined):number {
  const floor=reading?.contrastFloor;
  return typeof floor==='number'&&floor>0&&floor<.30?fullScreenThreshold*floor/.30:fullScreenThreshold;
}
/** The factor on a full-screen score threshold for a candidate that an INDEPENDENT digit OCR
 * confirmed (the same value read from the digits by another reader). Never used for a pattern
 * reading alone.
 *
 * 0.625 interface scale (1600x900, 1600x1200; crop about 88 pixels): even with templates from that
 * scale, a third of the crops seen while scrolling stay below the 0.22 floor although the first
 * candidate is right (p10..p90 0.15..0.21, median 0.19, on 831 crops of two shares), with runner-up
 * gaps of 0.014..0.034. At this size the score barely separates right from wrong: lowering the
 * pattern-only floor to 0.18 also reads one wrong value (하백 +6 as 5 at 0.19, gap 0.029). So the
 * pattern alone keeps the 0.22 floor, and for an OCR-confirmed candidate the independent OCR
 * carries the evidence: the pattern must point at the same value with digit ink, at 0.4 of the
 * full-screen thresholds (score 0.30 -> 0.12, 0.40 -> 0.16, gap 0.035 -> 0.014). Wider resampled
 * crops keep 0.22/0.30, full-screen crops 1. */
export function countAgreementScale(cropWidth:number|undefined):number {
  if(!resampledCrop(cropWidth))return 1;
  return (cropWidth as number)<100?.4:.22/.30;
}
/** A full-screen threshold for an OCR-confirmed candidate of this reading (see countAgreementScale). */
export function countAgreementScore(fullScreenThreshold:number,reading:{contrastFloor?:number;agreementScale?:number}|undefined):number {
  const scale=reading?.agreementScale;
  return typeof scale==='number'&&scale>0&&scale<1?fullScreenThreshold*scale:countScoreAtCropSize(fullScreenThreshold,reading);
}
/** Rank all 15 values before applying the awakening limit: never turn an
 * out-of-range winner into a plausible but wrong second choice. Scores are
 * foreground/outline contrast, not calibrated recognition probabilities. */
export function matchCountPattern(rgba: ArrayLike<number>, patterns: ContrastPattern[], offsetY = 0, maximum = 15, requireIcon = true, minContrast = .30, strongScore = .45, agreementScale = 1): CountPatternReading {
  const rejected = (reason: string): CountPatternReading => ({ value: null, candidate: null, score: 0, gap: 0, reason });
  if (!Number.isInteger(offsetY) || Math.abs(offsetY) > 6 || rgba.length !== 140 * 210 * 4)
    return rejected("장수 영역 크기 또는 위치 확인 필요");
  if (requireIcon) {
    const packed=packCount(rgba,140,offsetY);
    if(packed.hasIcon===null)return rejected('장수 숫자 미검출 또는 불명확');
    if(packed.hasIcon===false)return {...rejected(packed.emptyEvidence?'회색 카드 표식 · 빈 장수 배경 확인':'추가 카드 아이콘 없음'),
      ...(packed.emptyEvidence?{emptyEvidence:packed.emptyEvidence}:{})};
  }
  const gray = new Float32Array(50 * 22);
  for (let y = 0; y < 22; y++) for (let x = 0; x < 50; x++) {
    const i = ((y + 143 + offsetY) * 140 + x + 89) * 4;
    gray[y * 50 + x] = (.299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2]) / 255;
  }
  const scores = new Map<number, number>();
  const placements = new Map<number, {pattern:ContrastPattern;dx:number;dy:number}>();
  for (const pattern of patterns) {
    if (!pattern.foreground.length || !pattern.outline.length) continue;
    let best = 0, placement:{pattern:ContrastPattern;dx:number;dy:number}|undefined;
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
      const score=ink / pattern.foreground.length - shadow / pattern.outline.length;
      if(score>best){best=score;placement={pattern,dx,dy};}
    }
    if(best>(scores.get(pattern.value)??0)&&placement)placements.set(pattern.value,placement);
    scores.set(pattern.value, Math.max(scores.get(pattern.value) ?? 0, best));
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best || ranked.length < 15) return rejected("1~15 장수 템플릿 누락");
  const gap = best[1] - ranked[1][1];
  const reason = best[1] < minContrast ? "숫자 획과 외곽선 대비 부족"
    : best[0] > maximum ? "각성별 장수 상한 초과"
    : best[0] < 10 && placements.has(best[0]) && hasTrailingCountStroke(gray,placements.get(best[0])!)
      ? COUNT_UNEXPLAINED_TRAILING_GLYPH
    : gap < .018 ? "장수 패턴 후보 간 차이 부족"
    : placements.has(best[0]) && supersetStrokesVisible(gray,placements.get(best[0])!,placements,best[0],minContrast,scores) ? COUNT_SUPERSET_STROKES
    : "장수 전체 패턴 일치";
  return { value: reason === "장수 전체 패턴 일치" ? best[0] : null,
    candidate: best[0], score: best[1], gap, reason,
    ...(reason === COUNT_UNEXPLAINED_TRAILING_GLYPH && strongScore !== .45 ? { strongScore } : {}),
    ...(minContrast !== .30 ? { contrastFloor: minContrast } : {}),
    ...(agreementScale !== 1 && agreementScale !== .22 / .30 ? { agreementScale } : {}) };
}

/** A count drawn with more strokes than the winner can score below it when its own templates fit
 * this rendering less well: a 5120x2880 "+8" read as 3 (score 0.48, gap 0.068; 3 is 8 without its
 * left strokes), and 6 read as 5 with templates of that scale. When another plausible value's
 * glyph covers the winner's and the strokes only it has are lit like ink where the winner has
 * none, the crop may show that value: no value is read. A veto only: the other value is never
 * read instead (an OCR reading or another crop decides). */
function supersetStrokesVisible(gray:Float32Array,winner:{pattern:ContrastPattern;dx:number;dy:number},
  placements:ReadonlyMap<number,{pattern:ContrastPattern;dx:number;dy:number}>,value:number,minContrast:number,scores:ReadonlyMap<number,number>):boolean {
  const at=(placement:{dx:number;dy:number},p:number)=>p+placement.dy*50+placement.dx;
  const own=winner.pattern.foreground.map(p=>at(winner,p)),outline=winner.pattern.outline.map(p=>at(winner,p));
  const mean=(positions:readonly number[])=>{let sum=0;for(const p of positions)sum+=gray[p];return positions.length?sum/positions.length:0;};
  const ink=mean(own);
  for(const [other,placement] of placements){
    if(other===value||(scores.get(other)??0)<minContrast)continue;
    const theirs=new Set(placement.pattern.foreground.map(p=>at(placement,p)));
    // The other glyph covers the winner's strokes (one pixel of slack) ...
    const covered=own.filter(p=>theirs.has(p)||theirs.has(p-1)||theirs.has(p+1)||theirs.has(p-50)||theirs.has(p+50)).length;
    if(covered<own.length*.9)continue;
    // ... and has strokes where the winner has its dark outline: are they lit like ink?
    const lit=outline.filter(p=>theirs.has(p)),dark=outline.filter(p=>!theirs.has(p));
    if(lit.length<8)continue;
    const shadow=mean(dark);
    if(ink>shadow&&mean(lit)>=shadow+.6*(ink-shadow))return true;
  }
  return false;
}

/** A positive, font-shaped unexplained stroke can be a second digit. This is
 * a veto, not a classifier: do not promote its position into another count. */
function hasTrailingCountStroke(gray:Float32Array,placement:{pattern:ContrastPattern;dx:number;dy:number}) {
  const right=Math.max(...placement.pattern.foreground.map(p=>p%50))+placement.dx;
  const left=right+2;
  // A glyph may merge with bright artwork at the lower cutoff. Re-examine a
  // brighter core rather than treating the entire merged component as text.
  // Both passes are vetoes only; they never infer which other digit is present.
  for(const {threshold,maxWidth} of [{threshold:.55,maxWidth:10},{threshold:.65,maxWidth:13}]){
  const seen=new Uint8Array(50*22);
  const ink=(p:number)=>gray[p]>=threshold;
  for(let y=2;y<20;y++)for(let x=left;x<49;x++){
    const start=y*50+x;if(seen[start]||!ink(start))continue;
    const component=[start];seen[start]=1;let minX=x,maxX=x,minY=y,maxY=y;
    for(let at=0;at<component.length;at++){
      const p=component[at],px=p%50,py=Math.floor(p/50);
      minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=px+dx,ny=py+dy,next=ny*50+nx;
        if(nx<left||nx>=49||ny<2||ny>=20||seen[next]||!ink(next))continue;
        seen[next]=1;component.push(next);
      }
    }
    const width=maxX-minX+1,height=maxY-minY+1;
    if(height<8||height>18||width>maxWidth||component.length<8)continue;
    const outline=new Set<number>();
    for(const p of component){const px=p%50,py=Math.floor(p/50);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=px+dx,ny=py+dy,next=ny*50+nx;
        if(nx<0||nx>=50||ny<0||ny>=22||ink(next))continue;
        outline.add(next);
      }
    }
    if(!outline.size)continue;
    const foreground=component.reduce((sum,p)=>sum+gray[p],0)/component.length;
    const background=[...outline].reduce((sum,p)=>sum+gray[p],0)/outline.size;
    if(foreground-background>=.30)return true;
  }
  }
  return false;
}
export function packCount(rgba: ArrayLike<number>, width = 140, offsetY = 0, diagnostic = false) {
  const bits = new Uint32Array(30);
  let pixels = 0, cyan = 0, iconCore = 0;
  const core = new Uint8Array(18 * 10);
  for (let y = 141; y < 172; y++) for (let x = 56; x < 108; x++) {
    const i = ((y + offsetY) * width + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (g > 110 && b > 110 && g > r * 1.2 && b > r * 1.2) {
      cyan++;
      // The fixed extra-copy icon has a cyan upper body here. Artwork can
      // cross the lower/right part of the wider search region (e.g. Shandi).
      if (x >= 64 && x < 82 && y >= 143 && y < 153) {
        iconCore++;
        core[(y-143)*18+x-64] = Math.min(g,b)-r >= 40 ? 2 : 1;
      }
    }
  }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 48; x++) {
    const i = ((y + 144 + offsetY) * width + x + 90) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (Math.min(r, g, b) > 155 && Math.max(r, g, b) - Math.min(r, g, b) < 85) {
      const index = y * 48 + x;
      bits[index >>> 5] |= 1 << (index & 31); pixels++;
    }
  }
  // Isolated artwork highlights are not a numeric stroke. Check connectivity
  // only when the fixed icon body is absent; an icon remnant alone still keeps
  // this observation unresolved even if the digits are covered.
  const iconColor = cyan / (31 * 52) >= .025;
  let numericEvidence = pixels > 0 && hasCountStroke(bits, iconColor ? undefined : {rgba,width,offsetY});
  // Brightness can join a pale outline/artwork to the white glyph at the
  // first threshold. Inspect stricter masks while always measuring contrast
  // against the original pixels, never a threshold-painted black background.
  if(!iconColor&&!numericEvidence&&pixels>0)for(const threshold of [175,195,215]){
    const bright=new Uint32Array(30);
    for(let y=0;y<20;y++)for(let x=0;x<48;x++){
      const i=((144+y+offsetY)*width+90+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(Math.min(r,g,b)>threshold&&Math.max(r,g,b)-Math.min(r,g,b)<85){const p=y*48+x;bright[p>>>5]|=1<<(p&31);}
    }
    if(hasCountStroke(bright,{rgba,width,offsetY})){numericEvidence=true;break;}
  }
  const iconRemnant = iconCore > 2 && hasIconBody(core,rgba,width,offsetY);
  const emptyFields = !iconRemnant && !numericEvidence;
  // Missing cyan is not absence: the cursor may cover only the icon while
  // numeric strokes remain. null keeps this observation eligible for OCR
  // without allowing the zero shortcut or claiming a positively seen icon.
  const grayCandidate=!emptyFields&&!iconColor&&!numericEvidence;
  // The vertical position at which the gray paper marker's whole geometry is seen; the counter
  // field is drawn at that same position (see grayCardMarker).
  const markerAt=grayCandidate||diagnostic?grayCardMarkerOffset(rgba,width,offsetY):null;
  const grayMarker=markerAt!==null;
  const visibleBackground=grayCandidate||diagnostic?visibleCounterBackground(rgba,width,markerAt??offsetY,
    markerAt===null||markerAt===offsetY?core:counterCore(rgba,width,markerAt)):false;
  const grayBackgroundEmpty=grayCandidate&&grayMarker&&visibleBackground;
  // Entirely flat opaque patches can cover both a positive icon and its
  // digits while leaving the name, jewels and outer card border intact.
  // A lack of color/strokes there is not evidence of an empty counter.
  const texture=emptyFields||grayBackgroundEmpty||diagnostic?counterFieldTexture(rgba,width,offsetY):undefined;
  const highFrequencyCover=emptyFields||grayBackgroundEmpty||diagnostic?highFrequencyCounterCover(rgba,width,offsetY):false;
  const flatCover=(emptyFields||grayBackgroundEmpty)&&((!!texture&&texture.unobservable)||highFrequencyCover);
  const hasIcon: boolean | null = flatCover ? null : emptyFields||grayBackgroundEmpty ? false : iconColor ? true : null;
  return { bits, pixels, hasIcon,
    ...(grayBackgroundEmpty&&!flatCover?{emptyEvidence:'gray-card-marker-and-visible-background' as const}:{}),
    ...(diagnostic?{diagnostic:{iconColor,numericEvidence,iconRemnant,emptyFields,grayMarker,visibleBackground,grayBackgroundEmpty,
      iconFlat:texture?.iconFlat??false,digitsFlat:texture?.digitsFlat??false,highFrequencyCover,flatCover}}:{}) };
}
export type EmptyPreviewEvidence = Pick<ReturnType<typeof packCount>, 'hasIcon' | 'diagnostic'>;

/** A stable saved preview can prove an empty counter even when the icon
 * aperture is flat artwork, provided the digits aperture is textured and no
 * icon or numeric stroke is visible. See `emptyCounterProof` for how many
 * observations the caller needs (one). */
export function stablePreviewEmptyCandidate(packed: EmptyPreviewEvidence): boolean {
  const d=packed.diagnostic;
  return packed.hasIcon===null&&!!d&&d.emptyFields===true&&d.iconColor===false&&
    d.iconRemnant===false&&d.numericEvidence===false&&d.iconFlat===true&&d.digitsFlat===false&&
    d.highFrequencyCover===false;
}

/** How an empty counter (a clean 0) was proven from a saved preview, or null.
 *
 * The evidence is the same strict `stablePreviewEmptyCandidate` in every case
 * (no icon color, remnant or numeric stroke; a flat icon aperture; a textured,
 * not flat-covered digits aperture). One observation is enough to show the 0,
 * exactly as one observation is enough to show a positive count: more sightings
 * only make a value firmer, and a later reading that disagrees replaces it
 * (the newest valid observation wins). Measured on 9 recordings, this evidence
 * fired on none of 7344 observation images of cards with a confirmed positive
 * count (local notes in fixtures/local/notes/, with the private recordings). An observation count below 1 proves nothing. */
export type EmptyCounterProof = 'still-image' | 'repeated-observations' | 'single-observation';
export function emptyCounterProof(
  packed: EmptyPreviewEvidence,
  observations: number,
  stillImage: boolean,
): EmptyCounterProof | null {
  if (!Number.isInteger(observations) || observations < 1) return null;
  if (!stablePreviewEmptyCandidate(packed)) return null;
  if (stillImage && observations === 1) return 'still-image';
  return observations >= 3 ? 'repeated-observations' : 'single-observation';
}

/** Veto zero when either aperture is translucent or low-contrast. An opaque
 * cursor/cover can hide the icon while the digits area still looks textured.
 * This is not a general occlusion detector: natural low-texture artwork can
 * also become unknown, and sufficiently textured overlays can escape it. */
function counterFieldTexture(rgba:ArrayLike<number>,width:number,offsetY:number) {
  let invalid=false;
  const flat=(left:number,top:number,w:number,h:number)=>{
    let minR=255,minG=255,minB=255,maxR=0,maxG=0,maxB=0;
    for(let y=top;y<top+h;y++)for(let x=left;x<left+w;x++){
      const i=((y+offsetY)*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(rgba[i+3]!==255||!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)){invalid=true;continue;}
      minR=Math.min(minR,r);minG=Math.min(minG,g);minB=Math.min(minB,b);
      maxR=Math.max(maxR,r);maxG=Math.max(maxG,g);maxB=Math.max(maxB,b);
    }
    return maxR-minR<=32&&maxG-minG<=32&&maxB-minB<=32;
  };
  const iconFlat=flat(64,143,18,10);
  const digitsFlat=flat(90,144,48,20);
  return {invalid,iconFlat,digitsFlat,unobservable:invalid||iconFlat||digitsFlat};
}

/** A dark checkerboard/dither overlay can hide a positive counter while
 * looking textured. Natural card artwork rarely has near-every-pixel
 * achromatic edges in both directions. This is a cover veto, not a zero rule. */
export function highFrequencyCounterCover(rgba:ArrayLike<number>,width=140,offsetY=0):boolean {
  if(!Number.isSafeInteger(width)||width<=0||Math.abs(offsetY)>6||rgba.length<width*210*4)return false;
  const regions=[[64,143,18,10],[90,144,48,20]];
  let total=0,horizontal=0,vertical=0,both=0,differenceSamples=0;
  const differenceHistogram=new Uint32Array(256);
  const recordDifference=(difference:number)=>{
    differenceHistogram[Math.max(0,Math.min(255,Math.round(difference)))]++;
    differenceSamples++;
  };
  for(const [x0,y0,w,h] of regions){
    for(let y=Math.max(1,y0);y<y0+h-1;y++)for(let x=Math.max(1,x0);x<x0+w-1;x++){
      const i=((y+offsetY)*width+x)*4;
      if(rgba[i+3]!==255)continue;
      const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(Math.max(r,g,b)-Math.min(r,g,b)>28)continue;
      const gray=.299*r+.587*g+.114*b;
      const left=.299*rgba[i-4]+.587*rgba[i-3]+.114*rgba[i-2];
      const right=.299*rgba[i+4]+.587*rgba[i+5]+.114*rgba[i+6];
      const up=.299*rgba[i-width*4]+.587*rgba[i-width*4+1]+.114*rgba[i-width*4+2];
      const down=.299*rgba[i+width*4]+.587*rgba[i+width*4+1]+.114*rgba[i+width*4+2];
      recordDifference(Math.abs(gray-left));recordDifference(Math.abs(gray-right));
      recordDifference(Math.abs(gray-up));recordDifference(Math.abs(gray-down));
      const hEdge=Math.abs(gray-left)>=20||Math.abs(gray-right)>=20;
      const vEdge=Math.abs(gray-up)>=20||Math.abs(gray-down)>=20;
      if(hEdge)horizontal++;
      if(vEdge)vertical++;
      if(hEdge&&vEdge)both++;
      total++;
    }
  }
  if(total<250||differenceSamples<1000)return false;
  const medianDifference=()=>{
    const target=differenceSamples*.5;let accumulated=0;
    for(let value=0;value<256;value++){
      accumulated+=differenceHistogram[value];
      if(accumulated>=target)return value;
    }
    return 255;
  };
  // A filled highlight or a few bright pixels do not move the median neighbor
  // difference. A genuine 1px high-contrast checkerboard does.
  return medianDifference()>=38&&horizontal/total>=.80&&vertical/total>=.80&&both/total>=.45;
}

/** The left card-marker is not itself a zero-count symbol: positive counters
 * have it too. Its whole neutral outline only corroborates unobscured UI for
 * the separate counter-background proof below. No card artwork is matched. */
function grayCardMarkerOffset(rgba:ArrayLike<number>,width:number,offsetY:number):number|null {
  // The whole paper geometry is required at one vertical position. A card drawn from a larger
  // screen (5120x2880, a 280-pixel card reduced to 140) can put the counter field one pixel below
  // the position the jewels gave, which softens one edge below its contrast; one pixel either
  // way is tried, never a different shape.
  return [offsetY,offsetY+1,offsetY-1].find(at=>grayCardMarkerAt(rgba,width,at))??null;
}
/** The icon core classification (0 none, 1 cyan, 2 saturated cyan) at a vertical offset, as packCount builds it. */
function counterCore(rgba:ArrayLike<number>,width:number,offsetY:number):Uint8Array {
  const core=new Uint8Array(18*10);
  for(let y=143;y<153;y++)for(let x=64;x<82;x++){
    const i=((y+offsetY)*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
    if(g>110&&b>110&&g>r*1.2&&b>r*1.2)core[(y-143)*18+x-64]=Math.min(g,b)-r>=40?2:1;
  }
  return core;
}
function grayCardMarkerAt(rgba:ArrayLike<number>,width:number,offsetY:number) {
  const gray=(x:number,y:number)=>{const i=((y+offsetY)*width+x)*4;return .299*rgba[i]+.587*rgba[i+1]+.114*rgba[i+2];};
  const line=(x:number,y:number,dx:number,dy:number,n:number,bx:number,by:number,contrast:number)=>{
    let neutral=0,edge=0;
    for(let k=0;k<n;k++){
      const xx=x+dx*k,yy=y+dy*k,i=((yy+offsetY)*width+xx)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
      if(rgba[i+3]!==255)return false;
      // Gray UI shading can brighten without becoming colored; use relative
      // channel spread rather than an artwork-specific RGB triplet.
      if(Math.max(r,g,b)-Math.min(r,g,b)<=Math.max(r,g,b)*.2)neutral++;
      edge+=gray(xx,yy)-gray(xx+bx,yy+by);
    }
    return neutral>=Math.ceil(n*.85)&&edge/n>=contrast;
  };
  // Back sheet: complete top/left/right edges. Front sheet: complete right
  // and bottom edges, including both lower corners. A flat grey occluder or
  // a partial paper fragment cannot supply this geometry.
  return line(14,140,1,0,14,0,-2,15)&&line(12,143,0,1,7,-2,0,15)&&
    line(28,143,0,1,7,2,0,15)&&line(30,153,0,1,11,2,0,20)&&
    line(11,164,1,0,19,0,2,25);
}

/** Positive evidence of illustrated background, not merely failed OCR. The
 * only potentially misleading component must continue above the fixed icon,
 * with no lower blue body. Its lower body must remain opaque and textured;
 * a covered icon/digit patch stays unknown. Existing font evidence is a veto
 * at the caller, and isolated/partially visible blue remnants keep their guard. */
function visibleCounterBackground(rgba:ArrayLike<number>,width:number,offsetY:number,core:Uint8Array) {
  const cyan=(x:number,y:number)=>{const i=((y+offsetY)*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2];
    return g>110&&b>110&&g>r*1.2&&b>r*1.2;};
  for(let y=150;y<166;y++)for(let x=64;x<83;x++)if(cyan(x,y))return false;
  const seeds:number[]=[];
  for(let p=0;p<core.length;p++)if(core[p]===2)seeds.push((143+Math.floor(p/18))*width+64+p%18);
  // Muted cyan artwork (no saturated pixel) is held to the same conditions: it must continue
  // above the icon, leave the icon's body rows free of cyan, and show textured background below.
  // Seen on 하누마탄 at 5120x2880: a teal swirl across the icon's top rows, visibly no icon.
  if(seeds.length<3)for(let p=0;p<core.length;p++)if(core[p]===1)seeds.push((143+Math.floor(p/18))*width+64+p%18);
  if(seeds.length<3)return false;
  const seen=new Set<number>(),queue=[seeds[0]];seen.add(seeds[0]);let above=false;
  for(let at=0;at<queue.length;at++){
    const p=queue[at],x=p%width,y=Math.floor(p/width);if(y<=141)above=true;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy,next=yy*width+xx;
      if(xx<56||xx>=90||yy<137||yy>=150||seen.has(next)||!cyan(xx,yy))continue;
      const from=((y+offsetY)*width+x)*4,to=((yy+offsetY)*width+xx)*4;
      if(Math.max(Math.abs(rgba[from]-rgba[to]),Math.abs(rgba[from+1]-rgba[to+1]),Math.abs(rgba[from+2]-rgba[to+2]))>32)continue;
      seen.add(next);queue.push(next);
    }
  }
  if(!above||!seeds.every(p=>seen.has(p)))return false;
  // Every 6x6 patch below the artifact must contain visible background detail.
  // This does not infer its identity; it rejects flat/opaque icon coverings.
  for(let y=151;y<=159;y+=4)for(let x=64;x<=76;x+=4){
    let sum=0,squared=0;
    for(let dy=0;dy<6;dy++)for(let dx=0;dx<6;dx++){
      const i=((y+dy+offsetY)*width+x+dx)*4;
      if(rgba[i+3]!==255)return false;
      const value=(rgba[i]+rgba[i+1]+rgba[i+2])/3;sum+=value;squared+=value*value;
    }
    if(squared/36-(sum/36)**2<25)return false;
  }
  return true;
}

/** A few muted cyan artwork flecks are not the fixed overlay's upper body.
 * Keep strongly colored fragments even when mostly covered. Dim fragments
 * need a connected patch or edge with contrast against its surroundings.
 * Muted cloth pixels can cross the color threshold without an actual overlay
 * boundary, so neither their length nor their two-dimensional area is proof. */
function hasIconBody(core:Uint8Array,rgba:ArrayLike<number>,sourceWidth:number,offsetY:number) {
  let saturated=0;
  for(const value of core)if(value===2&&++saturated>=3)return true;
  const seen=new Uint8Array(core.length);
  for(let start=0;start<core.length;start++) {
    if(!core[start]||seen[start])continue;
    const component=[start];seen[start]=1;
    let left=start%18,right=left,top=Math.floor(start/18),bottom=top;
    for(let at=0;at<component.length;at++) {
      const p=component[at],x=p%18,y=Math.floor(p/18);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
        const nx=x+dx,ny=y+dy,next=ny*18+nx;
        if(nx<0||nx>=18||ny<0||ny>=10||seen[next]||!core[next])continue;
        seen[next]=1;component.push(next);
      }
    }
    const width=right-left+1,height=bottom-top+1;
    if((component.length>=3&&width>=3&&height>=3)||
        (component.length>=5&&Math.max(width,height)>=5)) {
      const outline=new Set<number>();
      for(const p of component) {
        const x=p%18,y=Math.floor(p/18);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
          const nx=x+dx,ny=y+dy;
          if(nx>=0&&nx<18&&ny>=0&&ny<10&&core[ny*18+nx])continue;
          outline.add((143+offsetY+ny)*sourceWidth+64+nx);
        }
      }
      const gray=(pixel:number)=>.299*rgba[pixel*4]+.587*rgba[pixel*4+1]+.114*rgba[pixel*4+2];
      const foreground=component.reduce((sum,p)=>sum+gray((143+offsetY+Math.floor(p/18))*sourceWidth+64+p%18),0)/component.length;
      const background=[...outline].reduce((sum,p)=>sum+gray(p),0)/outline.size;
      if(foreground-background>=20)return true;
    }
  }
  return false;
}

/** Eight-neighbour connectivity preserves diagonal/partially visible glyphs.
 * A few detached bright pixels can come from artwork or resampling. */
function hasCountStroke(bits: Uint32Array, font?:{rgba:ArrayLike<number>;width:number;offsetY:number}) {
  const seen = new Uint8Array(960);
  const ink = (p: number) => (bits[p >>> 5] >>> (p & 31)) & 1;
  for (let start = 0; start < 960; start++) {
    if (seen[start] || !ink(start)) continue;
    const component = [start];
    seen[start] = 1;
    for (let at = 0; at < component.length; at++) {
      const p = component[at], x = p % 48, y = Math.floor(p / 48);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * 48 + nx;
        if (nx < 0 || nx >= 48 || ny < 0 || ny >= 20 || seen[next] || !ink(next)) continue;
        seen[next] = 1;
        component.push(next);
        if (!font && component.length >= 4) return true;
      }
    }
    if(font&&component.length>=4){
      const xs=component.map(p=>p%48),ys=component.map(p=>Math.floor(p/48));
      const left=Math.min(...xs),top=Math.min(...ys),width=Math.max(...xs)-left+1,height=Math.max(...ys)-top+1;
      const density=component.length/(width*height);
      // Without the cyan icon, require the fixed font's size and baseline,
      // not merely four connected armor highlights or a white rectangle.
      // Dim text can split the '+' into its horizontal bar and stem. Its
      // remaining bar still has the fixed width and center-line position.
      const plus=width>=7&&width<=12&&height>=2&&height<=12&&top>=3&&top<=9&&top+height<=17&&left>=3&&left<=16;
      const digit=width>=2&&width<=13&&height>=12&&height<=16&&top>=1&&top<=4&&left>=17&&left<=36;
      if((plus||digit)&&density>=.16&&density<=.75){
        const gray=(p:number)=>{
          const i=((144+font.offsetY+Math.floor(p/48))*font.width+90+p%48)*4;
          return .299*font.rgba[i]+.587*font.rgba[i+1]+.114*font.rgba[i+2];
        };
        const outline=new Set<number>();
        for(const p of component){const x=p%48,y=Math.floor(p/48);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            const nx=x+dx,ny=y+dy,next=ny*48+nx;
            if(nx>=0&&nx<48&&ny>=0&&ny<20&&!ink(next))outline.add(next);
          }
        }
        if(outline.size&&component.reduce((sum,p)=>sum+gray(p),0)/component.length-
          [...outline].reduce((sum,p)=>sum+gray(p),0)/outline.size>=.20*255)return true;
      }
    }
  }
  return false;
}
