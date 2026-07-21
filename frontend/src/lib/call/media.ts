import { suppressMic } from '@/lib/noiseSuppression';

/**
 * Standard constraints plus Chromium's stronger, non-standard `goog*` hints
 * (Edge/Chrome honour them; Firefox ignores them harmlessly). Mono, because a
 * voice call has nothing to gain from stereo and the extra channel only carries
 * more room noise.
 */
const AUDIO_CONSTRAINTS = {
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

export interface AcquiredMedia {
  stream: MediaStream;
  /** The cleaned (RNNoise) track we actually send, or the raw mic on fallback. */
  outgoingAudio: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  /** Teardown for the RNNoise audio graph, if one was built. */
  audioDispose: (() => void) | null;
}

/**
 * Open the mic (and camera, if asked), routing the mic through RNNoise. The
 * browser suppression above is the baseline and the fallback if the worklet
 * cannot start -- a call must never fail because the fancy filter did not load.
 */
export async function acquireLocalMedia(wantVideo: boolean): Promise<AcquiredMedia> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: AUDIO_CONSTRAINTS,
    video: wantVideo,
  });

  const rawMic = stream.getAudioTracks()[0] ?? null;
  const videoTrack = wantVideo ? (stream.getVideoTracks()[0] ?? null) : null;

  let outgoingAudio = rawMic;
  let audioDispose: (() => void) | null = null;
  if (rawMic) {
    try {
      const suppressed = await suppressMic(rawMic);
      audioDispose = suppressed.dispose;
      outgoingAudio = suppressed.track;
    } catch {
      audioDispose = null;
      outgoingAudio = rawMic;
    }
  }

  return { stream, outgoingAudio, videoTrack, audioDispose };
}

/** Turn a getUserMedia/getDisplayMedia failure into a line worth showing. */
export function mediaError(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === 'NotAllowedError') return 'Camera / microphone permission was denied.';
  if (name === 'NotFoundError') return 'No camera or microphone was found.';
  if (name === 'NotReadableError') return 'The camera or microphone is already in use.';
  return 'Could not start the call.';
}
