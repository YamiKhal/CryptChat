/**
 * A per-key serial queue for read-modify-write work.
 *
 * Every transcript mutation is load -> change -> save over IndexedDB, and each
 * step yields. Two of them running against the same channel (our own send and an
 * arriving message, which is the normal case in a fast exchange) both read the
 * transcript before either writes, so the second save writes back a list missing
 * the first one's message -- it disappears until the next reload.
 *
 * Keyed rather than global so a write to one channel never waits on another.
 */
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    // Chain onto whatever is queued for this key. `.catch` on the tail, not on the
    // returned promise: a rejection must not break the chain for later callers,
    // but it must still reach the caller that caused it.
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);

    const tail = result.catch(() => {});
    chains.set(key, tail);

    // Drop the entry once this is the last work queued, so the map does not grow
    // one permanent promise per channel ever touched.
    tail.then(() => {
        if (chains.get(key) === tail) chains.delete(key);
    });

    return result;
}
