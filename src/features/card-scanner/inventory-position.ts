import {estimateScrollRows} from './scroll-card-location';
type Pending={groups:(number|undefined)[];step:number|undefined};
/** Position registration is separate from card recognition. Reconcile pending
 * views when their card names become known; never fill gaps by card count. */
export class InventoryPosition {
 private slots=new Map<number,number>();
 private identities=new Map<number,string>();
 private identitySlots=new Map<string,number>();
 private orderedSlots=new Map<string,number>();
 private pending=new Map<number,Pending>();
 private anchors=new Map<number,number>();
 private trustedGroups=new Set<number>();
 private trustedIds=new Set<string>();
 private sequence=0;
 diagnostics(){return {slots:this.slots.size,identities:this.identities.size,pending:this.pending.size,examples:[...this.pending].slice(0,3).map(([frame,p])=>({frame,step:p.step,matches:p.groups.flatMap((g,i)=>{if(g===undefined)return [];const id=this.identities.get(g),old=(id===undefined?undefined:this.identitySlots.get(id))??this.slots.get(g);return old===undefined?[]:[{i,old,top:Math.floor(old/10)-Math.floor(i/10)}];})}))};}
 resetPositions(){this.slots.clear();this.identitySlots.clear();this.orderedSlots.clear();this.pending.clear();this.anchors.clear();this.trustedGroups.clear();this.trustedIds.clear();}
 reset(){this.identities.clear();this.resetPositions();}
 /** Immediate viewport hint only; never registers observations or trains anchors. */
 estimateTop(geometry:{position:number;pageSpan:number}|null):number|undefined {
   if(!geometry||estimateScrollRows(geometry)!==55||!Number.isFinite(geometry.position)||geometry.position<0||geometry.position>1)return;
   const offsets=[...this.anchors].map(([row,raw])=>raw-row).sort((a,b)=>a-b);
   const offset=offsets.length>=2&&offsets.at(-1)!-offsets[0]<=.2?offsets[Math.floor(offsets.length/2)]:0;
   return Math.max(0,Math.min(51,Math.round(geometry.position*51-offset)))+1;
 }
 /** A complete name-sorted inventory can reconnect disjoint views, but only
  * after its order agrees with at least two rows of independently placed cards.
  * Each pending view still needs six same-column witnesses; count alone never
  * paints a slot. Do not call with an incomplete inventory or an unknown sort. */
 order(ids:string[]) {
   if(this.orderedSlots.size||ids.length>550||new Set(ids).size!==ids.length)return [];
   const candidate=new Map(ids.map((id,index)=>[id,index]));
   const witnesses=[...this.identitySlots].filter(([id])=>this.trustedIds.has(id));
   if(witnesses.length<20||new Set(witnesses.map(([,slot])=>Math.floor(slot/10))).size<2||
      witnesses.some(([id,slot])=>candidate.get(id)!==slot))return [];
   this.orderedSlots=candidate;
   return this.reconcile();
 }
 /** Return the inferred final order only if every positioned identity agrees.
  * This is an order reconstruction, not evidence that every frame was captured. */
 verifiedOrder() {
   if(!this.orderedSlots.size||[...this.identitySlots].some(([id,slot])=>this.orderedSlots.get(id)!==slot))return [];
   return [...this.orderedSlots.keys()];
 }
 /** Independent absolute anchors; scrollbar-only predictions are excluded. */
 verifiedPositions() {
   return [...this.identitySlots].filter(([id])=>this.trustedIds.has(id)).map(([id,slot])=>({id,slot}));
 }
 offer(groups:(number|undefined)[],geometry:{position:number;pageSpan:number}|null,frame=++this.sequence):number|undefined {
   return this.capture(frame,groups,geometry).find(value=>value.frame===frame)?.top;
 }
 capture(frame:number,groups:(number|undefined)[],geometry:{position:number;pageSpan:number}|null) {
   if(groups.length!==40)return [];
   if(geometry&&(!Number.isFinite(geometry.position)||geometry.position<0||geometry.position>1||
     !Number.isFinite(geometry.pageSpan)||geometry.pageSpan<=0||Math.abs(4/geometry.pageSpan-51)>3))return [];
   // A cursor can hide the thumb. Keep the observation so independently placed
   // cards can locate it now or after late name recognition. Never reuse a stale
   // scrollbar position, and never calibrate the thumb from these frames.
   const step=geometry&&estimateScrollRows(geometry)===55?geometry.position*51:undefined;
   this.pending.set(frame,{groups:[...groups],step});
   while(this.pending.size>256)this.pending.delete(this.pending.keys().next().value!);
   return this.reconcile();
 }
 identify(group:number,id:string) {
   this.identities.set(group,id);
   const slot=this.slots.get(group);if(slot!==undefined)this.identitySlots.set(id,slot);
   if(this.trustedGroups.has(group))this.trustedIds.add(id);
   while(this.identities.size>4096)this.identities.delete(this.identities.keys().next().value!);
   return this.reconcile();
 }
 private reconcile() {
   const resolved:{frame:number;top:number}[]=[];
   let changed=true;
   while(changed) {
     changed=false;
     for(const [frame,{groups,step}] of this.pending) {
       const votes=new Map<number,Set<number>>(),trustedVotes=new Map<number,Set<number>>();
       const endpoint=step!==undefined?(step<=.12?0:step>=50.88?51:undefined):undefined;
       let endpointConflict=false;
       let known=0;
       for(let i=0;i<40;i++) {
         const group=groups[i];if(group===undefined)continue;
         const id=this.identities.get(group),old=(id===undefined?undefined:this.identitySlots.get(id))??this.slots.get(group)??(id===undefined?undefined:this.orderedSlots.get(id));
         if(old===undefined)continue;
         known++;
         // A thumb can reach its endpoint before the cards finish moving.
         // Even a partial known row must not be moved to fit the thumb.
         if(endpoint!==undefined&&old!==endpoint*10+i)endpointConflict=true;
         if(old%10!==i%10)continue;
         const top=Math.floor(old/10)-Math.floor(i/10);
         if(top<0||top>51||step!==undefined&&Math.abs(top-step)>2)continue;
         const cols=votes.get(top)??new Set<number>();cols.add(i%10);votes.set(top,cols);
         if(this.trustedGroups.has(group)||id!==undefined&&this.trustedIds.has(id)){const trusted=trustedVotes.get(top)??new Set<number>();trusted.add(i%10);trustedVotes.set(top,trusted);}
       }
       const ranked=[...votes].sort((a,b)=>b[1].size-a[1].size);
       const match=ranked[0]?.[1].size>=6&&(ranked[1]?.[1].size??0)<=2?ranked[0][0]:undefined;
       if(endpointConflict)continue;
       const offsets=[...this.anchors].map(([row,raw])=>raw-row).sort((a,b)=>a-b);
       const offset=offsets[Math.floor(offsets.length/2)]??0,predicted=step===undefined?NaN:Math.round(step-offset);
       const calibrated=step!==undefined&&known===0&&offsets.length>=2&&offsets.at(-1)!-offsets[0]<=.2&&Math.abs(step-offset-predicted)<=.15&&new Set(groups.filter(g=>g!==undefined)).size>=8&&predicted>=0&&predicted<=51?predicted:undefined;
       const top=match??endpoint??calibrated;
       if(top===undefined||match!==undefined&&endpoint!==undefined&&match!==endpoint)continue;
       const trusted=endpoint!==undefined||(trustedVotes.get(top)?.size??0)>=6;
       if(trusted&&step!==undefined)this.anchors.set(top,step);
       for(let i=0;i<40;i++) {
         const group=groups[i];if(group===undefined)continue;
         this.slots.set(group,top*10+i);
         const id=this.identities.get(group);if(id!==undefined)this.identitySlots.set(id,top*10+i);
         if(trusted){this.trustedGroups.add(group);if(id!==undefined)this.trustedIds.add(id);}
       }
       this.pending.delete(frame);resolved.push({frame,top:top+1});changed=true;
     }
   }
   while(this.slots.size>4096){const key=this.slots.keys().next().value!;this.slots.delete(key);this.trustedGroups.delete(key);}
   while(this.identitySlots.size>550){const key=this.identitySlots.keys().next().value!;this.identitySlots.delete(key);this.trustedIds.delete(key);}
   return resolved;
 }
}
