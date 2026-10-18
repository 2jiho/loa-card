/** Conservative tooltip panel evidence: a long neutral rule and a flat dark
 * panel immediately below it, inside the portrait rather than the card border.
 * Textured covers/cursors without this evidence remain unresolved, never zero. */
export function hasPanelOverlay(rgba:ArrayLike<number>,width:number,height:number){
  if(width<70||height<105||rgba.length!==width*height*4)return false;
  const left=Math.ceil(width*.08),right=Math.floor(width*.92),length=right-left;
  const rgb=(x:number,y:number)=>{const i=(y*width+x)*4;return [rgba[i],rgba[i+1],rgba[i+2]];};
  for(let y=Math.ceil(height*.25);y<height*.64;y++){
    const base=rgb(left,y);if(Math.max(...base)-Math.min(...base)>25||base[0]<65||base[0]>200)continue;
    let rule=0,flat=0;
    const below=Math.min(height-1,y+Math.max(3,Math.round(height*.025)));
    const dark=rgb(left,below);if(Math.max(...dark)>65)continue;
    for(let x=left;x<right;x++){
      const p=rgb(x,y),q=rgb(x,below);
      if(p.every((v,c)=>Math.abs(v-base[c])<=7))rule++;
      if(q.every((v,c)=>Math.abs(v-dark[c])<=5))flat++;
    }
    if(rule/length>.94&&flat/length>.94)return true;
  }
  return false;
}
