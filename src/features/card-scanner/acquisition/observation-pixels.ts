/** Deterministic area averaging: Canvas/GPU downscaling can differ from
 * OffscreenCanvas/CPU downscaling even when the source pixels are identical. */
function directSample(rgba:ArrayLike<number>,width:number,height:number,box:number[],cols:number,rows:number) {
 const [bx,by,bw,bh]=box, result=new Uint8Array(cols*rows*3);
 const sx=bw/cols,sy=bh/rows;
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
  const left=bx+x*sx,right=left+sx,top=by+y*sy,bottom=top+sy;
  let r=0,g=0,b=0;
  for(let py=Math.max(0,Math.floor(top));py<Math.min(height,Math.ceil(bottom));py++){
   const wy=Math.min(bottom,py+1)-Math.max(top,py);
   for(let px=Math.max(0,Math.floor(left));px<Math.min(width,Math.ceil(right));px++){
    const weight=wy*(Math.min(right,px+1)-Math.max(left,px)),i=(py*width+px)*4;
    r+=rgba[i]*weight;g+=rgba[i+1]*weight;b+=rgba[i+2]*weight;
   }
  }
  const i=(y*cols+x)*3,area=sx*sy;
  result[i]=Math.round(r/area);result[i+1]=Math.round(g/area);result[i+2]=Math.round(b/area);
 }
 return result;
}
type SamplePlan={starts:Int32Array;indices:Int32Array;weights:Float64Array;area:number};
const plans=new Map<string,SamplePlan>();
let cachedWeights=0;
const maxWeights=600_000;

/** Cache geometry, never image data. Preserve the original accumulation order
 * and double precision so duplicate/count-region decisions remain identical. */
function sample(rgba:ArrayLike<number>,width:number,height:number,box:number[],cols:number,rows:number) {
 if(width*height>262144)return directSample(rgba,width,height,box,cols,rows);
 const key=[width,height,...box,cols,rows].join('/');
 let plan=plans.get(key);
 if(plan){plans.delete(key);plans.set(key,plan);}
 else {
  const [bx,by,bw,bh]=box,sx=bw/cols,sy=bh/rows;
  const starts=new Int32Array(cols*rows+1),indices:number[]=[],weights:number[]=[];
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++) {
   starts[y*cols+x]=indices.length;
   const left=bx+x*sx,right=left+sx,top=by+y*sy,bottom=top+sy;
   for(let py=Math.max(0,Math.floor(top));py<Math.min(height,Math.ceil(bottom));py++) {
    const wy=Math.min(bottom,py+1)-Math.max(top,py);
    for(let px=Math.max(0,Math.floor(left));px<Math.min(width,Math.ceil(right));px++) {
     indices.push((py*width+px)*4);weights.push(wy*(Math.min(right,px+1)-Math.max(left,px)));
    }
   }
  }
  starts[cols*rows]=indices.length;
  plan={starts,indices:Int32Array.from(indices),weights:Float64Array.from(weights),area:sx*sy};
  if(indices.length<=maxWeights) {
   while(plans.size&&(plans.size>=32||cachedWeights+indices.length>maxWeights)) {
    const oldest=plans.keys().next().value!;cachedWeights-=plans.get(oldest)!.indices.length;plans.delete(oldest);
   }
   plans.set(key,plan);cachedWeights+=indices.length;
  }
 }
 const result=new Uint8Array(cols*rows*3);
 for(let pixel=0;pixel<cols*rows;pixel++) {
  let r=0,g=0,b=0;
  for(let j=plan.starts[pixel];j<plan.starts[pixel+1];j++) {
   const i=plan.indices[j],weight=plan.weights[j];r+=rgba[i]*weight;g+=rgba[i+1]*weight;b+=rgba[i+2]*weight;
  }
  const out=pixel*3;result[out]=Math.round(r/plan.area);result[out+1]=Math.round(g/plan.area);result[out+2]=Math.round(b/plan.area);
 }
 return result;
}
export function observationPixels(rgba:ArrayLike<number>,width:number,height:number) {
 if(width<1||height<1||rgba.length!==width*height*4)throw new Error('Invalid observation raster');
 const art=sample(rgba,width,height,[0,0,width,height],12,18);
 const feature=new Uint8Array(3240);
 for(const [x,y,w,h,offset,rows] of [[6,14,128,36,0,9],[56,141,82,31,864,12],[14,176,112,24,2016,6]])
  feature.set(sample(rgba,width,height,[x*width/140,y*height/210,w*width/140,h*height/210],32,rows),offset);
 feature.set(art,2592);return {art,feature};
}
