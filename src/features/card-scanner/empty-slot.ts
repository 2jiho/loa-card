/** Reference sampled from the fixed unowned-card back, excluding the border.
 * A matching back is an empty slot, not a failed name reading. */
const reference = Float32Array.from(atob("HSAgIR0dICQdMSUbJR0dHR8fHxwkJCUlJSUlJicpKCcmJiYlJSUkIyUlJicnJicoKSsqKScnJicnJiUkJScmJigqKCgpLCsoKSkoJyYmJiQlJicoJycoKSowLyooKCgoKCcmJCUmJygoKCgpLi8wLSkoJygoJycjJycoKCgqKywwNDYvLCwqJygoKCYnKCgpKiwtMTI2NzIwLi4rKCgnJycoKiwuLTAwNjM0NDExLS4sKSgnKCgsLi4uLjQ1MzI0MS8vLi0rKCcoKy0vMi4xNDY2NjU0MDEyLi0pJyotLjEyNDI1Nzg4NzUxNTIwLiwoKy0vMjQ3NDc7NzU6NzM4NTEvLCkrLzAzNTg1OzY5NTg5NTg2MzAuKSouMTM2MTI5Mjw6MzcyNDc0Mi8pLC8xMzgxMTE0OjgzNDIzODYwLissMDIzMzAvNDI5NzQ0MTI0MzIvKyouNDw1NjY1Nzo4Nzg4Njk8MCwoJy0yNDs+PT08Ojs9PkBBOTEyLCcrLTExNTg7Ojk4OTs8OjwzMjAuKikrMjQzLDY2Ozg5Ojc1LTQzLywpKy4vMjMxLjU2Ojs2NS0wMjAuLioqLi4uLTAuMDQ5OjQwLjEvLi4tKSotLi8vLCwxMTQ0MTAtLi8uLi0oKiwuLS4vLS8qNTMsLy4vLy4uLisrLi0uLy8uLCstJysuLi4vLi4uKysuLi4vMDAxMzIyMzEvLy8uLi0sKy0uLi8vLzAxMDAxLy8uLi4tLSw="), c => c.charCodeAt(0));
function coarse(values: ArrayLike<number>) {
  const result=new Float32Array(140);
  for(let y=0;y<14;y++)for(let x=0;x<10;x++) {
    const i=y*40+x*2;
    result[y*10+x]=(values[i]+values[i+1]+values[i+20]+values[i+21])/4;
  }
  return result;
}
function model(values: Float32Array) {
  const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
  const centered=values.map(value=>value-mean);
  return {centered,square:centered.reduce((sum,value)=>sum+value*value,0)};
}
const nativeModel=model(reference), coarseModel=model(coarse(reference));
function fit(values:ArrayLike<number>,ref:ReturnType<typeof model>) {
  let total=0;for(let i=0;i<values.length;i++)total+=values[i];
  const mean=total/values.length;let dot=0,energy=0;
  for(let i=0;i<values.length;i++){const value=values[i]-mean;dot+=value*ref.centered[i];energy+=value*value;}
  if(energy<1)return null;
  return {gain:dot/ref.square,correlation:dot/Math.sqrt(ref.square*energy),
    residual:Math.sqrt(Math.max(0,energy-dot*dot/ref.square)/values.length)};
}
/** A bright cursor can corrupt a few samples while the fixed back is otherwise
 * intact. Only remove one small localized region, never the name band, then
 * require the remaining full motif to agree more strictly than a normal back.
 * Unrelated artwork, large overlays and distributed errors remain unknown. */
function matchesOutsideCursor(values:ArrayLike<number>,native:NonNullable<ReturnType<typeof fit>>) {
  let mean=0;for(let i=0;i<values.length;i++)mean+=values[i];mean/=values.length;
  const excluded=new Set<number>();let left=20,right=-1,top=28,bottom=-1,brightest=0;
  for(let i=0;i<values.length;i++) {
    const error=values[i]-mean-native.gain*nativeModel.centered[i];
    if(!Number.isFinite(error))return false;
    if(Math.abs(error)<=10)continue;
    const x=i%20,y=Math.floor(i/20);
    // The first seven rows retain both lines of the fixed card-name area.
    if(y<7)return false;
    excluded.add(i);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    brightest=Math.max(brightest,error);
    if(excluded.size>12||right-left>=4||bottom-top>=5)return false;
  }
  if(!excluded.size||brightest<25)return false;
  const remaining=new Float32Array(values.length-excluded.size),expected=new Float32Array(remaining.length);
  for(let i=0,at=0;i<values.length;i++)if(!excluded.has(i)) {
    remaining[at]=values[i];expected[at++]=reference[i];
  }
  const matched=fit(remaining,model(expected));
  return !!matched&&matched.gain>=.6&&matched.gain<=1.5&&matched.correlation>=.97&&matched.residual<=1.5;
}
export function isEmptySlotVector(values: ArrayLike<number>) {
  if(values.length!==reference.length)return false;
  const native=fit(values,nativeModel);
  if(!native||native.gain<.6||native.gain>1.5)return false;
  if(native.correlation>=.94&&native.residual<=2)return true;
  // Video block noise disturbs fine pixels in the dark card back. Compare the
  // same fixed motif at a second scale, retaining a native-detail error cap so
  // averaging cannot erase an unrelated picture into an apparent empty slot.
  if(native.correlation>=.9&&native.residual<=3) {
    const smooth=fit(coarse(values),coarseModel);
    if(smooth&&smooth.correlation>=.96&&smooth.gain>=.6&&smooth.gain<=1.5&&smooth.residual<=1.75)return true;
  }
  return matchesOutsideCursor(values,native);
}

export function emptySlotVector(rgba: ArrayLike<number>, width: number, height: number) {
  if (width < 28 || height < 40 || rgba.length !== width * height * 4) return new Float32Array();
  const values = new Float32Array(20 * 28);
  for (let y = 0; y < 28; y++) {
    const top = Math.round(height * (6 + 198 * y / 28) / 210);
    const bottom = Math.round(height * (6 + 198 * (y + 1) / 28) / 210);
    for (let x = 0; x < 20; x++) {
      const left = Math.round(width * (6 + 128 * x / 20) / 140);
      const right = Math.round(width * (6 + 128 * (x + 1) / 20) / 140);
      let total = 0, count = 0;
      for (let yy = top; yy < bottom; yy++) for (let xx = left; xx < right; xx++) {
        const p = (yy * width + xx) * 4;
        total += .299 * rgba[p] + .587 * rgba[p + 1] + .114 * rgba[p + 2]; count++;
      }
      values[y * 20 + x] = count ? total / count : 0;
    }
  }
  return values;
}
