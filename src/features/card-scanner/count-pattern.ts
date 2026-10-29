export interface CountPattern { value: number; bits: string; pixels: number }
export interface ContrastPattern { value: number; foreground: number[]; outline: number[]; plus: number[]; plusOutline: number[] }
export type CountEmptyEvidence = 'gray-card-marker-and-visible-background';
export interface CountPatternReading {
  value: number | null;
  candidate: number | null;
  score: number;
  gap: number;
  reason: string;
  emptyEvidence?: CountEmptyEvidence;
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
export function matchCountPattern(rgba: ArrayLike<number>, patterns: ContrastPattern[], offsetY = 0, maximum = 15, requireIcon = true): CountPatternReading {
  const rejected = (reason: string): CountPatternReading => ({ value: null, candidate: null, score: 0, gap: 0, reason });
  if (!Number.isInteger(offsetY) || Math.abs(offsetY) > 6 || rgba.length !== 140 * 210 * 4)
    return rejected("장수 영역 크기 또는 위치 확인 필요");
  if (requireIcon) {
    const packed=packCount(rgba,140,offsetY);
    if(packed.hasIcon===null)return rejected('추가 장수 영역 가림 또는 불명확');
    if(packed.hasIcon===false)return {...rejected(packed.emptyEvidence?'회색 카드 표식 · 빈 장수 배경 확인':'추가 카드 아이콘 없음'),
      ...(packed.emptyEvidence?{emptyEvidence:packed.emptyEvidence}:{})};
  }
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
  const grayBackgroundEmpty=!emptyFields&&!iconColor&&!numericEvidence&&
    grayCardMarker(rgba,width,offsetY)&&visibleCounterBackground(rgba,width,offsetY,core);
  const hasIcon: boolean | null = emptyFields||grayBackgroundEmpty ? false : iconColor ? true : null;
  return { bits, pixels, hasIcon,
    ...(grayBackgroundEmpty?{emptyEvidence:'gray-card-marker-and-visible-background' as const}:{}) };
}

/** The left card-marker is not itself a zero-count symbol: positive counters
 * have it too. Its whole neutral outline only corroborates unobscured UI for
 * the separate counter-background proof below. No card artwork is matched. */
function grayCardMarker(rgba:ArrayLike<number>,width:number,offsetY:number) {
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
