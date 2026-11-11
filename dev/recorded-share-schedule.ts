/** Pure delivery schedule for re-executing a recorded screen share through the
 * live input path. No clock, canvas, video or timers: the caller injects now.
 *
 * A recorded frame carries the capture time (seconds since the original run's
 * input origin). Re-executing keeps those relative intervals. It never invents
 * frames, reorders them or compresses a gap unless the caller opts in, because
 * the point is to hand the live pipeline the same input at the same cadence. */

export interface RecordedShareFrameTime {readonly time:number}

export interface RecordedShareScheduleOptions {
  /** 1 = recorded cadence. Values above 1 compress time and are never an
   * equivalent live reproduction; the report must say so. */
  readonly speed?:number;
  /** Optional cap for idle gaps (seconds). null keeps every gap. */
  readonly maxGapSeconds?:number|null;
}

export interface RecordedShareSchedule {
  /** Milliseconds from the replay start at which this frame is due. */
  dueMs(frameTime:number):number;
  /** Delay to wait now; 0 when already due (a late frame is never dropped). */
  delayMs(frameTime:number,elapsedMs:number):number;
  /** How far behind the recorded schedule a delivery happened (>= 0). */
  lateMs(frameTime:number,elapsedMs:number):number;
}

export function createRecordedShareSchedule(options:RecordedShareScheduleOptions={}):RecordedShareSchedule {
  const speed=options.speed??1,cap=options.maxGapSeconds??null;
  if(!(speed>0)||!Number.isFinite(speed))throw RangeError('speed must be a positive finite number');
  if(cap!==null&&(!(cap>=0)||!Number.isFinite(cap)))throw RangeError('maxGapSeconds must be null or a finite number >= 0');
  let origin:number|null=null,previous=0,compressed=0;
  const virtual=(time:number):number=>{
    if(!Number.isFinite(time)||time<0)throw RangeError('frame time must be a finite number >= 0');
    if(origin===null){origin=time;previous=time;compressed=0;return 0;}
    if(time<previous)throw RangeError('frame times must not decrease');
    const gap=time-previous;previous=time;
    compressed+=cap===null?gap:Math.min(gap,cap);
    return compressed;
  };
  // Memoize per frame time so dueMs/delayMs/lateMs agree for the same frame.
  const seen=new Map<number,number>();
  const due=(time:number):number=>{
    const known=seen.get(time);if(known!==undefined)return known;
    const value=virtual(time)*1000/speed;seen.set(time,value);return value;
  };
  return {
    dueMs:due,
    delayMs:(time,elapsedMs)=>Math.max(0,due(time)-elapsedMs),
    lateMs:(time,elapsedMs)=>Math.max(0,elapsedMs-due(time)),
  };
}

/** Summary of how faithfully a replay followed its schedule. */
export interface RecordedShareDeliveryStats {
  readonly delivered:number;
  readonly lateOver33Ms:number;
  readonly maxLateMs:number;
  readonly meanLateMs:number;
}

export function summarizeDeliveryLateness(lateMs:readonly number[]):RecordedShareDeliveryStats {
  let max=0,sum=0,over=0;
  for(const value of lateMs){
    if(!Number.isFinite(value)||value<0)throw RangeError('lateness must be finite and >= 0');
    max=Math.max(max,value);sum+=value;if(value>33)over++;
  }
  return Object.freeze({delivered:lateMs.length,lateOver33Ms:over,maxLateMs:max,
    meanLateMs:lateMs.length?sum/lateMs.length:0});
}
