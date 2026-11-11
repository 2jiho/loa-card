type Identity = { id:string; review:readonly string[] };
export interface FieldRetry<T extends Identity = Identity> {
  needsIdentity?:boolean;
  fieldTarget?:{id:string;order:number};
  knownIdentity?:T;
}

/** A field retry may skip identity recognition only if this very crop already
 * has an accepted identity with no review and the requested ID agrees. */
export function retryNeedsIdentity(requestedUnknown:boolean,id:string|undefined,identity:Identity|undefined):boolean {
  return requestedUnknown||!id||!identity||identity.id!==id||identity.review.length>0;
}

/** A retry retains its exact crop. Reusing that crop's accepted identity must
 * never transfer an identity to another image, approximate group or card. */
export function fieldRetryIdentity<T extends Identity>(item:FieldRetry<T>):T|undefined {
  const identity=item.knownIdentity;
  return item.needsIdentity===false && identity && !identity.review.length &&
    item.fieldTarget?.id===identity.id ? identity : undefined;
}

/** Only this run's fully reliable observations enter confirmedOrders. Seed
 * inventories, names alone, and older confirmations cannot cancel a retry. */
export function obsoleteFieldRetry(item:FieldRetry,confirmedOrders:ReadonlyMap<string,number>):boolean {
  if(item.needsIdentity!==false || !item.fieldTarget || !Number.isFinite(item.fieldTarget.order))return false;
  const order=confirmedOrders.get(item.fieldTarget.id);
  return order!==undefined && Number.isFinite(order) && order>=item.fieldTarget.order;
}

/** Completion-time retirement additionally requires this retained crop's
 * unambiguous identity and a current-run name proof at least as new as it. */
export function coveredFieldRetry(item:FieldRetry,confirmedFields:ReadonlyMap<string,number>,
  confirmedNames:ReadonlyMap<string,number>):boolean {
  const identity=fieldRetryIdentity(item),target=item.fieldTarget;
  if(!identity||!target||!obsoleteFieldRetry(item,confirmedFields))return false;
  const nameOrder=confirmedNames.get(identity.id);
  return nameOrder!==undefined&&Number.isFinite(nameOrder)&&nameOrder>=target.order;
}

/** Preserve unknown/newer jobs in order and release every canceled raster once. */
export function pruneFieldRetries<T extends FieldRetry>(queue:T[],confirmedOrders:ReadonlyMap<string,number>,release:(item:T)=>void,
  eligible:(item:T)=>boolean=()=>true):number {
  let write=0,removed=0;
  for(const item of queue) {
    if(obsoleteFieldRetry(item,confirmedOrders)&&eligible(item)){release(item);removed++;}
    else queue[write++]=item;
  }
  queue.length=write;
  return removed;
}
