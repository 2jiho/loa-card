/** Decides whether a frame adds anything over the last frame that was processed.
 *
 * A frame is compared with a luma thumbnail (256x144) of the LAST PROCESSED frame, not of
 * the previous one, so slow changes cannot add up unseen. It may be skipped only when both
 * measures are small:
 *   - mean: the mean absolute luma difference over the whole thumbnail, and
 *   - maxBlock: the largest mean absolute difference over any 16x16 block (a 16x9 grid), so
 *     a change confined to one place (a row of cards entering, a digit changing) is not
 *     averaged away by an otherwise still screen.
 * Every `forceEvery`-th frame in a row is processed regardless, which bounds how long a
 * change that both measures miss could stay unseen.
 *
 * Pure: no canvas, no clock. docs/dev-recording.md has the measurements behind the numbers. */
export const THUMBNAIL_WIDTH=256,THUMBNAIL_HEIGHT=144,BLOCK_SIZE=16;

export interface FrameSkipPolicy {
  /** Skip only when the whole-thumbnail mean difference is at most this (0..255). */
  readonly mean:number;
  /** ...and the largest block mean difference is at most this (0..255). */
  readonly block:number;
  /** Process the frame after this many consecutive skips (>= 1). */
  readonly forceEvery:number;
}
export interface FrameChange {readonly mean:number;readonly maxBlock:number}
export interface SkipDecision extends FrameChange {readonly skip:boolean;readonly reason:'first'|'changed'|'forced'|'similar'}

/** Luma thumbnail from RGBA pixels of exactly THUMBNAIL_WIDTH x THUMBNAIL_HEIGHT. */
export function lumaThumbnail(rgba:ArrayLike<number>):Uint8Array {
  const count=THUMBNAIL_WIDTH*THUMBNAIL_HEIGHT;
  if(rgba.length!==count*4)throw RangeError(`thumbnail source must be ${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT} RGBA`);
  const luma=new Uint8Array(count);
  for(let i=0;i<count;i++)luma[i]=(rgba[i*4]*299+rgba[i*4+1]*587+rgba[i*4+2]*114)/1000;
  return luma;
}

/** Mean and largest-block mean absolute difference of two thumbnails. */
export function frameChange(a:Uint8Array,b:Uint8Array):FrameChange {
  const count=THUMBNAIL_WIDTH*THUMBNAIL_HEIGHT;
  if(a.length!==count||b.length!==count)throw RangeError('thumbnails must be 256x144');
  let total=0,maxBlock=0;
  const blocksX=THUMBNAIL_WIDTH/BLOCK_SIZE,blocksY=THUMBNAIL_HEIGHT/BLOCK_SIZE;
  for(let by=0;by<blocksY;by++)for(let bx=0;bx<blocksX;bx++){
    let sum=0;
    for(let y=0;y<BLOCK_SIZE;y++){
      const row=(by*BLOCK_SIZE+y)*THUMBNAIL_WIDTH+bx*BLOCK_SIZE;
      for(let x=0;x<BLOCK_SIZE;x++)sum+=Math.abs(a[row+x]-b[row+x]);
    }
    total+=sum;
    const mean=sum/(BLOCK_SIZE*BLOCK_SIZE);
    if(mean>maxBlock)maxBlock=mean;
  }
  return {mean:total/count,maxBlock};
}

export function validatePolicy(policy:FrameSkipPolicy):FrameSkipPolicy {
  // Infinity is allowed: it switches that measure off. NaN and negatives are not.
  const valid=(value:number)=>value>=0;
  if(!valid(policy.mean)||!valid(policy.block))throw RangeError('mean and block must be numbers >= 0');
  if(!Number.isInteger(policy.forceEvery)||policy.forceEvery<1)throw RangeError('forceEvery must be an integer >= 1');
  return policy;
}

export function createFrameSkipper(policy:FrameSkipPolicy) {
  validatePolicy(policy);
  let reference:Uint8Array|undefined,skippedInARow=0;
  return {
    /** Decide for the next frame. A processed frame becomes the new reference. */
    decide(thumbnail:Uint8Array):SkipDecision {
      if(!reference){reference=thumbnail;skippedInARow=0;return {skip:false,reason:'first',mean:Infinity,maxBlock:Infinity};}
      const change=frameChange(thumbnail,reference);
      if(change.mean>policy.mean||change.maxBlock>policy.block){reference=thumbnail;skippedInARow=0;return {skip:false,reason:'changed',...change};}
      if(skippedInARow>=policy.forceEvery){reference=thumbnail;skippedInARow=0;return {skip:false,reason:'forced',...change};}
      skippedInARow++;
      return {skip:true,reason:'similar',...change};
    },
    /** Forget the reference, e.g. when the source changes. */
    reset(){reference=undefined;skippedInARow=0;},
  };
}

/** Parse "mean=1,block=6,force=8" (a replay-mode suffix) into a policy. */
export function parsePolicy(text:string):FrameSkipPolicy {
  const values:Record<string,number>={};
  for(const part of text.split(',').map(item=>item.trim()).filter(Boolean)){
    const [key,raw]=part.split('=');
    if(!['mean','block','force'].includes(key)||raw===undefined||raw.trim()===''||!Number.isFinite(Number(raw)))throw TypeError(`invalid skip setting: ${part}`);
    values[key]=Number(raw);
  }
  return validatePolicy({mean:values.mean??0.5,block:values.block??Infinity,forceEvery:values.force??Number.MAX_SAFE_INTEGER});
}
