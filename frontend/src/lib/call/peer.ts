import { api } from '@/lib/api';
import { stopRingtone } from '@/lib/sounds';
import type { CallSignal } from '@/lib/crypto';

/** The callbacks a peer connection reports back into call state. */
export interface PeerConnectionHooks {
  token: string | null;
  /** The current call id, read lazily so a late ICE candidate uses the live value. */
  getCallId: () => string | null;
  sendSignal: (channelId: string, signal: CallSignal) => Promise<void>;
  onRelayAvailable: (relay: boolean) => void;
  setRemoteStream: (stream: MediaStream) => void;
  setRemoteHasVideo: (on: boolean) => void;
  onConnected: () => void;
  onFailed: () => void;
}

/**
 * Build a peer connection wired to the relay for this call. Shared by caller and
 * callee. ICE servers come from the server; a failure to fetch them still leaves
 * LAN / open-NAT calls able to connect.
 */
export async function buildPeerConnection(
  channelId: string,
  hooks: PeerConnectionHooks,
): Promise<RTCPeerConnection> {
  let iceServers: RTCIceServer[] = [];
  if (hooks.token) {
    try {
      const res = await api.ice(hooks.token);
      iceServers = res.iceServers;
      hooks.onRelayAvailable(res.relay);
    } catch {
      // No ICE config: LAN / open-NAT calls can still connect.
    }
  }

  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (e) => {
    const callId = hooks.getCallId();
    if (e.candidate && callId) {
      void hooks.sendSignal(channelId, {
        kind: 'ice',
        callId,
        candidate: JSON.stringify(e.candidate.toJSON()),
      });
    }
  };

  const remote = new MediaStream();
  hooks.setRemoteStream(remote);
  pc.ontrack = (e) => {
    remote.addTrack(e.track);
    hooks.setRemoteStream(new MediaStream(remote.getTracks()));

    // Track whether the peer is actually sending video. A reserved-but-idle
    // video transceiver delivers a muted track; it unmutes when the peer starts
    // their camera or shares a screen. We show the remote tile on unmute
    // regardless of our own tier, so a free user sees a shared screen.
    if (e.track.kind === 'video') {
      const t = e.track;
      hooks.setRemoteHasVideo(!t.muted && t.readyState === 'live');
      t.onunmute = () => hooks.setRemoteHasVideo(true);
      t.onmute = () => hooks.setRemoteHasVideo(false);
      t.onended = () => hooks.setRemoteHasVideo(false);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      stopRingtone();
      hooks.onConnected();
    } else if (s === 'failed') {
      // A hard media-path failure ends the call locally.
      hooks.onFailed();
    }
  };

  return pc;
}
