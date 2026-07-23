// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    observeServerTime,
    serverNow,
    resetServerClock,
} from "@/lib/relay/clock";

/**
 * The relay clock estimate.
 *
 * Our own messages are ordered on the relay's clock like everyone else's, but
 * they have no relay stamp until the ack lands. This is the stand-in, and the
 * whole point is that it moves in both directions -- a device ahead of the relay
 * is as common as one behind.
 */

const LOCAL = Date.parse("2026-01-02T00:00:00.000Z");

describe("relay clock estimate", () => {
    beforeEach(() => {
        resetServerClock();
        vi.useFakeTimers();
        vi.setSystemTime(LOCAL);
    });
    afterEach(() => vi.useRealTimers());

    it("is the local clock before anything has been observed", () => {
        expect(serverNow()).toBe("2026-01-02T00:00:00.000Z");
    });

    it("learns a relay that is ahead of us", () => {
        observeServerTime("2026-01-02T00:00:05.000Z");
        expect(serverNow()).toBe("2026-01-02T00:00:05.000Z");
    });

    it("learns a relay that is behind us", () => {
        observeServerTime("2026-01-01T23:59:55.000Z");
        expect(serverNow()).toBe("2026-01-01T23:59:55.000Z");
    });

    it("keeps the closest estimate rather than the latest", () => {
        observeServerTime("2026-01-02T00:00:05.000Z");
        // A frame delayed in flight looks like a slower relay. It is not evidence
        // the clock moved back, so the estimate holds.
        observeServerTime("2026-01-02T00:00:03.000Z");
        expect(serverNow()).toBe("2026-01-02T00:00:05.000Z");
    });

    it("ignores a missing or unparseable stamp", () => {
        observeServerTime(undefined);
        observeServerTime("not a date");
        expect(serverNow()).toBe("2026-01-02T00:00:00.000Z");
    });

    it("forgets the estimate on reset, so a new socket re-learns it", () => {
        observeServerTime("2026-01-02T00:00:05.000Z");
        resetServerClock();
        expect(serverNow()).toBe("2026-01-02T00:00:00.000Z");
    });
});
