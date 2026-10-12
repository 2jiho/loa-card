/** Identity-only work must not be requeued by animation in an occluded counter
 * or tooltip. Preserve the full name band and visible upper portrait; never use
 * this projection for a count/jewel observation or a complete-card group. */
export function identityObservation(feature:Uint8Array) {
  if(feature.length!==3240)throw Error('Invalid identity observation');
  const result=feature.slice();
  result.fill(0,864,2592);
  result.fill(0,2592+8*12*3);
  return result;
}
