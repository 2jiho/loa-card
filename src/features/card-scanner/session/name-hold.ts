/** Development prototype (docs/dev-recording.md, "이름 판독 실패와 빠진 카드의 원인").
 *
 * A name reading that ran the text reader and still named no card is slow (about a second) and,
 * while the picture does not change, gives the same answer again: a mouse cursor resting on a
 * card, or a worn card whose name is part of another card's name. Such a place is not read by
 * name again until the hold has passed. A place is a grid slot at one scroll position; scrolling
 * shows other cards there and is a different place.
 *
 * The hold only postpones work. It never supplies a card, and a reading that names a card, or
 * one refused before the text reader ran (cheap, and usually a passing blur), sets no hold. */
export function createNameHold(holdSeconds:number) {
  const until=new Map<string,number>();
  const key=(scrollRow:number|null,slot:number)=>`${scrollRow??'?'}:${slot}`;
  return {
    /** Whether this place is still held at this capture time. */
    held(scrollRow:number|null,slot:number,time:number):boolean {
      const end=until.get(key(scrollRow,slot));
      return end!==undefined&&time<end;
    },
    /** A text reading at this place named no card at this capture time. */
    refused(scrollRow:number|null,slot:number,time:number):void {
      if(holdSeconds>0)until.set(key(scrollRow,slot),time+holdSeconds);
    },
  };
}
