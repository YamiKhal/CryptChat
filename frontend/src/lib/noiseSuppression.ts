import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
// Vite serves these as same-origin hashed assets (so the strict CSP is happy:
// the worklet module loads under script-src 'self', the wasm fetch under
// connect-src 'self', and WASM compiles under 'wasm-unsafe-eval').
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

/**
 * Krisp-grade microphone noise suppression via RNNoise.
 *
 * The browser's built-in noiseSuppression is mild -- it tames steady hiss but
 * lets sharp transients (a dropped object, a keyboard) through. RNNoise is a
 * small recurrent net trained for exactly this; it runs in an AudioWorklet on
 * the audio thread, so it adds no perceptible latency and never blocks the UI.
 *
 * Signal path: mic track -> MediaStreamSource -> RNNoise worklet ->
 * MediaStreamDestination. The destination's track is what we actually send; the
 * raw mic never leaves this graph.
 *
 * Everything is best-effort: if the worklet or wasm fails to load (an old
 * browser, a CSP quirk), the caller falls back to the raw track with the
 * browser's own suppression -- a call must never fail because the fancy filter
 * could not start.
 */

export interface SuppressedMic {
  /** The cleaned audio track to send. */
  track: MediaStreamTrack;
  /** Tear down the audio graph and the context. Does NOT stop the raw mic track. */
  dispose: () => void;
}

// The wasm binary is fetched once and reused across calls in a session.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  return wasmBinaryPromise;
}

/**
 * Wrap a raw mic track in RNNoise, returning the cleaned track.
 *
 * `rawTrack` stays owned by the caller (it is the mic; stopping it is the
 * caller's job on hangup). Muting is done on the *cleaned* track by the caller.
 */
export async function suppressMic(rawTrack: MediaStreamTrack): Promise<SuppressedMic> {
  const wasmBinary = await getWasmBinary();

  // RNNoise is fixed at 48kHz; pin the context so the worklet's frame size lines
  // up with the sample rate.
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);

  const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
  const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  const destination = ctx.createMediaStreamDestination();

  source.connect(rnnoise).connect(destination);

  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    void ctx.close().catch(() => {});
    throw new Error('noise suppression produced no track');
  }

  const dispose = () => {
    try {
      source.disconnect();
      rnnoise.disconnect();
    } catch {
      // graph already torn down
    }
    void ctx.close().catch(() => {});
  };

  return { track, dispose };
}
