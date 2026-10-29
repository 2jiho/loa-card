/** Small, local-only failure evidence. Never used as recognition or completion proof. */
export class FieldDiagnosticImages {
  private entries = new Map<string, {order: number; key: string; image: string}>();
  private bytes = 0;
  private maxImages: number;
  private maxBytes: number;
  constructor(maxImages = 12, maxBytes = 1024 * 1024) {
    this.maxImages = maxImages;
    this.maxBytes = maxBytes;
  }
  capture(id: string, order: number, key: string, encode: () => string) {
    const prior = this.entries.get(id);
    if (prior && prior.order > order) return;
    const image = prior?.key === key ? prior.image : encode();
    this.remove(id);
    if (image.length > this.maxBytes || this.maxImages < 1) return;
    this.entries.set(id, {order, key, image});
    this.bytes += image.length;
    while (this.entries.size > this.maxImages || this.bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
  }
  resolved(id: string, order: number) {
    const prior = this.entries.get(id);
    if (prior && prior.order <= order) this.remove(id);
  }
  get(id: string, order?: number) {
    const entry = this.entries.get(id);
    return entry?.order === order ? entry?.image : undefined;
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry) { this.bytes -= entry.image.length; this.entries.delete(id); }
  }
}
