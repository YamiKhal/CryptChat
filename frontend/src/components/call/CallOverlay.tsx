import { useEffect, useRef, useState } from "react";
import {
    Phone,
    PhoneOff,
    Video,
    VideoOff,
    Mic,
    MicOff,
    MonitorUp,
} from "lucide-react";
import { useCall } from "@/lib/callContext";
import { useSession } from "@/lib/session";
import Avatar from "@/components/ui/Avatar";

/**
 * The call surface: an incoming-call ring and the active-call window.
 *
 * Rendered once, app-wide (see App.tsx), so a call persists while the user moves
 * between the DM and the channel list. It reads everything from the call
 * context; the DM header only triggers `startCall`.
 *
 * The call window is deliberately dark in BOTH themes (like every calling app):
 * video needs a dark stage, so the chrome uses fixed dark solids, not the theme
 * tokens. Controls follow the platform grammar. round buttons in a bottom bar,
 * a toggled control inverts to white, hang-up is the one red pill.
 */
export default function CallOverlay() {
    const call = useCall();
    const { vault } = useSession();

    const nameFor = (userId: string | null) =>
        (userId && vault?.getContact(userId)?.displayName) || "your contact";
    const avatarFor = (userId: string | null) =>
        (userId && vault?.getContact(userId)?.avatar) || undefined;

    // Incoming ring: a compact prompt, not the full window, so accepting is a
    // deliberate act. Round accept/decline, phone-style.
    if (call.status === "ringing-in" && call.incoming) {
        const inc = call.incoming;
        return (
            <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
                <div className="menu-panel w-full max-w-sm p-4">
                    <div className="flex items-center gap-3">
                        <Avatar
                            asset={avatarFor(inc.peerId)}
                            name={nameFor(inc.peerId)}
                            size="md"
                        />
                        <div className="min-w-0 flex-1">
                            <p className="t-h4 truncate font-semibold">
                                {nameFor(inc.peerId)}
                            </p>
                            <p className="t-small text-muted flex items-center gap-1.5">
                                {inc.media === "video" ? (
                                    <Video size={12} />
                                ) : (
                                    <Phone size={12} />
                                )}
                                incoming{" "}
                                {inc.media === "video" ? "video call" : "call"}
                            </p>
                        </div>
                        <div className="flex flex-none items-center gap-2.5">
                            <button
                                onClick={call.decline}
                                aria-label="Decline"
                                title="Decline"
                                className="bg-error grid size-11 place-items-center rounded-full text-white transition-transform hover:scale-105"
                            >
                                <PhoneOff size={18} />
                            </button>
                            <button
                                onClick={() => void call.accept()}
                                aria-label="Accept"
                                title="Accept"
                                className="bg-ok grid size-11 place-items-center rounded-full text-white transition-transform hover:scale-105"
                            >
                                <Phone size={18} />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (call.status === "idle") {
        // Nothing active, but a just-ended call may have left an error to surface.
        return call.error ? (
            <ErrorToast message={call.error} onClose={call.clearError} />
        ) : null;
    }

    // Do I have an outgoing video track (a video call, or a screen I'm sharing)?
    const iSendVideo = call.media === "video" || call.sharingScreen;
    // Show the video stage if anyone has video -- crucially, a free user shows it
    // when the PEER shares a screen (remoteHasVideo), independent of their tier.
    const showStage = call.remoteHasVideo || iSendVideo;
    const connected = call.status === "connected";
    const ringing = call.status === "ringing-out";

    return (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black">
            {/* Header: identity + state, thin, out of the way. */}
            <div className="flex items-center gap-3 px-4 py-3 text-white sm:px-6">
                <div className="min-w-0 flex-1">
                    <p className="t-h4 truncate font-semibold">
                        {nameFor(call.peerId)}
                    </p>
                    <p className="t-small text-zinc-400">
                        {ringing ? (
                            "calling…"
                        ) : connected ? (
                            <CallTimer />
                        ) : (
                            "connecting…"
                        )}
                    </p>
                </div>
                {!call.relayAvailable && !connected && (
                    <span className="t-small rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-300">
                        no relay. may not connect
                    </span>
                )}
            </div>

            {/* The one place the peer's audio plays. A dedicated <audio> element, ALWAYS
          mounted and never display:none -- a hidden <video> will not autoplay its
          audio, which is why voice used to stay silent until a visible video tile
          (a shared screen) appeared. The video tiles below are muted; they carry
          picture only. */}
            <RemoteAudio stream={call.remoteStream} />

            <div className="relative min-h-0 flex-1 overflow-hidden">
                {showStage ? (
                    <>
                        {/* Main tile: the peer's video (camera or shared screen) if they are
                sending it; otherwise my own outgoing video, so I can see what I
                am sharing. Muted -- audio comes from RemoteAudio above. */}
                        {call.remoteHasVideo ? (
                            <VideoTile
                                stream={call.remoteStream}
                                className="h-full w-full object-contain"
                                muted
                            />
                        ) : (
                            <VideoTile
                                stream={call.localStream}
                                className="h-full w-full object-contain"
                                muted
                            />
                        )}

                        {/* Picture-in-picture of my own video, only when the peer's video is
                the main tile and I am also sending. Landscape thumb, larger on
                desktop, clear of the control bar. */}
                        {call.remoteHasVideo && iSendVideo && (
                            <VideoTile
                                stream={call.localStream}
                                className="absolute right-3 bottom-3 h-20 w-32 rounded-xl border border-zinc-700 object-cover shadow-lg sm:right-5 sm:bottom-5 sm:h-28 sm:w-44"
                                muted
                            />
                        )}
                    </>
                ) : (
                    // Voice stage: the peer, front and centre. A soft ring pulses while
                    // the call is still ringing so the state reads without words.
                    <div className="grid h-full place-items-center">
                        <div className="flex flex-col items-center gap-4">
                            <div
                                className={`rounded-full ${ringing ? "animate-pulse" : ""}`}
                            >
                                <Avatar
                                    asset={avatarFor(call.peerId)}
                                    name={nameFor(call.peerId)}
                                    size="lg"
                                />
                            </div>
                            <p className="t-h3 font-semibold text-white">
                                {nameFor(call.peerId)}
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {call.error && (
                <p className="t-small text-error px-4 py-1 text-center">
                    {call.error}
                </p>
            )}

            {/* Control bar. Bigger targets and extra bottom padding on phones (thumb
          reach + gesture bar), tighter on desktop. */}
            <div className="flex items-center justify-center gap-3 px-4 pt-4 pb-8 sm:gap-4 sm:pb-6">
                <ControlButton
                    active={call.muted}
                    onClick={call.toggleMute}
                    label={call.muted ? "Unmute" : "Mute"}
                >
                    {call.muted ? <MicOff size={20} /> : <Mic size={20} />}
                </ControlButton>

                {call.media === "video" && (
                    <ControlButton
                        active={call.cameraOff}
                        onClick={call.toggleCamera}
                        label={
                            call.cameraOff
                                ? "Turn camera on"
                                : "Turn camera off"
                        }
                    >
                        {call.cameraOff ? (
                            <VideoOff size={20} />
                        ) : (
                            <Video size={20} />
                        )}
                    </ControlButton>
                )}

                {call.premium && (
                    <ControlButton
                        active={call.sharingScreen}
                        onClick={() => void call.toggleScreenShare()}
                        label={
                            call.sharingScreen ? "Stop sharing" : "Share screen"
                        }
                    >
                        <MonitorUp size={20} />
                    </ControlButton>
                )}

                <button
                    onClick={call.hangup}
                    className="bg-error grid h-13 w-17 place-items-center rounded-full text-white transition-transform hover:scale-105"
                    aria-label="End call"
                    title="End call"
                >
                    <PhoneOff size={20} />
                </button>
            </div>
        </div>
    );
}

/** mm:ss since mount. mounts when the call connects, so it reads call length. */
function CallTimer() {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setSeconds((s) => s + 1), 1000);
        return () => clearInterval(t);
    }, []);
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, "0");
    return (
        <span className="tabular-nums">
            {mm}:{ss}
        </span>
    );
}

function ControlButton({
    active,
    onClick,
    label,
    children,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={`grid size-13 place-items-center rounded-full transition-colors ${
                active
                    ? "bg-white text-black"
                    : "bg-zinc-800 text-white hover:bg-zinc-700"
            }`}
        >
            {children}
        </button>
    );
}

/**
 * The peer's audio sink.
 *
 * A real <audio> element, always mounted. Audio is bound via srcObject and
 * .play() is called explicitly -- the accept/start click is a user gesture, so
 * autoplay is allowed. Kept separate from the video tiles so audio never depends
 * on a video element being visible (a hidden <video> will not play its audio).
 */
function RemoteAudio({ stream }: { stream: MediaStream | null }) {
    const ref = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.srcObject = stream;
        if (stream) el.play().catch(() => {});
    }, [stream]);
    return <audio ref={ref} autoPlay playsInline />;
}

/** A media element bound to a MediaStream via srcObject (which cannot be set in JSX). */
function VideoTile({
    stream,
    className,
    muted,
}: {
    stream: MediaStream | null;
    className: string;
    muted: boolean;
}) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.srcObject = stream;
    }, [stream]);
    return (
        <video
            ref={ref}
            className={className}
            autoPlay
            playsInline
            muted={muted}
        />
    );
}

function ErrorToast({
    message,
    onClose,
}: {
    message: string;
    onClose: () => void;
}) {
    useEffect(() => {
        const t = setTimeout(onClose, 4000);
        return () => clearTimeout(t);
    }, [onClose]);
    return (
        <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
            <div className="border-error-line bg-surface t-base text-error rounded-lg border px-4 py-2 shadow-lg">
                {message}
            </div>
        </div>
    );
}
