import { useEffect, useRef } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, MonitorUp } from 'lucide-react';
import { useCall } from '../lib/callContext';
import { useSession } from '../lib/session';

/**
 * The call surface: an incoming-call ring and the active-call window.
 *
 * Rendered once, app-wide (see App.tsx), so a call persists while the user moves
 * between the DM and the channel list. It reads everything from the call
 * context; the DM header only triggers `startCall`.
 */
export default function CallOverlay() {
  const call = useCall();
  const { vault } = useSession();

  const nameFor = (userId: string | null) =>
    (userId && vault?.getContact(userId)?.displayName) || 'your contact';

  // Incoming ring: a compact prompt, not the full window, so accepting is a
  // deliberate act.
  if (call.status === 'ringing-in' && call.incoming) {
    const inc = call.incoming;
    return (
      <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
        <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-surface p-4 shadow-xl animate-fade-in">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
              {inc.media === 'video' ? <Video size={18} /> : <Phone size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate t-h4 font-medium">{nameFor(inc.peerId)}</p>
              <p className="t-small text-muted">
                incoming {inc.media === 'video' ? 'video' : 'voice'} call
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={call.decline} className="btn-ghost flex-1 t-base text-error">
              decline
            </button>
            <button onClick={() => void call.accept()} className="btn-primary flex-1 t-base">
              accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (call.status === 'idle') {
    // Nothing active, but a just-ended call may have left an error to surface.
    return call.error ? (
      <ErrorToast message={call.error} onClose={call.clearError} />
    ) : null;
  }

  // Do I have an outgoing video track (a video call, or a screen I'm sharing)?
  const iSendVideo = call.media === 'video' || call.sharingScreen;
  // Show the video stage if anyone has video -- crucially, a free user shows it
  // when the PEER shares a screen (remoteHasVideo), independent of their tier.
  const showStage = call.remoteHasVideo || iSendVideo;
  const statusLabel =
    call.status === 'ringing-out'
      ? 'calling…'
      : call.status === 'connecting'
        ? 'connecting…'
        : 'connected';

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black">
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate t-h4 font-medium">{nameFor(call.peerId)}</p>
          <p className="t-small text-zinc-400">{statusLabel}</p>
        </div>
        {!call.relayAvailable && call.status !== 'connected' && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 t-small text-zinc-300">
            no relay — may not connect
          </span>
        )}
      </div>

      {/* The one place the peer's audio plays. A dedicated <audio> element, ALWAYS
          mounted and never display:none -- a hidden <video> will not autoplay its
          audio, which is why voice used to stay silent until a visible video tile
          (a shared screen) appeared. The video tiles below are muted; they carry
          picture only. */}
      <RemoteAudio stream={call.remoteStream} />

      <div className="relative flex-1 overflow-hidden">
        {showStage ? (
          <>
            {/* Main tile: the peer's video (camera or shared screen) if they are
                sending it; otherwise my own outgoing video, so I can see what I
                am sharing. Muted -- audio comes from RemoteAudio above. */}
            {call.remoteHasVideo ? (
              <VideoTile stream={call.remoteStream} className="h-full w-full object-contain" muted />
            ) : (
              <VideoTile stream={call.localStream} className="h-full w-full object-contain" muted />
            )}

            {/* Picture-in-picture of my own video, only when the peer's video is
                the main tile and I am also sending. */}
            {call.remoteHasVideo && iSendVideo && (
              <VideoTile
                stream={call.localStream}
                className="absolute bottom-4 right-4 h-32 w-24 rounded-lg border border-zinc-700 object-cover shadow-lg"
                muted
              />
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="grid h-24 w-24 place-items-center rounded-full bg-zinc-800 text-white">
              <Phone size={32} />
            </div>
          </div>
        )}
      </div>

      {call.error && <p className="px-4 py-1 text-center t-small text-error">{call.error}</p>}

      <div className="flex items-center justify-center gap-3 px-4 py-6">
        <ControlButton active={call.muted} onClick={call.toggleMute} label="mute">
          {call.muted ? <MicOff size={18} /> : <Mic size={18} />}
        </ControlButton>

        {call.media === 'video' && (
          <ControlButton active={call.cameraOff} onClick={call.toggleCamera} label="camera">
            {call.cameraOff ? <VideoOff size={18} /> : <Video size={18} />}
          </ControlButton>
        )}

        {call.premium && (
          <ControlButton
            active={call.sharingScreen}
            onClick={() => void call.toggleScreenShare()}
            label="share screen"
          >
            <MonitorUp size={18} />
          </ControlButton>
        )}

        <button
          onClick={call.hangup}
          className="grid h-14 w-14 place-items-center rounded-full bg-error text-white transition-transform hover:scale-105"
          aria-label="end call"
        >
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
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
      aria-pressed={active}
      className={`grid h-12 w-12 place-items-center rounded-full transition-colors ${
        active ? 'bg-white text-black' : 'bg-zinc-800 text-white hover:bg-zinc-700'
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
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4">
      <div className="rounded-lg border border-error-line bg-surface px-4 py-2 t-base text-error shadow-lg">
        {message}
      </div>
    </div>
  );
}
