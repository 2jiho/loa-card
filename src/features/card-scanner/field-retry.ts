type Identity = { id:string; review:readonly string[] };
export interface FieldRetry<T extends Identity = Identity> {
  needsIdentity?:boolean;
  fieldTarget?:{id:string;order:number};
  knownIdentity?:T;
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

/** Preserve unknown/newer jobs in order and release every canceled raster once. */
export function pruneFieldRetries<T extends FieldRetry>(queue:T[],confirmedOrders:ReadonlyMap<string,number>,release:(item:T)=>void):number {
  let write=0,removed=0;
  for(const item of queue) {
    if(obsoleteFieldRetry(item,confirmedOrders)){release(item);removed++;}
    else queue[write++]=item;
  }
  queue.length=write;
  return removed;
}
