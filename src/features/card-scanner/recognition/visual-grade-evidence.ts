import {strongNameMask} from './text-mask';

/** Exploratory color evidence for uncommon/rare cards only. A null grade means
 * no conclusion, including unavailable or partially transparent input. It is
 * not an identity, a rank filter, or evidence that a label is unoccluded. */
export interface VisualGradeEvidence {
  readonly grade:1|2|null;
  readonly glyphs:readonly number[];
  readonly edges:readonly number[];
}
const unknown=():VisualGradeEvidence=>({grade:null,glyphs:[],edges:[]});
const width=140,height=210,labelWidth=128,labelHeight=36,lineHeight=18;

/** Match the existing strong-name connected-component geometry on the first
 * line. Large solid blobs and edge-connected artwork are not counted as ink. */
function glyphInk(mask:Uint8Array):number {
  const seen=new Uint8Array(labelWidth*lineHeight),queue=new Int32Array(seen.length);
  let ink=0;
  for(let start=0;start<seen.length;start++){
    if(seen[start]||!mask[start])continue;
    let head=0,tail=0,left=labelWidth,right=0,top=lineHeight,bottom=0;
    queue[tail++]=start;seen[start]=1;
    while(head<tail){
      const index=queue[head++],x=index%labelWidth,y=Math.floor(index/labelWidth);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      if(x>0){const next=index-1;if(!seen[next]&&mask[next]){seen[next]=1;queue[tail++]=next;}}
      if(x+1<labelWidth){const next=index+1;if(!seen[next]&&mask[next]){seen[next]=1;queue[tail++]=next;}}
      if(y>0){const next=index-labelWidth;if(!seen[next]&&mask[next]){seen[next]=1;queue[tail++]=next;}}
      if(y+1<lineHeight){const next=index+labelWidth;if(!seen[next]&&mask[next]){seen[next]=1;queue[tail++]=next;}}
    }
    if(top>=1&&top<=6&&bottom<=16&&bottom-top+1>=9&&right-left<24&&left>0&&right<127)ink+=tail;
  }
  return ink;
}

/** HSV conversion intentionally matches the local experimental JS port. OpenCV
 * can quantize individual boundary pixels differently; parity must be checked
 * on real input before the signal is used in a production decision. */
function addEdge(bins:number[],r:number,g:number,b:number):void {
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  if(max<70||!delta||Math.round(255*delta/max)<85)return;
  let degrees=max===r?60*((g-b)/delta):max===g?60*((b-r)/delta+2):60*((r-g)/delta+4);
  if(degrees<0)degrees+=360;
  const hue=Math.round(degrees/2)%180;
  bins[hue<12?0:hue<28?1:hue<82?2:hue<105?3:hue<130?4:hue<170?5:6]++;
}

/** Reads only a normalized native-size RGBA card. Both name and side-border
 * samples must be opaque; callers own crop alignment and obstruction checks. */
export function visualGradeEvidence(pixels:Uint8Array|Uint8ClampedArray):VisualGradeEvidence {
  if(!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray)||pixels.length!==width*height*4)return unknown();
  const label=new Uint8Array(labelWidth*labelHeight*4),edges=[0,0,0,0,0,0,0];
  let out=0;
  for(let y=14;y<50;y++)for(let x=6;x<134;x++){
    const at=(y*width+x)*4;
    // Only the first line contributes glyphs; keep the unobserved second line
    // out of the transparency contract, but copy it for strongNameMask shape.
    if(y<32&&pixels[at+3]!==255)return unknown();
    label[out++]=pixels[at];label[out++]=pixels[at+1];label[out++]=pixels[at+2];label[out++]=pixels[at+3];
  }
  for(let y=52;y<160;y++)for(const start of [0,134])for(let x=start;x<start+6;x++){
    const at=(y*width+x)*4;
    if(pixels[at+3]!==255)return unknown();
    addEdge(edges,pixels[at],pixels[at+1],pixels[at+2]);
  }
  const glyphs=Array.from({length:5},(_,grade)=>glyphInk(strongNameMask(label,grade)));
  const [g0,g1,g2,g3,g4]=glyphs,e1=edges[2],e2=edges[3]+edges[4];
  const otherEdge=Math.max(edges[0]+edges[6],edges[1],edges[5]),otherGlyph=Math.max(g0,g3,g4);
  let grade:1|2|null=null;
  if(g1>=35&&g1>=Math.max(g2,otherGlyph)*2&&e1>=50&&e1>=Math.max(e2,otherEdge)*2)grade=1;
  else if(g2>=35&&g2>=Math.max(g1,otherGlyph)*2&&e2>=50&&e2>=Math.max(e1,otherEdge)*2)grade=2;
  return {grade,glyphs,edges};
}

/** This signal can only veto a proposed catalog rarity; it never creates an
 * identity. Unknown/invalid evidence and unknown rarity have no authority. */
export function visualGradeConflict(evidence:VisualGradeEvidence,rarity:unknown):boolean {
  return (evidence.grade===1||evidence.grade===2)&&Number.isInteger(rarity)&&
    typeof rarity==='number'&&rarity>=0&&rarity<=4&&evidence.grade!==rarity;
}
