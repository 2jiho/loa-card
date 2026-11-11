/** Development-only transport planning. It does not inspect pixels, decide
 * quality, release resources, materialize canvases or run the scanner. */
type Raster={readonly width:number;readonly height:number};
type Quality={readonly usable:boolean;readonly reason:string};
export type RasterPlanInput<T extends Raster,M>={readonly slot:number;readonly quality:Quality;readonly raster:T;readonly metadata:M};
export type RasterPlanItem<T extends Raster,M>=
 | {readonly kind:'transfer';readonly slot:number;readonly quality:Quality;readonly raster:T;readonly metadata:M}
 | {readonly kind:'omitted-rejected';readonly slot:number;readonly quality:Quality;readonly width:number;readonly height:number;readonly metadata:M};

/** Plan one acquisition response, not a scan session. Keep every usable crop
 * and the first rejected crop for each exact reason in each frame. All source
 * rasters remain caller-owned, including omissions, until the caller commits
 * a real transport and explicitly closes or transfers each one. `preserveAll`
 * must be true whenever the consumer needs rejected pixels or recording
 * semantics are not established. Metadata is passed by reference, not copied. */
export function planRejectedRasterTransport<T extends Raster,M>(cells:readonly RasterPlanInput<T,M>[],options:{preserveAll:boolean}):readonly RasterPlanItem<T,M>[] {
 if(!Array.isArray(cells)||cells.length>40||!options||typeof options.preserveAll!=='boolean')throw Error('Invalid rejected-raster plan');
 const slots=new Set<number>(),rasters=new Set<object>();
 // Validate the entire batch first: an exception cannot silently dispose a
 // prefix or transfer anything to an alternative owner.
 for(const cell of cells){
  if(!cell||!Number.isSafeInteger(cell.slot)||cell.slot<0||cell.slot>=40||slots.has(cell.slot)||
    !cell.quality||typeof cell.quality.usable!=='boolean'||typeof cell.quality.reason!=='string'||
    !cell.quality.reason.length||cell.quality.reason.length>2000||
    !cell.raster||typeof cell.raster!=='object'||rasters.has(cell.raster)||
    !Number.isSafeInteger(cell.raster.width)||cell.raster.width<1||!Number.isSafeInteger(cell.raster.height)||cell.raster.height<1)
   throw Error('Invalid rejected-raster cell or ownership');
  slots.add(cell.slot);rasters.add(cell.raster);
 }
 const seen=new Set<string>();
 return cells.map(cell=>{
  const alreadySeen=!cell.quality.usable&&seen.has(cell.quality.reason);
  if(!cell.quality.usable)seen.add(cell.quality.reason);
  if(!options.preserveAll&&alreadySeen)return Object.freeze({kind:'omitted-rejected' as const,slot:cell.slot,
    quality:cell.quality,width:cell.raster.width,height:cell.raster.height,metadata:cell.metadata});
  return Object.freeze({kind:'transfer' as const,slot:cell.slot,quality:cell.quality,raster:cell.raster,metadata:cell.metadata});
 });
}
