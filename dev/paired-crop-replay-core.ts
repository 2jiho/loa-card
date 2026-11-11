/** Narrow local proof input: selected retained recognition crops, not frames. */
export interface RetainedCrop {
  readId:number;processingFrame:number;slot:number;captureTime:number;captureOrder:number;
  sessionId:string;sourceFrame:number;observationId:string;phase:'input'|'recovery';
  stage:'visual'|'short'|'full';stable:boolean;borderAlignment:number;
  width:number;height:number;png:Uint8Array;pngSha256:string;rgbaSha256:string;
  shared:boolean;sourceBox:{x:number;y:number;width:number;height:number};
}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=160;
const sourceKeys=['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot'] as const;
const same=(a:Record<string,any>,b:Record<string,any>,keys:readonly string[])=>keys.every(key=>a[key]===b[key]);
export async function cropDigest(bytes:Uint8Array|Uint8ClampedArray):Promise<string>{
  const copy=Uint8Array.from(bytes),result=await crypto.subtle.digest('SHA-256',copy);
  return [...new Uint8Array(result)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
/** Missing crops remain omissions; inconsistent or forged references fail.
 * Producer metadata preserves selection, not physical-source authentication. */
export async function readPairedCropArchive(value:unknown):Promise<{crops:RetainedCrop[];omitted:number;producerComplete:boolean;scope:string}>{
  if(!object(value))throw Error('Invalid crop archive');
  const evidence=object(value.pairedCropEvidence)?value.pairedCropEvidence:value;
  if(evidence.version!==1||!Array.isArray(evidence.rows)||evidence.rows.length>32||
    !Array.isArray(evidence.images)||evidence.images.length>8||typeof evidence.complete!=='boolean')throw Error('Invalid paired crop evidence');
  const images=new Map<string,Record<string,any>>();
  for(const image of evidence.images){
    if(!object(image)||!text(image.id)||images.has(image.id))throw Error('Invalid crop image identity');
    images.set(image.id,image);
  }
  const crops:RetainedCrop[]=[],seen=new Set<number>();let omitted=0,lastRead=0;
  for(const row of evidence.rows){
    if(!object(row)||!object(row.meta)||!natural(row.diagnosticReadId)||row.diagnosticReadId<1||
      seen.has(row.diagnosticReadId)||row.diagnosticReadId<=lastRead||row.meta.diagnosticReadId!==row.diagnosticReadId)throw Error('Invalid diagnostic read identity');
    seen.add(row.diagnosticReadId);
    lastRead=row.diagnosticReadId;
    if(!object(row.card)||row.card.imageId===null||row.card.omitted!==null){omitted++;continue;}
    const meta=row.meta,source=meta.source,image=images.get(row.card.imageId);
    if(!object(source)||!text(source.sessionId)||!text(source.observationId)||!natural(source.frameId)||
      !natural(source.captureOrder)||typeof source.captureTime!=='number'||!Number.isFinite(source.captureTime)||source.captureTime<0||
      !['input','recovery'].includes(source.phase)||!natural(meta.processingFrame)||meta.processingFrame<1||
      !natural(meta.slot)||meta.slot>=40||source.slot!==meta.slot||!['visual','short','full'].includes(meta.stage)||
      typeof meta.stable!=='boolean'||typeof meta.borderAlignment!=='number'||!Number.isFinite(meta.borderAlignment)||meta.borderAlignment<0||meta.borderAlignment>1||
      !object(meta.sourceBox)||!['x','y','width','height'].every(k=>typeof meta.sourceBox[k]==='number'&&Number.isFinite(meta.sourceBox[k]))||
      !natural(meta.sourceWidth)||!natural(meta.sourceHeight)||meta.sourceWidth<1||meta.sourceHeight<1||
      meta.sourceBox.x<0||meta.sourceBox.y<0||meta.sourceBox.width<=0||meta.sourceBox.height<=0||
      meta.sourceBox.x+meta.sourceBox.width>meta.sourceWidth||meta.sourceBox.y+meta.sourceBox.height>meta.sourceHeight||
      !natural(meta.cropWidth)||meta.cropWidth<1||!natural(meta.cropHeight)||meta.cropHeight<1||
      meta.cropWidth*meta.cropHeight>1_000_000||!object(image)||image.region!=='recognition-card'||image.status!=='encoded'||
      row.card.exactRegion!==true||typeof row.card.shared!=='boolean'||!object(image.observation)||!object(image.observation.source)||
      !same(source,image.observation.source,sourceKeys)||typeof meta.pixelKey!=='string'||!meta.pixelKey.length||
      meta.pixelKey.length>4096||image.observation.pixelKey!==meta.pixelKey||!object(image.geometry)||!object(image.geometry.sourceBox)||
      !same(meta.sourceBox,image.geometry.sourceBox,['x','y','width','height'])||
      image.width!==meta.cropWidth||image.height!==meta.cropHeight||!hash(image.pngSha256)||!hash(image.rgbaSha256)||
      image.rgbaMatchesRaster!==true||image.rasterRgbaSha256!==image.rgbaSha256)throw Error('Crop provenance or pixels are inconsistent');
    const match=typeof image.image==='string'&&/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image);
    if(!match||match[1].length>2*1024*1024)throw Error('Invalid PNG data');
    let binary:string;try{binary=atob(match[1]);}catch{throw Error('Invalid PNG encoding');}
    if(btoa(binary)!==match[1])throw Error('Noncanonical PNG encoding');
    const png=Uint8Array.from(binary,c=>c.charCodeAt(0));
    if(png.length!==image.pngBytes||png.length<8||![137,80,78,71,13,10,26,10].every((n,i)=>png[i]===n)||
      await cropDigest(png)!==image.pngSha256)throw Error('PNG hash mismatch');
    crops.push({readId:row.diagnosticReadId,processingFrame:meta.processingFrame,slot:meta.slot,captureTime:source.captureTime,
      captureOrder:source.captureOrder,sessionId:source.sessionId,sourceFrame:source.frameId,observationId:source.observationId,
      phase:source.phase,stage:meta.stage,stable:meta.stable,borderAlignment:meta.borderAlignment,
      width:image.width,height:image.height,png,pngSha256:image.pngSha256,rgbaSha256:image.rgbaSha256,
      shared:row.card.shared,sourceBox:{x:meta.sourceBox.x,y:meta.sourceBox.y,width:meta.sourceBox.width,height:meta.sourceBox.height}});
  }
  return {crops,omitted,producerComplete:evidence.complete,
    scope:'Selected retained crops only; row order is diagnostic invocation order, not independent frames, acquisition, physical truth, original timing, or scan completion.'};
}
