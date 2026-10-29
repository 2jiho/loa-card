/** Fixed DEV color experiments. No name, grade or acceptance decision is made. */
export const NAME_LABEL_COLOR_VARIANTS=Object.freeze([
  'chroma-first-v1','red-first-v1','green-first-v1','blue-first-v1',
] as const);
export type NameLabelColorVariant=typeof NAME_LABEL_COLOR_VARIANTS[number];

const WIDTH=128,HEIGHT=18,INITIAL_HEIGHT=36,PIXELS=WIDTH*HEIGHT;
const SOURCE_BOX=Object.freeze({x:0,y:0,width:128,height:18} as const);
const SCALARS=Object.freeze({
  'chroma-first-v1':'max(R,G,B)-min(R,G,B)',
  'red-first-v1':'R','green-first-v1':'G','blue-first-v1':'B',
} as const);
export interface NameLabelColorRecipe {
  readonly variant:NameLabelColorVariant;
  readonly sourceBox:typeof SOURCE_BOX;
  readonly scalar:typeof SCALARS[NameLabelColorVariant];
  readonly algorithm:'histogram-percentile-stretch';
  readonly sampleCount:2304;
  readonly lowQuantile:.01;readonly highQuantile:.99;
  readonly rankConvention:'zero-based; floor(low*(N-1)), ceil(high*(N-1))';
  readonly lowRank:number;readonly highRank:number;readonly lowScalar:number;readonly highScalar:number;
  readonly normalization:'round(clamp((scalar-lowScalar)*255/(highScalar-lowScalar),0,255))';
  readonly inversion:'255-normalized'|'none';
  readonly flatPolicy:'retain scalar when highScalar<=lowScalar; apply inversion afterward';
  readonly boundary:'first 128x18 raster only; second line excluded from scalar and histogram';
  readonly alpha:'require opaque initial 128x36 RGBA; output alpha 255';
  readonly rounding:'integer input scalars; clamp before Math.round normalization; inversion after rounding';
}
export interface NameLabelColorResult {
  readonly width:128;readonly height:18;
  readonly data:Uint8ClampedArray<ArrayBuffer>;
  readonly recipe:NameLabelColorRecipe;
}

function scalarsFirstLine(source:Uint8ClampedArray,variant:NameLabelColorVariant):Uint8Array<ArrayBuffer> {
  if(!(source instanceof Uint8ClampedArray)||source.length!==WIDTH*INITIAL_HEIGHT*4)
    throw Error('Name color requires initial 128x36 RGBA.');
  // Validate the full declared source, including the unused second line. Hidden
  // transparent RGB must not become synthetic glyph evidence.
  for(let i=3;i<source.length;i+=4)if(source[i]!==255)
    throw Error('Name color requires opaque initial RGBA.');
  const scalars=new Uint8Array(PIXELS);
  for(let i=0;i<PIXELS;i++){
    const offset=i*4,r=source[offset],g=source[offset+1],b=source[offset+2];
    scalars[i]=variant==='chroma-first-v1'?Math.max(r,g,b)-Math.min(r,g,b):
      variant==='red-first-v1'?r:variant==='green-first-v1'?g:b;
  }
  return scalars;
}
function atRank(histogram:Uint16Array,rank:number):number {
  let count=0;
  for(let value=0;value<256;value++){count+=histogram[value];if(count>rank)return value;}
  throw Error('Invalid color histogram rank.');
}

/** Pure bounded first-line transform. Owns its output and records both the
 * fixed formula and derived percentile limits for deterministic repetition. */
export function nameLabelColor(source:Uint8ClampedArray,variant:NameLabelColorVariant):NameLabelColorResult {
  if(!NAME_LABEL_COLOR_VARIANTS.includes(variant))throw Error('Unsupported name color variant.');
  const scalars=scalarsFirstLine(source,variant),histogram=new Uint16Array(256);
  for(const value of scalars)histogram[value]++;
  const lowRank=Math.floor(.01*(PIXELS-1)),highRank=Math.ceil(.99*(PIXELS-1));
  const lowScalar=atRank(histogram,lowRank),highScalar=atRank(histogram,highRank);
  const invert=variant==='chroma-first-v1',data=new Uint8ClampedArray(PIXELS*4);
  for(let i=0;i<PIXELS;i++){
    const normalized=highScalar<=lowScalar?scalars[i]:Math.round(Math.max(0,Math.min(255,
      (scalars[i]-lowScalar)*255/(highScalar-lowScalar))));
    const value=invert?255-normalized:normalized,offset=i*4;
    data[offset]=data[offset+1]=data[offset+2]=value;data[offset+3]=255;
  }
  const recipe:NameLabelColorRecipe={variant,sourceBox:SOURCE_BOX,scalar:SCALARS[variant],
    algorithm:'histogram-percentile-stretch',sampleCount:2304,lowQuantile:.01,highQuantile:.99,
    rankConvention:'zero-based; floor(low*(N-1)), ceil(high*(N-1))',lowRank,highRank,lowScalar,highScalar,
    normalization:'round(clamp((scalar-lowScalar)*255/(highScalar-lowScalar),0,255))',
    inversion:invert?'255-normalized':'none',
    flatPolicy:'retain scalar when highScalar<=lowScalar; apply inversion afterward',
    boundary:'first 128x18 raster only; second line excluded from scalar and histogram',
    alpha:'require opaque initial 128x36 RGBA; output alpha 255',
    rounding:'integer input scalars; clamp before Math.round normalization; inversion after rounding'};
  return Object.freeze({width:128,height:18,data,recipe:Object.freeze(recipe)});
}
