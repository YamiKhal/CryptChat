/**
 * A running estimate of the relay's clock, kept as an offset from this device's.
 *
 * Transcripts are ordered by the server's timestamp, because two devices' wall
 * clocks disagree by seconds and a message stamped by its sender lands above one
 * that genuinely came first. The sender's own copy has no server timestamp until
 * the 'sent' ack arrives, though -- so it is stamped with this estimate and
 * corrected on the ack. Without the estimate the message renders at the local
 * clock's position and visibly jumps when the real stamp lands.
 *
 * Session-scoped and deliberately unpersisted: it describes the current
 * connection, and a stale offset is worse than no offset.
 */

let offsetMs: number | null = null;

/**
 * Fold a server timestamp into the estimate.
 *
 * The first observation seeds it -- including a negative one, which is what a
 * device running ahead of the relay produces and what starting from zero would
 * never learn. After that only larger offsets are taken: a stamp travels to us
 * over the network, so it is always at least a little older than the relay's
 * true clock, and the largest offset seen is the closest estimate. Averaging
 * would drag it backwards with every slow frame.
 */
export function observeServerTime(at: string | undefined): void {
    if (!at) return;
    const server = Date.parse(at);
    if (Number.isNaN(server)) return;
    const observed = server - Date.now();
    if (offsetMs === null || observed > offsetMs) offsetMs = observed;
}

/** Now, on the relay's clock as best we know it. */
export function serverNow(): string {
    return new Date(Date.now() + (offsetMs ?? 0)).toISOString();
}

/** Drop the estimate. Called when the socket closes; the next session re-learns it. */
export function resetServerClock(): void {
    offsetMs = null;
}
