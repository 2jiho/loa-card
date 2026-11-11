/** Small numeric pieces of the grid fit measurement (dev/grid-fit.ts). */

/** Offset of the top of a parabola through three equally spaced scores, from the middle one
 * (-0.5..0.5). Zero when a neighbour is missing or the middle is not a strict peak. */
export function parabolaPeak(before:number|null,middle:number,after:number|null):number {
  if(before===null||after===null)return 0;
  const curve=before-2*middle+after;
  if(!(curve<0))return 0;
  return Math.max(-.5,Math.min(.5,(before-after)/(2*curve)));
}

/** Least-squares line value = origin + step * index. With one distinct index the step is 0. */
export function fitLine(points:readonly {readonly index:number;readonly value:number}[]):{origin:number;step:number} {
  const count=points.length;
  if(!count)return {origin:0,step:0};
  const meanIndex=points.reduce((total,point)=>total+point.index,0)/count,meanValue=points.reduce((total,point)=>total+point.value,0)/count;
  let numerator=0,denominator=0;
  for(const point of points){numerator+=(point.index-meanIndex)*(point.value-meanValue);denominator+=(point.index-meanIndex)**2;}
  const step=denominator?numerator/denominator:0;
  return {origin:meanValue-step*meanIndex,step};
}

/** Mean and (population) standard deviation; zeros for no values. */
export function summarize(values:readonly number[]):{mean:number;sd:number} {
  if(!values.length)return {mean:0,sd:0};
  const mean=values.reduce((total,value)=>total+value,0)/values.length;
  return {mean,sd:Math.sqrt(values.reduce((total,value)=>total+(value-mean)**2,0)/values.length)};
}
