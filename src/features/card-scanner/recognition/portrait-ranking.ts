/** Full catalog evaluation, bounded output. Preserve first identity appearance
 * on ties and first reference on equal scores, just like stable descending sort. */
export function rankPortraitPair<T extends {card:{id:string};correlation:number}>(values:readonly T[]):T[] {
  const best=new Map<string,T>();
  for(const value of values) {
    const old=best.get(value.card.id);
    if(!old||value.correlation>old.correlation)best.set(value.card.id,value);
  }
  let first:T|undefined,second:T|undefined;
  for(const value of best.values()) {
    if(!first||value.correlation>first.correlation){second=first;first=value;}
    else if(!second||value.correlation>second.correlation)second=value;
  }
  return first?(second?[first,second]:[first]):[];
}
