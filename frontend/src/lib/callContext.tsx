import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { api } from './api';
import { useSession } from './session';
import { useRelayContext } from './relayContext';
import { suppressMic } from './noiseSuppression';
import type { CallSignal } from './crypto';

/**
 * 1:1 WebRTC calls for direct messages.
 *
 * Media is peer-to-peer and DTLS-SRTP encrypted end-to-end; it never reaches our
 * server. The server's only role is ICE (how the peers find each other) and
 * relaying the signed, encrypted call-control frames -- it sees neither the SDP
 * (which carries IPs and DTLS fingerprints) nor whether a call connected.
 *
 * Premium gate, honest version: video and screen-share require the *initiator*
 * to be a supporter, checked here in the client. A patched client could bypass
 * it, exactly like the custom-theme perk -- we do not pretend otherwise. Voice
 * is always free.
 */

type CallStatus = 'idle' | 'ringing-out' | 'ringing-in' | 'connecting' | 'connected';

export interface IncomingCall {
  channelId: string;
  peerId: string;
  media: 'audio' | 'video';
  callId: string;
}

interface CallContextValue {
  status: CallStatus;
  channelId: string | null;
  peerId: string | null;
  /** The media the call was placed with. Screen-share replaces the video track in place. */
  media: 'audio' | 'video';
  incoming: IncomingCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** The peer is sending live video (camera or a shared screen). Tier-independent. */
  remoteHasVideo: boolean;
  muted: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  premium: boolean;
  /** True when a TURN relay is configured, so strict-NAT calls should connect. */
  relayAvailable: boolean;
  error: string | null;
  /** Start a call. Rejects video before it touches the camera if not premium. */
  startCall: (channelId: string, peerId: string, media: 'audio' | 'video') => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => Promise<void>;
  clearError: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { token } = useSession();
  const { sendSignal, subscribeSignals } = useRelayContext();

  const [status, setStatus] = useState<CallStatus>('idle');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [media, setMedia] = useState<'audio' | 'video'>('audio');
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // The peer is sending live video (their camera, or a screen they are sharing).
  // Drives whether we render the remote video tile -- crucially independent of
  // our own tier, so a free user still SEES a shared screen.
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [premium, setPremium] = useState(false);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // The camera track set aside while screen-sharing, so stopping the share
  // restores it rather than leaving a black tile.
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  // The cleaned (RNNoise) audio track we actually send, plus its teardown. Kept
  // apart from the raw mic so mute toggles the sent track and teardown closes the
  // audio graph.
  const outgoingAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioDisposeRef = useRef<(() => void) | null>(null);
  // The sender of our outgoing video m-line. Present even on a voice call (we
  // reserve a video transceiver up front) so screen-share is a replaceTrack --
  // no mid-call renegotiation, which the simple signaling here does not do.
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const callIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  // ICE candidates that arrive before the remote description is set are buffered
  // and applied once it is -- normal, since the offerer trickles candidates the
  // instant it has them.
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingOfferRef = useRef<CallSignal | null>(null);

  // Keep premium status fresh: the gate reads it at call-start.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .limits(token)
      .then((res) => !cancelled && setPremium(Boolean(res.premium)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  const stopLocalTracks = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    // Close the RNNoise graph, then drop the cleaned track it produced.
    audioDisposeRef.current?.();
    audioDisposeRef.current = null;
    outgoingAudioTrackRef.current?.stop();
    outgoingAudioTrackRef.current = null;
    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;
    localStreamRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      try {
        pcRef.current.close();
      } catch {
        // already closed
      }
      pcRef.current = null;
    }
    stopLocalTracks();
    videoSenderRef.current = null;
    callIdRef.current = null;
    channelIdRef.current = null;
    peerIdRef.current = null;
    pendingIceRef.current = [];
    pendingOfferRef.current = null;
    setStatus('idle');
    setChannelId(null);
    setPeerId(null);
    setIncoming(null);
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteHasVideo(false);
    setMuted(false);
    setCameraOff(false);
    setSharingScreen(false);
  }, [stopLocalTracks]);

  // Build a peer connection wired to the relay for this call. Shared by caller
  // and callee.
  const buildPeer = useCallback(
    async (cid: string): Promise<RTCPeerConnection> => {
      let iceServers: RTCIceServer[] = [];
      if (token) {
        try {
          const res = await api.ice(token);
          iceServers = res.iceServers;
          setRelayAvailable(res.relay);
        } catch {
          // No ICE config: LAN / open-NAT calls can still connect.
        }
      }

      const pc = new RTCPeerConnection({ iceServers });

      pc.onicecandidate = (e) => {
        if (e.candidate && callIdRef.current) {
          void sendSignal(cid, {
            kind: 'ice',
            callId: callIdRef.current,
            candidate: JSON.stringify(e.candidate.toJSON()),
          });
        }
      };

      const remote = new MediaStream();
      setRemoteStream(remote);
      pc.ontrack = (e) => {
        remote.addTrack(e.track);
        setRemoteStream(new MediaStream(remote.getTracks()));

        // Track whether the peer is actually sending video. A reserved-but-idle
        // video transceiver delivers a muted track; it unmutes when the peer
        // starts their camera or shares a screen. We show the remote tile on
        // unmute regardless of our own tier, so a free user sees a shared screen.
        if (e.track.kind === 'video') {
          const t = e.track;
          setRemoteHasVideo(!t.muted && t.readyState === 'live');
          t.onunmute = () => setRemoteHasVideo(true);
          t.onmute = () => setRemoteHasVideo(false);
          t.onended = () => setRemoteHasVideo(false);
        }
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') setStatus('connected');
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          // A media-path failure ends the call; the peer gets a hangup below via
          // the normal teardown path when the user closes it, but a hard failure
          // ends it locally too.
          if (s === 'failed') teardown();
        }
      };

      return pc;
    },
    [token, sendSignal, teardown]
  );

  const acquireLocal = useCallback(async (
    wantVideo: boolean
  ): Promise<{ outgoingAudio: MediaStreamTrack | null; videoTrack: MediaStreamTrack | null }> => {
    // Standard constraints plus Chromium's stronger, non-standard `goog*` hints
    // (Edge/Chrome honour them; Firefox ignores them harmlessly). Mono, because a
    // voice call has nothing to gain from stereo and the extra channel only
    // carries more room noise.
    const audio = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googNoiseSuppression2: true,
      googAutoGainControl: true,
      googHighpassFilter: true,
      googTypingNoiseDetection: true,
    } as unknown as MediaTrackConstraints;

    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: wantVideo });

    localStreamRef.current = stream;
    setLocalStream(stream);

    const rawMic = stream.getAudioTracks()[0] ?? null;
    const videoTrack = wantVideo ? (stream.getVideoTracks()[0] ?? null) : null;
    if (videoTrack) cameraTrackRef.current = videoTrack;

    // Run the mic through RNNoise. The browser suppression above is the baseline
    // and the fallback if the worklet cannot start -- a call must never fail
    // because the fancy filter did not load.
    let outgoingAudio = rawMic;
    if (rawMic) {
      try {
        const suppressed = await suppressMic(rawMic);
        audioDisposeRef.current = suppressed.dispose;
        outgoingAudio = suppressed.track;
      } catch {
        audioDisposeRef.current = null;
        outgoingAudio = rawMic;
      }
    }
    outgoingAudioTrackRef.current = outgoingAudio;

    return { outgoingAudio, videoTrack };
  }, []);

  const startCall = useCallback(
    async (cid: string, pid: string, kind: 'audio' | 'video') => {
      if (status !== 'idle') return;

      // Honest client-side gate: video is a supporter feature. Refused before
      // the camera is ever touched.
      if (kind === 'video' && !premium) {
        setError('Video calls are a supporter feature.');
        return;
      }

      setError(null);
      const callId = crypto.randomUUID();
      callIdRef.current = callId;
      channelIdRef.current = cid;
      peerIdRef.current = pid;
      setChannelId(cid);
      setPeerId(pid);
      setMedia(kind);
      setStatus('ringing-out');

      try {
        const { outgoingAudio, videoTrack } = await acquireLocal(kind === 'video');
        const pc = await buildPeer(cid);
        pcRef.current = pc;
        const ms = localStreamRef.current ?? new MediaStream();
        if (outgoingAudio) pc.addTrack(outgoingAudio, ms);
        if (videoTrack) pc.addTrack(videoTrack, ms);

        // Ensure exactly one outgoing video path exists. A video call already has
        // one (the camera track above); a voice call reserves an idle one so a
        // later screen-share is a replaceTrack, not a renegotiation.
        if (kind === 'video') {
          videoSenderRef.current =
            pc.getSenders().find((s) => s.track?.kind === 'video') ?? null;
        } else {
          videoSenderRef.current = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        void sendSignal(cid, { kind: 'offer', callId, media: kind, sdp: offer.sdp });
      } catch (err) {
        setError(mediaError(err));
        teardown();
      }
    },
    [status, premium, acquireLocal, buildPeer, sendSignal, teardown]
  );

  const accept = useCallback(async () => {
    const call = incoming;
    const offer = pendingOfferRef.current;
    if (!call || !offer || !offer.sdp) return;

    setError(null);
    callIdRef.current = call.callId;
    channelIdRef.current = call.channelId;
    peerIdRef.current = call.peerId;
    setChannelId(call.channelId);
    setPeerId(call.peerId);
    setMedia(call.media);
    setIncoming(null);
    setStatus('connecting');

    try {
      // Match the caller's media: answer a video offer with our camera too.
      const { outgoingAudio, videoTrack } = await acquireLocal(call.media === 'video');
      const pc = await buildPeer(call.channelId);
      pcRef.current = pc;

      // Applying the offer creates transceivers matching its m-lines (audio, and
      // the video one the caller reserved). Attach our tracks onto those senders
      // via replaceTrack rather than addTrack -- addTrack would append a second,
      // mismatched video m-line and break the answer.
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });

      for (const tr of pc.getTransceivers()) {
        const kind = tr.receiver.track?.kind;
        if (kind === 'audio') {
          tr.direction = 'sendrecv';
          if (outgoingAudio) await tr.sender.replaceTrack(outgoingAudio).catch(() => {});
        } else if (kind === 'video') {
          tr.direction = 'sendrecv';
          videoSenderRef.current = tr.sender;
          if (videoTrack) await tr.sender.replaceTrack(videoTrack).catch(() => {});
        }
      }

      // Apply any candidates that raced ahead of the offer being accepted.
      for (const c of pendingIceRef.current) await pc.addIceCandidate(c).catch(() => {});
      pendingIceRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      void sendSignal(call.channelId, { kind: 'answer', callId: call.callId, sdp: answer.sdp });
    } catch (err) {
      setError(mediaError(err));
      if (channelIdRef.current) void sendSignal(channelIdRef.current, { kind: 'hangup', callId: call.callId });
      teardown();
    }
  }, [incoming, acquireLocal, buildPeer, sendSignal, teardown]);

  const decline = useCallback(() => {
    if (incoming) {
      void sendSignal(incoming.channelId, { kind: 'decline', callId: incoming.callId });
    }
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    setIncoming(null);
    if (status === 'ringing-in') setStatus('idle');
  }, [incoming, status, sendSignal]);

  const hangup = useCallback(() => {
    if (channelIdRef.current && callIdRef.current) {
      void sendSignal(channelIdRef.current, { kind: 'hangup', callId: callIdRef.current });
    }
    teardown();
  }, [sendSignal, teardown]);

  const toggleMute = useCallback(() => {
    // The cleaned (sent) track, not the raw mic -- disabling this is what the
    // peer actually stops hearing.
    const track = outgoingAudioTrackRef.current;
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  /**
   * Tell the peer whether we are currently sending live video, so their remote
   * tile appears and disappears deterministically. A replaceTrack(null) does not
   * reliably mute the far track, so relying on that alone leaves a frozen last
   * frame when a screen-share stops -- this is the authoritative signal.
   */
  const notifyVideoState = useCallback(() => {
    const cid = channelIdRef.current;
    const callId = callIdRef.current;
    if (!cid || !callId) return;
    const t = videoSenderRef.current?.track;
    const on = Boolean(t && t.readyState === 'live' && t.enabled);
    void sendSignal(cid, { kind: 'video', callId, on });
  }, [sendSignal]);

  const toggleCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
    notifyVideoState();
  }, [notifyVideoState]);

  const toggleScreenShare = useCallback(async () => {
    if (!premium) {
      setError('Screen sharing is a supporter feature.');
      return;
    }
    // The reserved video sender, present even on a voice call, so sharing is a
    // plain replaceTrack with no renegotiation. The receiver needs no premium to
    // see it -- only the sharer does (this early return).
    const videoSender = videoSenderRef.current;
    if (!videoSender) return;

    if (sharingScreen) {
      // Restore the camera track (or go idle if it was a voice call).
      await videoSender.replaceTrack(cameraTrackRef.current ?? null).catch(() => {});
      setSharingScreen(false);
      notifyVideoState(); // tell the peer video is gone -- this is what closes their tile
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) return;
      // If the user stops sharing from the browser's own UI, fall back to camera.
      screenTrack.onended = () => {
        void videoSender.replaceTrack(cameraTrackRef.current ?? null).catch(() => {});
        setSharingScreen(false);
        notifyVideoState();
      };
      await videoSender.replaceTrack(screenTrack);
      setSharingScreen(true);
      notifyVideoState();
    } catch (err) {
      // User cancelled the picker, or no permission -- not an error worth a banner.
      if ((err as Error)?.name !== 'NotAllowedError') setError(mediaError(err));
    }
  }, [premium, sharingScreen, notifyVideoState]);

  // Consume incoming call-control frames. Registered once; the relay layer keeps
  // no state of its own.
  useEffect(() => {
    const unsub = subscribeSignals(({ channelId: cid, senderId, signal }) => {
      switch (signal.kind) {
        case 'offer': {
          // Busy: reject a second caller rather than clobber the live call.
          if (status !== 'idle' || pcRef.current) {
            void sendSignal(cid, { kind: 'decline', callId: signal.callId });
            return;
          }
          // A video call needs BOTH sides premium. The caller was gated when
          // starting; gate the callee here. A non-premium callee never sees a
          // video ring it cannot fulfil -- it auto-declines with a reason.
          // (Screen-share is different: it arrives inside a voice call and needs
          // only the sharer premium, so it is never gated here.)
          if (signal.media === 'video' && !premium) {
            void sendSignal(cid, { kind: 'decline', callId: signal.callId });
            setError('A video call needs a supporter account on both sides.');
            return;
          }
          pendingOfferRef.current = signal;
          pendingIceRef.current = [];
          setIncoming({
            channelId: cid,
            peerId: senderId,
            media: signal.media === 'video' ? 'video' : 'audio',
            callId: signal.callId,
          });
          setStatus('ringing-in');
          break;
        }
        case 'answer': {
          if (signal.callId !== callIdRef.current || !pcRef.current || !signal.sdp) return;
          setStatus('connecting');
          void pcRef.current
            .setRemoteDescription({ type: 'answer', sdp: signal.sdp })
            .then(async () => {
              for (const c of pendingIceRef.current) await pcRef.current!.addIceCandidate(c).catch(() => {});
              pendingIceRef.current = [];
            })
            .catch(() => {});
          break;
        }
        case 'ice': {
          if (signal.callId !== callIdRef.current && signal.callId !== pendingOfferRef.current?.callId) return;
          if (!signal.candidate) return;
          let cand: RTCIceCandidateInit;
          try {
            cand = JSON.parse(signal.candidate);
          } catch {
            return;
          }
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) void pc.addIceCandidate(cand).catch(() => {});
          else pendingIceRef.current.push(cand);
          break;
        }
        case 'video': {
          // Authoritative remote-video state: the peer turned their camera or a
          // shared screen on or off. Overrides the unreliable track-mute heuristic.
          if (signal.callId !== callIdRef.current && signal.callId !== pendingOfferRef.current?.callId) {
            return;
          }
          setRemoteHasVideo(signal.on === true);
          break;
        }
        case 'decline': {
          if (signal.callId === callIdRef.current) {
            setError('Call declined.');
            teardown();
          }
          break;
        }
        case 'hangup': {
          if (signal.callId === callIdRef.current || signal.callId === pendingOfferRef.current?.callId) {
            teardown();
          }
          break;
        }
        default:
          break;
      }
    });
    return unsub;
  }, [subscribeSignals, sendSignal, status, premium, teardown]);

  // A hard unmount (logout / lock) must not leave a camera light on.
  useEffect(() => () => teardown(), [teardown]);

  const value = useMemo<CallContextValue>(
    () => ({
      status,
      channelId,
      peerId,
      media,
      incoming,
      localStream,
      remoteStream,
      remoteHasVideo,
      muted,
      cameraOff,
      sharingScreen,
      premium,
      relayAvailable,
      error,
      startCall,
      accept,
      decline,
      hangup,
      toggleMute,
      toggleCamera,
      toggleScreenShare,
      clearError: () => setError(null),
    }),
    [
      status,
      channelId,
      peerId,
      media,
      incoming,
      localStream,
      remoteStream,
      remoteHasVideo,
      muted,
      cameraOff,
      sharingScreen,
      premium,
      relayAvailable,
      error,
      startCall,
      accept,
      decline,
      hangup,
      toggleMute,
      toggleCamera,
      toggleScreenShare,
    ]
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used inside CallProvider');
  return ctx;
}

/** Turn a getUserMedia/getDisplayMedia failure into a line worth showing. */
function mediaError(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === 'NotAllowedError') return 'Camera / microphone permission was denied.';
  if (name === 'NotFoundError') return 'No camera or microphone was found.';
  if (name === 'NotReadableError') return 'The camera or microphone is already in use.';
  return 'Could not start the call.';
}
