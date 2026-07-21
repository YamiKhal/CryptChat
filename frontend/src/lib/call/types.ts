export type CallStatus = 'idle' | 'ringing-out' | 'ringing-in' | 'connecting' | 'connected';

export interface IncomingCall {
  channelId: string;
  peerId: string;
  media: 'audio' | 'video';
  callId: string;
}

export interface CallContextValue {
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
