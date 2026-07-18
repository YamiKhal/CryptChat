/**
 * Synthesized UI sounds, no asset files.
 *
 * Every sound here is generated on the fly with the Web Audio API rather than
 * shipped as an mp3: it keeps the bundle small, needs no network fetch (a remote
 * sound would leak a request the moment a message arrived), and lets each cue be
 * tuned in code. A single shared AudioContext is created lazily on first use --
 * browsers block one until a user gesture, and by the time any of these fire the
 * user has already interacted with the app.
 *
 * Settings are a module singleton, configured from the vault's local preferences
 * via `configureSounds`. Playback is always best-effort: a blocked or
 * unsupported AudioContext must never throw into a caller.
 */

import { base64UrlToBytes, bytesToDataUrl } from './binary';

/** Every distinct cue the app can play. */
export type SoundEvent =
  | 'message-in' // a message arrived in a channel that is not the open one
  | 'message-in-active' // a message arrived in the channel currently open
  | 'message-sent' // our own message left the composer
  | 'call-incoming' // a ring is playing (looped separately)
  | 'call-outgoing' // our outgoing call is ringing
  | 'typing'; // a keystroke in the composer

/**
 * Which cues are on, plus the master switch and volume. Persisted per device in
 * the vault preferences; never sent anywhere.
 */
export interface SoundSettings {
  /** Master switch. Off silences everything. */
  enabled: boolean;
  /** 0..1, scales every cue. */
  volume: number;
  messageReceived: boolean;
  messageInActiveChat: boolean;
  messageSent: boolean;
  calls: boolean;
  typing: boolean;
}

/**
 * Defaults lean quiet: the cues people expect (a new message from elsewhere, a
 * ringing call) are on, while the noisy opt-ins (a sound for every keystroke, or
 * for messages in the chat you are already staring at, or your own sends) are
 * off until asked for.
 */
export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 0.6,
  messageReceived: true,
  messageInActiveChat: false,
  messageSent: false,
  calls: true,
  typing: false,
};

let settings: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };

/**
 * Data URLs for user-supplied sound files, keyed by event. When present, the
 * file plays in place of the synthesized cue. Built from vault assets by
 * `configureCustomSounds`.
 */
const customUrls: Partial<Record<SoundEvent, string>> = {};

/**
 * The channel currently open on screen, or null. Lets the message router pick
 * between the "arrived elsewhere" and "arrived here" cues. Set by the chat view.
 */
let activeChannelId: string | null = null;

export function setActiveChannel(channelId: string | null): void {
  activeChannelId = channelId;
}

/** Merge persisted preferences over the defaults. Missing keys keep their default. */
export function configureSounds(patch?: Partial<SoundSettings>): void {
  settings = { ...DEFAULT_SOUND_SETTINGS, ...(patch ?? {}) };
}

export function getSoundSettings(): SoundSettings {
  return settings;
}

/**
 * Install user-supplied sound files (as {mime, base64url} assets) for the events
 * that have one. Rebuilds object URLs, revoking any previous ones so repeated
 * calls do not leak. Passing an empty/undefined map clears every custom sound.
 */
export function configureCustomSounds(
  assets?: Partial<Record<SoundEvent, { mime: string; data: string }>>
): void {
  for (const key of Object.keys(customUrls) as SoundEvent[]) delete customUrls[key];
  if (!assets) return;
  for (const key of Object.keys(assets) as SoundEvent[]) {
    const asset = assets[key];
    if (!asset) continue;
    try {
      customUrls[key] = bytesToDataUrl(base64UrlToBytes(asset.data), asset.mime);
    } catch {
      // A malformed asset just falls back to the synthesized cue.
    }
  }
}

/** Play a custom file for this event if one is installed. Returns whether it did. */
function playCustom(event: SoundEvent): boolean {
  const url = customUrls[event];
  if (!url) return false;
  try {
    const el = new Audio(url);
    el.volume = Math.max(0, Math.min(1, settings.volume));
    void el.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

let ctx: AudioContext | null = null;

/** Lazily create (and resume) the shared context. Returns null if unsupported. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // A gesture earlier in the session may have created the context while the
    // tab was still blocked; nudge it back to running each time.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

interface ToneSpec {
  freq: number;
  /** Seconds from `at` until the note starts. */
  delay?: number;
  /** Seconds the note sounds. */
  duration: number;
  type?: OscillatorType;
  /** Peak gain before the master volume, 0..1. */
  gain?: number;
}

/**
 * Play one shaped note. A short attack and exponential release keep it a soft
 * blip rather than a click with hard edges.
 */
function tone(ac: AudioContext, at: number, spec: ToneSpec): void {
  const start = at + (spec.delay ?? 0);
  const end = start + spec.duration;
  const peak = (spec.gain ?? 0.5) * settings.volume;

  const osc = ac.createOscillator();
  osc.type = spec.type ?? 'sine';
  osc.frequency.value = spec.freq;

  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(g).connect(ac.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

/** The note pattern for each one-shot cue. */
function pattern(event: Exclude<SoundEvent, 'call-incoming' | 'call-outgoing'>): ToneSpec[] {
  switch (event) {
    case 'message-in':
      // Two-note rise: attention without being shrill.
      return [
        { freq: 660, duration: 0.09, gain: 0.5 },
        { freq: 880, delay: 0.09, duration: 0.12, gain: 0.5 },
      ];
    case 'message-in-active':
      // A soft single tick for a chat you are already watching.
      return [{ freq: 720, duration: 0.07, gain: 0.28 }];
    case 'message-sent':
      // A quiet high blip that reads as "gone".
      return [{ freq: 980, duration: 0.08, gain: 0.22, type: 'triangle' }];
    case 'typing':
      // Barely-there mechanical tick.
      return [{ freq: 320, duration: 0.03, gain: 0.14, type: 'square' }];
  }
}

/** Whether a given cue is permitted by the current settings. */
function allowed(event: SoundEvent): boolean {
  if (!settings.enabled) return false;
  switch (event) {
    case 'message-in':
      return settings.messageReceived;
    case 'message-in-active':
      return settings.messageInActiveChat;
    case 'message-sent':
      return settings.messageSent;
    case 'call-incoming':
    case 'call-outgoing':
      return settings.calls;
    case 'typing':
      return settings.typing;
  }
}

/** Play a one-shot cue, if enabled. Looping cues use the ringtone helpers. */
export function playSound(event: Exclude<SoundEvent, 'call-incoming' | 'call-outgoing'>): void {
  if (!allowed(event)) return;
  if (playCustom(event)) return;
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  for (const spec of pattern(event)) tone(ac, now, spec);
}

/**
 * Play a cue on demand for the settings "test" buttons, ignoring the enabled
 * flags (the point is to hear what a toggle does even while it is off). Volume is
 * still honoured so the preview matches how loud the cue will actually be.
 */
export function previewSound(event: SoundEvent): void {
  if (playCustom(event)) return;
  const ac = audio();
  if (!ac) return;
  if (event === 'call-incoming' || event === 'call-outgoing') {
    ringBurst(event);
    return;
  }
  const now = ac.currentTime;
  for (const spec of pattern(event)) tone(ac, now, spec);
}

/**
 * Route an incoming message to the right cue: the active-chat sound when it
 * landed in the channel on screen, otherwise the louder "elsewhere" alert. Own
 * messages never ring here.
 */
export function playIncomingMessage(channelId: string): void {
  if (channelId === activeChannelId && document.visibilityState === 'visible') {
    playSound('message-in-active');
  } else {
    playSound('message-in');
  }
}

let ringTimer: ReturnType<typeof setInterval> | null = null;
/** A looping <audio> for a custom ringtone file, if one is set. */
let ringAudio: HTMLAudioElement | null = null;

/** Play one ring burst of the given kind. */
function ringBurst(kind: 'call-incoming' | 'call-outgoing'): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  if (kind === 'call-incoming') {
    // A two-tone warble, twice, like a classic ringtone.
    tone(ac, now, { freq: 660, duration: 0.2, gain: 0.5 });
    tone(ac, now, { freq: 520, delay: 0.22, duration: 0.2, gain: 0.5 });
  } else {
    // A single low, patient tone for our own outgoing ring.
    tone(ac, now, { freq: 440, duration: 0.35, gain: 0.32 });
  }
}

/**
 * Start a repeating ring until `stopRingtone` is called. Safe to call twice --
 * an existing ring is replaced, not stacked.
 */
export function startRingtone(kind: 'call-incoming' | 'call-outgoing'): void {
  if (!allowed(kind)) return;
  stopRingtone();
  // A custom ringtone file loops through one <audio> element; otherwise the
  // synthesized burst repeats on a timer.
  const url = customUrls[kind];
  if (url) {
    try {
      ringAudio = new Audio(url);
      ringAudio.loop = true;
      ringAudio.volume = Math.max(0, Math.min(1, settings.volume));
      void ringAudio.play().catch(() => {});
      return;
    } catch {
      ringAudio = null;
    }
  }
  ringBurst(kind);
  ringTimer = setInterval(() => ringBurst(kind), kind === 'call-incoming' ? 1600 : 3000);
}

export function stopRingtone(): void {
  if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  if (ringAudio) {
    try {
      ringAudio.pause();
      ringAudio.currentTime = 0;
    } catch {
      // ignore
    }
    ringAudio = null;
  }
}
