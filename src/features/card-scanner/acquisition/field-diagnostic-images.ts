import type {InventorySource} from '../session/inventory-evidence';

/** Compare the complete observation identity, not only its capture order. */
export function sameDiagnosticSource(a:InventorySource|undefined,b:InventorySource|undefined):boolean {
  return !!a&&!!b&&a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&
    a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot&&a.frame===b.frame;
}

/** The optional preview encoder resolves to an empty string on timeout or
 * failure. Capture while the recognition canvas is still owned in that case.
 * A zero-size canvas returns `data:,`, which is not a usable image. */
export function previewOrCapture(preview:string|undefined,capture:()=>string):string {
  const imageData=(value:string|undefined):value is string=>typeof value==='string'&&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
  if(imageData(preview))return preview;
  const image=capture();
  return imageData(image)?image:'';
}

/** Small, local-only failure evidence. Never used as recognition or completion proof. */
export class FieldDiagnosticImages {
  private entries = new Map<string, {order: number; image: string; source?:InventorySource}>();
  private bytes = 0;
  private maxImages: number;
  private maxBytes: number;
  constructor(maxImages = 12, maxBytes = 1024 * 1024) {
    this.maxImages = maxImages;
    this.maxBytes = maxBytes;
  }
  capture(id: string, order: number, _key: string, encode: () => string, source?:InventorySource) {
    const prior = this.entries.get(id);
    if (prior && prior.order > order) return;
    let image='';
    // pixelKey identifies a cached acquisition crop, not the bytes produced by
    // this particular diagnostic/preview encoding. Re-read the still-owned
    // canvas instead of attaching an earlier job's possibly different image.
    try {image=encode();}
    catch { /* Keep the newer order as an image-less diagnostic. */ }
    if(typeof image!=='string'||image==='data:,')image='';
    this.remove(id);
    if (this.maxImages < 1) return;
    if (image.length > this.maxBytes) image='';
    this.entries.set(id, {order, image,...(source?{source:Object.freeze({...source})}:{})});
    this.bytes += image.length;
    while (this.entries.size > this.maxImages || this.bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
  }
  /** Only the currently selected failed observation may publish its pixels. */
  captureCurrent(id:string,order:number,key:string,encode:()=>string,
    source:InventorySource,current:InventorySource|undefined):boolean {
    if(source.captureOrder!==order||!sameDiagnosticSource(source,current))return false;
    this.capture(id,order,key,encode,source);
    return true;
  }
  resolved(id: string, order: number) {
    const prior = this.entries.get(id);
    if (prior && prior.order <= order) this.remove(id);
  }
  /** Source-bound callers must supply the exact current observation as well. */
  get(id: string, order: number | undefined, source?:InventorySource) {
    const entry = this.entries.get(id);
    if(!entry||entry.order!==order)return undefined;
    if((entry.source||source)&&!sameDiagnosticSource(entry.source,source))return undefined;
    return entry.image || undefined;
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry) { this.bytes -= entry.image.length; this.entries.delete(id); }
  }
}
