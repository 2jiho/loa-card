/** Optional source coordinates for comparing delivered inputs across runs.
 * These annotations never replace session captureTime or prove card freshness.
 * A MediaStream timestamp is not necessarily the original video's media time. */
export interface SourceFrameCorrelation {
  readonly mediaTime?:number;
  readonly presentedFrames?:number;
  readonly frameTimestampUs?:number;
}

/** Strict, small and detached: no frame handles, pixel data or arbitrary keys. */
export function parseSourceFrameCorrelation(input:unknown):SourceFrameCorrelation {
  if(!input||typeof input!=='object'||Array.isArray(input)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Invalid source frame correlation');
  const value=input as Record<string,unknown>,keys=Object.keys(value);
  if(!keys.length||keys.some(key=>!['mediaTime','presentedFrames','frameTimestampUs'].includes(key)))
    throw new TypeError('Invalid source frame correlation fields');
  if('mediaTime' in value&&(typeof value.mediaTime!=='number'||!Number.isFinite(value.mediaTime)||value.mediaTime<0))
    throw new TypeError('Invalid source media time');
  if('presentedFrames' in value&&(!Number.isSafeInteger(value.presentedFrames)||(value.presentedFrames as number)<0))
    throw new TypeError('Invalid source presented frame count');
  // WebCodecs timestamps are signed microseconds. Keep valid negative offsets,
  // but reject values beyond JavaScript's exact integer representation.
  if('frameTimestampUs' in value&&!Number.isSafeInteger(value.frameTimestampUs))
    throw new TypeError('Invalid source frame timestamp');
  return Object.freeze({
    ...('mediaTime' in value?{mediaTime:value.mediaTime as number}:{}),
    ...('presentedFrames' in value?{presentedFrames:value.presentedFrames as number}:{}),
    ...('frameTimestampUs' in value?{frameTimestampUs:value.frameTimestampUs as number}:{}),
  });
}

export function sameSourceFrameCorrelation(a:SourceFrameCorrelation|undefined,b:SourceFrameCorrelation|undefined):boolean {
  return a===b||!!a&&!!b&&a.mediaTime===b.mediaTime&&a.presentedFrames===b.presentedFrames&&a.frameTimestampUs===b.frameTimestampUs;
}

/** Relate callback coordinates only when a frozen/native frame's timestamp
 * corroborates that exact media instant, allowing one microsecond of rounding.
 * Call with immutable frame metadata, before any await or decoder advancement.
 * An unmatched captureStream callback retains only its native timestamp. */
export function correlateSourceFrame(frameTimestampUs:number,
  callback?:Readonly<{mediaTime:number;presentedFrames?:number}>):SourceFrameCorrelation {
  const native=parseSourceFrameCorrelation({frameTimestampUs});
  if(!callback)return native;
  const delivered=parseSourceFrameCorrelation({mediaTime:callback.mediaTime,
    ...(callback.presentedFrames===undefined?{}:{presentedFrames:callback.presentedFrames})});
  if(Math.abs(frameTimestampUs-delivered.mediaTime!*1_000_000)>1)return native;
  return parseSourceFrameCorrelation({...delivered,...native});
}
