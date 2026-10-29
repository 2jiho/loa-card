/** Fixed recipes shared by diagnostic comparisons and opt-in name retries.
 * These transforms do not decide whether a name is
 * visible, identify a card, or add recognition evidence. */
export const NAME_LABEL_CONTRAST_VARIANTS=Object.freeze([
  'stretch-first-v1','local-dark-first-v1','local-absolute-first-v1',
] as const);
export type NameLabelContrastVariant=typeof NAME_LABEL_CONTRAST_VARIANTS[number];

const WIDTH=128,HEIGHT=18,INITIAL_HEIGHT=36,PIXELS=WIDTH*HEIGHT;
const GRAYSCALE='round(.299R+.587G+.114B)' as const;
const SOURCE_BOX=Object.freeze({x:0,y:0,width:128,height:18} as const);
const ALPHA='require opaque initial 128x36 RGBA; output alpha 255' as const;

interface CommonRecipe {
  readonly variant:NameLabelContrastVariant;
  readonly sourceBox:typeof SOURCE_BOX;
  readonly grayscale:typeof GRAYSCALE;
  readonly alpha:typeof ALPHA;
}
interface StretchRecipe extends CommonRecipe {
  readonly variant:'stretch-first-v1';
  readonly algorithm:'histogram-percentile-stretch';
  readonly lowQuantile:.01;readonly highQuantile:.99;
  readonly rankConvention:'zero-based; floor(low*(N-1)), ceil(high*(N-1))';
  readonly lowRank:number;readonly highRank:number;readonly lowGray:number;readonly highGray:number;
  readonly output:'round(clamp((gray-lowGray)*255/(highGray-lowGray),0,255))';
  readonly flatPolicy:'gray unchanged when highGray<=lowGray';
}
interface LocalRecipe extends CommonRecipe {
  readonly variant:'local-dark-first-v1'|'local-absolute-first-v1';
  readonly algorithm:'clipped-local-mean';readonly radius:3;readonly gain:8;
  readonly boundary:'clip 7x7 window to first 128x18 raster; divide by actual sample count';
  readonly difference:'max(0,mean-gray)'|'abs(mean-gray)';
  readonly output:'round(clamp(255-8*difference,0,255))';
}
export type NameLabelContrastRecipe=StretchRecipe|LocalRecipe;
export interface NameLabelContrastResult {
  readonly width:128;readonly height:18;
  readonly data:Uint8ClampedArray<ArrayBuffer>;
  readonly recipe:NameLabelContrastRecipe;
}

function grayFirstLine(source:Uint8ClampedArray):Uint8Array<ArrayBuffer> {
  if(!(source instanceof Uint8ClampedArray)||source.length!==WIDTH*INITIAL_HEIGHT*4)
    throw Error('Name contrast requires initial 128x36 RGBA.');
  // Validate the whole declared input, including the unused second line. No
  // alpha compositing or hidden transparent RGB becomes fabricated text.
  for(let i=3;i<source.length;i+=4)if(source[i]!==255)
    throw Error('Name contrast requires opaque initial RGBA.');
  const gray=new Uint8Array(PIXELS);
  for(let i=0;i<PIXELS;i++)gray[i]=Math.round(.299*source[i*4]+.587*source[i*4+1]+.114*source[i*4+2]);
  return gray;
}
function put(output:Uint8ClampedArray,index:number,value:number) {
  const offset=index*4,rounded=Math.round(Math.max(0,Math.min(255,value)));
  output[offset]=output[offset+1]=output[offset+2]=rounded;output[offset+3]=255;
}
function atRank(histogram:Uint16Array,rank:number):number {
  let count=0;
  for(let value=0;value<256;value++){count+=histogram[value];if(count>rank)return value;}
  throw Error('Invalid contrast histogram rank.');
}

/** Owns one 128x18 output; never mutates or retains the observed input array.
 * Work is bounded by 2304 pixels and, for local recipes, at most 49 neighbors.
 * Recipes record fixed operations and derived limits for exact repetition. */
export function nameLabelContrast(source:Uint8ClampedArray,variant:NameLabelContrastVariant):NameLabelContrastResult {
  if(!NAME_LABEL_CONTRAST_VARIANTS.includes(variant))throw Error('Unsupported name contrast variant.');
  const gray=grayFirstLine(source),data=new Uint8ClampedArray(PIXELS*4);
  const common={sourceBox:SOURCE_BOX,grayscale:GRAYSCALE,alpha:ALPHA};
  if(variant==='stretch-first-v1'){
    const histogram=new Uint16Array(256);
    for(const value of gray)histogram[value]++;
    const lowRank=Math.floor(.01*(PIXELS-1)),highRank=Math.ceil(.99*(PIXELS-1));
    const lowGray=atRank(histogram,lowRank),highGray=atRank(histogram,highRank);
    for(let i=0;i<PIXELS;i++)put(data,i,highGray<=lowGray?gray[i]:(gray[i]-lowGray)*255/(highGray-lowGray));
    const recipe:StretchRecipe={...common,variant,algorithm:'histogram-percentile-stretch',lowQuantile:.01,highQuantile:.99,
      rankConvention:'zero-based; floor(low*(N-1)), ceil(high*(N-1))',lowRank,highRank,lowGray,highGray,
      output:'round(clamp((gray-lowGray)*255/(highGray-lowGray),0,255))',flatPolicy:'gray unchanged when highGray<=lowGray'};
    return Object.freeze({width:128,height:18,data,recipe:Object.freeze(recipe)});
  }
  for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
    let sum=0,count=0;
    for(let row=Math.max(0,y-3);row<=Math.min(HEIGHT-1,y+3);row++)
      for(let column=Math.max(0,x-3);column<=Math.min(WIDTH-1,x+3);column++){
        sum+=gray[row*WIDTH+column];count++;
      }
    const difference=sum/count-gray[y*WIDTH+x];
    put(data,y*WIDTH+x,255-8*(variant==='local-dark-first-v1'?Math.max(0,difference):Math.abs(difference)));
  }
  const recipe:LocalRecipe={...common,variant,algorithm:'clipped-local-mean',radius:3,gain:8,
    boundary:'clip 7x7 window to first 128x18 raster; divide by actual sample count',
    difference:variant==='local-dark-first-v1'?'max(0,mean-gray)':'abs(mean-gray)',output:'round(clamp(255-8*difference,0,255))'};
  return Object.freeze({width:128,height:18,data,recipe:Object.freeze(recipe)});
}
