/** Fixed-grid artwork reconstruction. The game places cards at a stable
 * 10x4 grid; identity comes from the card-art features, never from OCR text.
 *  This module only orchestrates geometry, feature extraction and matching.
 *  A match is one scanned observation, not independent truth or completion. */
export interface GridCardSlot {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface GridCardIdentity {
  readonly id: string;
  readonly name: string;
  readonly correlation: number;
  readonly margin: number;
}
export interface GridReconstruction {
  readonly slot: GridCardSlot;
  readonly identity: GridCardIdentity | null;
  readonly grayAvailable: boolean;
}
export interface FixedGridOptions {
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  pitchX: number;
  pitchY: number;
  width: number;
  height: number;
}
const positiveInteger=(value:number)=>Number.isSafeInteger(value)&&value>0;
const finite=(value:number)=>Number.isFinite(value)&&value>=0;
/** Slots are row-major, matching the game's 10x4 grid and the reader's crop
 *  calibration. Rounding is explicit so a fractional pitch stays stable. */
export function fixedGridSlots(options:FixedGridOptions):GridCardSlot[] {
  const {originX,originY,columns,rows,pitchX,pitchY,width,height}=options;
  if(!positiveInteger(columns)||!positiveInteger(rows)||!positiveInteger(width)||!positiveInteger(height)||
    !finite(originX)||!finite(originY)||!Number.isFinite(pitchX)||pitchX<=0||!Number.isFinite(pitchY)||pitchY<=0)
    throw new RangeError('Invalid fixed grid layout');
  const slots:GridCardSlot[]=[];
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
    slots.push(Object.freeze({slot:row*columns+column,x:Math.round(originX+column*pitchX),
      y:Math.round(originY+row*pitchY),width,height}));
  }
  return slots;
}
/** Run the same bounded artwork matcher for every fixed slot. Missing or
 *  malformed gray input stays explicitly unavailable instead of becoming a
 *  guessed identity or a zero-card result. */
export function reconstructGridArtwork(input:{
  slots:readonly GridCardSlot[];
  grayFor:(slot:GridCardSlot)=>ArrayLike<number>|null|undefined;
  match:(gray:ArrayLike<number>,slot:GridCardSlot)=>GridCardIdentity|null;
}):GridReconstruction[] {
  return input.slots.map(slot=>{
    const gray=input.grayFor(slot);
    if(!gray||gray.length!==768)return Object.freeze({slot,identity:null,grayAvailable:false});
    return Object.freeze({slot,identity:input.match(gray,slot),grayAvailable:true});
  });
}
