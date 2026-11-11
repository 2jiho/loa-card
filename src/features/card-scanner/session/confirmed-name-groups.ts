/** Current-run identity evidence. A late failed retry cannot undo a newer name read.
 * This retires unnamed warnings only; it never confirms awakening/count fields. */
export class ConfirmedNameGroups {
  private groups = new Map<number, { id: string; order: number } | null>();

  confirm(group: number, id: string, order: number, review: readonly string[]) {
    if (review.includes('이름 확인') || !Number.isFinite(order)) return;
    const previous = this.groups.get(group);
    if (previous === null) return;
    // A grouping collision is not evidence that either card has been resolved.
    if (previous && previous.id !== id) { this.groups.set(group, null); return; }
    this.groups.set(group, { id, order: Math.max(order, previous?.order ?? -Infinity) });
  }

  covers(group: number | undefined, order: number | undefined) {
    if (group === undefined || order === undefined || !Number.isFinite(order)) return false;
    const confirmed = this.groups.get(group);
    return !!confirmed && confirmed.order >= order;
  }
}
