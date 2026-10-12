import type { Reference } from '../../src/features/card-scanner/recognizer';
import type { PortraitEvidence, PortraitTextEvidence } from '../../src/features/card-scanner/portrait-matcher';
import { areaGray } from '../../src/features/card-scanner/area-gray';

export interface MaskedAtlas { width: number; height: number; indices: number[]; cards: Record<string, string> }
export interface PortraitPixels { pixels: ArrayLike<number>; width: number; height: number }
const normalized = (values: number[]) => {
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  const out = Float32Array.from(values,v=>v-mean);
  const norm = Math.sqrt(out.reduce((a,b)=>a+b*b,0));
  return norm > 1e-6 ? out.map(v=>v/norm) : null;
};
const dot = (a: Float32Array, b: Float32Array) => {
  let sum=0; for(let i=0;i<a.length;i++)sum+=a[i]*b[i]; return sum;
};
/** Orthogonal projection onto constant four-pixel blocks. Residual energy
 * bounds every discarded detail, so this is a safe bound, not a top-K guess. */
const project=(vector:Float32Array)=>{
  const values=new Float32Array(Math.ceil(vector.length/4));
  for(let i=0;i<vector.length;i+=4) {
    const length=Math.min(4,vector.length-i);let sum=0;
    for(let j=0;j<length;j++)sum+=vector[i+j];values[i/4]=sum/Math.sqrt(length);
  }
  return {values,residual:Math.sqrt(Math.max(0,1-dot(values,values)))};
};

/** Color only orders work. Every identity still competes for the winner/margin. */
export function rarityHint({pixels,width,height}: PortraitPixels): number | undefined {
  const votes = [0,0,0,0,0];
  const borderVotes=[[0,0,0,0,0],[0,0,0,0,0]];
  const vote=(counts:number[],x:number,y:number)=>{
    const i=(y*width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(r>100&&g>70&&b<g*.8&&r>g*1.12)counts[4]++;
    else if(r>85&&b>90&&g<Math.min(r,b)*.88)counts[3]++;
    else if(g>90&&b>100&&r<Math.min(g,b)*.8)counts[2]++;
    else if(g>100&&r>40&&b<g*.65&&g>r*1.1)counts[1]++;
    else if(Math.min(r,g,b)>160&&Math.max(r,g,b)-Math.min(r,g,b)<45)counts[0]++;
  };
  for(let y=Math.round(height*.07);y<height*.22;y++)for(let x=Math.round(width*.05);x<width*.95;x++) {
    vote(votes,x,y);
  }
  for(let y=Math.round(height*.26);y<height*.45;y++)for(let x=0;x<width*.035;x++) {
    vote(borderVotes[0],x,y);vote(borderVotes[1],width-1-x,y);
  }
  const winner=(counts:number[],minimum:number)=>{
    const sorted=counts.map((count,grade)=>({count,grade})).sort((a,b)=>b.count-a.count);
    return sorted[0].count>=minimum&&sorted[0].count>sorted[1].count*2?sorted[0].grade:undefined;
  };
  const name=winner(votes,35),left=winner(borderVotes[0],8),right=winner(borderVotes[1],8);
  // Equipped gold borders can disagree with the name. Prefer the label then;
  // never discard identities on color, including absent or desaturated color.
  return name ?? (left===right?left:undefined);
}

/** Fixed asset-derived mask; no winner-specific pixel removal. The center pass
 * bounds every omitted translation by Cauchy-Schwarz, preserving all competitors. */
export function createMaskedMatcher(cards: Reference[], atlas: MaskedAtlas, exhaustive=false) {
  const {width,height,indices}=atlas;
  if(width!==48||height!==64||indices.length<100||new Set(indices).size!==indices.length||
    indices.some(i=>!Number.isInteger(i)||i<width+1||i>=width*(height-1)-1||i%width<1||i%width>=width-1))
    throw Error('Invalid masked portrait atlas');
  const xs=indices.map(i=>i%width),ys=indices.map(i=>Math.floor(i/width));
  const mx=(Math.min(...xs)+Math.max(...xs))/2,my=(Math.min(...ys)+Math.max(...ys))/2;
  const zones=[indices,indices.filter(i=>Math.floor(i/width)<=my),indices.filter(i=>Math.floor(i/width)>my),
    indices.filter(i=>i%width<=mx),indices.filter(i=>i%width>mx)];
  const refs=cards.flatMap(card=>{
    const value=atlas.cards[card.id];if(!value)return [];
    const gray=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(gray.length!==width*height)throw Error('Invalid portrait bytes');
    const vectors=zones.map(zone=>normalized(zone.map(i=>gray[i])));
    return vectors.every(Boolean)?[{card,vectors:vectors as Float32Array[],projection:project(vectors[0]!)}]:[];
  });
  return (source: PortraitPixels, text?: PortraitTextEvidence & {id:string}) => {
    if(refs.length<2)return null;
    const gray=areaGray(source.pixels,source.width,source.height,width,height);
    const offsets=[0,-1,1,-width,width,-width-1,-width+1,width-1,width+1];
    const queries=offsets.map(offset=>zones.map(zone=>normalized(zone.map(i=>gray[i+offset]))));
    if(!queries[0][0])return null;
    const hint=rarityHint(source);
    const ranked=refs.map(ref=>({ref,center:dot(ref.vectors[0],queries[0][0]!)}))
      .sort((a,b)=>Number(b.ref.card.rarity===hint)-Number(a.ref.card.rarity===hint) || b.center-a.center);
    const queryDistance=queries.map(q=>q[0]?Math.sqrt(Math.max(0,2-2*dot(queries[0][0]!,q[0]))):Infinity);
    const projected=queries.map(q=>q[0]?project(q[0]):null);
    type Candidate={ref:typeof refs[number];query:number;correlation:number};
    let winner:Candidate|undefined,second:Candidate|undefined;
    for(const {ref,center} of ranked) {
      // Scores below this bound cannot affect acceptance or the second identity.
      let best=center,bestQuery=0;
      for(let q=1;q<queries.length;q++)if(queries[q][0]&&(exhaustive||center+queryDistance[q]+1e-5>=Math.min(second?.correlation??-1,.74))) {
        const query=projected[q]!;
        const bound=dot(ref.projection.values,query.values)+ref.projection.residual*query.residual+1e-5;
        if(!exhaustive&&bound<Math.max(best,Math.min(second?.correlation??-1,.74)))continue;
        const score=dot(ref.vectors[0],queries[q][0]!);
        if(score>best){best=score;bestQuery=q;}
      }
      const candidate={ref,query:bestQuery,correlation:best};
      if(!winner||best>winner.correlation){second=winner;winner=candidate;}
      else if(!second||best>second.correlation)second=candidate;
    }
    if(!winner||!second)return null;
    const best=winner,margin=best.correlation-second.correlation;
    // Local consistency is needed for the winner only. Competitors retain their
    // global score, so a failed local check never promotes a convenient runner.
    const [,upper,lower,left,right]=best.ref.vectors.map((vector,i)=>queries[best.query][i]?dot(vector,queries[best.query][i]!):-1);
    const portrait:PortraitEvidence={upper,lower,left,right,correlation:best.correlation,margin,region:'above-badge'};
    if(text&&text.id!==best.ref.card.id)return null;
    return best.correlation>=.94&&Math.min(upper,lower,left,right)>=.90&&margin>=.2
      ? {card:best.ref.card,portrait}:null;
  };
}
