/** Maximum raw-session envelope; the replay receiver applies its own smaller
 * limit independently. The worker reads one bounded slice at a time. */
export const MAX_DEV_REPLAY_BYTES=544*1024*1024+12;
export const DEV_HASH_CHUNK_BYTES=1024*1024;
export const MAX_DEV_HASH_CHUNK_BYTES=4*1024*1024;
/** Per-session raw chunks are independently hashed in capture order. */
export const MAX_DEV_HASH_BLOBS=100_000;
export const MAX_DEV_HASH_LIST_BYTES=512*1024*1024;
