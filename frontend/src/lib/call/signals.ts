import type { CallSignal } from "@/lib/crypto";
import { startRingtone, stopRingtone } from "@/lib/sounds";
import { CallStatus, IncomingCall } from "@/lib/call/types";

type MutRef<T> = { current: T };

/** Everything the incoming-signal router reads and writes on the call state. */
export interface CallSignalContext {
    status: CallStatus;
    premium: boolean;
    pcRef: MutRef<RTCPeerConnection | null>;
    callIdRef: MutRef<string | null>;
    pendingOfferRef: MutRef<CallSignal | null>;
    pendingIceRef: MutRef<RTCIceCandidateInit[]>;
    sendSignal: (channelId: string, signal: CallSignal) => Promise<void>;
    setIncoming: (call: IncomingCall | null) => void;
    setStatus: (status: CallStatus) => void;
    setError: (error: string | null) => void;
    setRemoteHasVideo: (on: boolean) => void;
    teardown: () => void;
}

/**
 * Consume one incoming call-control frame. Offer rings us (with the busy and
 * premium gates), answer/ice drive the live connection and decline/hangup tear
 * it down. Pure routing over the refs and setters handed in via `ctx`.
 */
export function handleCallSignal(
    ctx: CallSignalContext,
    {
        channelId: cid,
        senderId,
        signal,
    }: { channelId: string; senderId: string; signal: CallSignal },
) {
    switch (signal.kind) {
        case "offer": {
            // Busy: reject a second caller rather than clobber the live call.
            if (ctx.status !== "idle" || ctx.pcRef.current) {
                void ctx.sendSignal(cid, {
                    kind: "decline",
                    callId: signal.callId,
                });
                return;
            }
            // A video call needs BOTH sides premium. The caller was gated when
            // starting; gate the callee here. A non-premium callee never sees a
            // video ring it cannot fulfil -- it auto-declines with a reason.
            // (Screen-share is different: it arrives inside a voice call and needs
            // only the sharer premium, so it is never gated here.)
            if (signal.media === "video" && !ctx.premium) {
                void ctx.sendSignal(cid, {
                    kind: "decline",
                    callId: signal.callId,
                });
                ctx.setError(
                    "A video call needs a supporter account on both sides.",
                );
                return;
            }
            ctx.pendingOfferRef.current = signal;
            ctx.pendingIceRef.current = [];
            ctx.setIncoming({
                channelId: cid,
                peerId: senderId,
                media: signal.media === "video" ? "video" : "audio",
                callId: signal.callId,
            });
            ctx.setStatus("ringing-in");
            startRingtone("call-incoming");
            break;
        }
        case "answer": {
            if (
                signal.callId !== ctx.callIdRef.current ||
                !ctx.pcRef.current ||
                !signal.sdp
            )
                return;
            stopRingtone(); // callee picked up. stop our outgoing ring
            ctx.setStatus("connecting");
            void ctx.pcRef.current
                .setRemoteDescription({ type: "answer", sdp: signal.sdp })
                .then(async () => {
                    for (const c of ctx.pendingIceRef.current)
                        await ctx.pcRef
                            .current!.addIceCandidate(c)
                            .catch(() => {});
                    ctx.pendingIceRef.current = [];
                })
                .catch(() => {});
            break;
        }
        case "ice": {
            if (
                signal.callId !== ctx.callIdRef.current &&
                signal.callId !== ctx.pendingOfferRef.current?.callId
            )
                return;
            if (!signal.candidate) return;
            let cand: RTCIceCandidateInit;
            try {
                cand = JSON.parse(signal.candidate);
            } catch {
                return;
            }
            const pc = ctx.pcRef.current;
            if (pc && pc.remoteDescription)
                void pc.addIceCandidate(cand).catch(() => {});
            else ctx.pendingIceRef.current.push(cand);
            break;
        }
        case "video": {
            // Authoritative remote-video state: the peer turned their camera or a
            // shared screen on or off. Overrides the unreliable track-mute heuristic.
            if (
                signal.callId !== ctx.callIdRef.current &&
                signal.callId !== ctx.pendingOfferRef.current?.callId
            ) {
                return;
            }
            ctx.setRemoteHasVideo(signal.on === true);
            break;
        }
        case "decline": {
            if (signal.callId === ctx.callIdRef.current) {
                ctx.setError("Call declined.");
                ctx.teardown();
            }
            break;
        }
        case "hangup": {
            if (
                signal.callId === ctx.callIdRef.current ||
                signal.callId === ctx.pendingOfferRef.current?.callId
            ) {
                ctx.teardown();
            }
            break;
        }
        default:
            break;
    }
}
