import { useSyncExternalStore } from 'react';

/**
 * Theme state.
 *
 * Deliberately NOT in the vault. The theme is a cosmetic device preference with
 * no security value, and it has to be readable before the vault unlocks (the
 * auth screen is themed too) and before React mounts (see the pre-paint script
 * in index.html). localStorage is the right home; keep the key in sync with
 * that script.
 *
 * Per-user custom palettes (ROADMAP #2) are a separate, vault-stored concern
 * that layers on top of this base light/dark choice.
 */

export type Theme = 'dark' | 'light';

const KEY = 'cryptchat.theme';

/** Dark is the default for anything unset or unreadable. */
export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Flip the attribute the CSS keys off. Does not persist. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// A tiny store so every mounted toggle (settings, and any future header button)
// stays in sync without prop-drilling or a context provider.
const listeners = new Set<() => void>();

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); still apply for this session.
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Live theme value for components. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'dark');
}

/* ------------------------------------------------------------------ */
/* custom palette (premium, ROADMAP #2)                                */
/* ------------------------------------------------------------------ */

/**
 * The tokens a premium user may override. A curated subset of the full theme:
 * enough to make the app theirs, not so much that every derived shade needs a
 * matching control. Overrides are applied as inline vars on :root, which beat
 * both the dark and light stylesheet rules, so a custom palette layers on top
 * of whichever base is active rather than replacing it.
 */
export const CUSTOMIZABLE_TOKENS = [
  'bg',
  'surface',
  'surface-raised',
  'border',
  'foreground',
  'muted',
  'primary',
  'primary-strong',
  'secondary',
  'error',
  'warn',
  'info',
  'ok',
] as const;

export type ThemeToken = (typeof CUSTOMIZABLE_TOKENS)[number];

export const TOKEN_LABELS: Record<ThemeToken, string> = {
  bg: 'Background',
  surface: 'Panels',
  'surface-raised': 'Inputs',
  border: 'Borders',
  foreground: 'Text',
  muted: 'Subtle text',
  primary: 'Accent',
  'primary-strong': 'Accent hover',
  secondary: 'Accent 2',
  error: 'Error',
  warn: 'Warning',
  info: 'Info',
  ok: 'Success',
};

/**
 * Per-message-bubble overrides, kept apart from the flat colour tokens because
 * each is a colour *plus* an opacity (so a self bubble can be a faint accent
 * wash, an other bubble a solid panel). Applied as the `--bubble-*` CSS vars the
 * message bubble reads; anything unset falls back to the CSS defaults in
 * index.css, which track the light/dark base.
 */
export interface BubbleTheme {
  selfBg?: string;
  selfBgOpacity?: number;
  selfBorder?: string;
  selfBorderOpacity?: number;
  otherBg?: string;
  otherBgOpacity?: number;
  otherBorder?: string;
  otherBorderOpacity?: number;
}

/**
 * Companions derived from a chosen accent so the whole button state tracks it:
 * the hover shade (primary-strong, unless the user set it explicitly) and the
 * readable text on top (primary-foreground / secondary-foreground). Without this,
 * changing the accent left the hover colour and button text on the default green.
 */
const DERIVED_TOKENS = ['primary-strong', 'primary-foreground', 'secondary-foreground'] as const;

function toRgb(hex: string): [number, number, number] | null {
  let hexDigits = hex.replace('#', '');
  if (hexDigits.length === 3) hexDigits = hexDigits.split('').map((char) => char + char).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hexDigits)) return null;
  return [
    parseInt(hexDigits.slice(0, 2), 16),
    parseInt(hexDigits.slice(2, 4), 16),
    parseInt(hexDigits.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  return (
    '#' +
    [r, g, b]
      .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function darken([r, g, b]: [number, number, number], amount: number): [number, number, number] {
  return [r * (1 - amount), g * (1 - amount), b * (1 - amount)];
}

/** Perceived brightness in [0, 1]; picks black-vs-white text on a fill. */
function luminance([r, g, b]: [number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** #rgb or #rrggbb. The native color input only ever emits the latter. */
export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** The four bubble vars, paired with their colour source field. */
const BUBBLE_VARS: {
  var: string;
  color: keyof BubbleTheme;
}[] = [
  { var: '--bubble-self-bg', color: 'selfBg' },
  { var: '--bubble-self-border', color: 'selfBorder' },
  { var: '--bubble-other-bg', color: 'otherBg' },
  { var: '--bubble-other-border', color: 'otherBorder' },
];

/**
 * Apply (or clear) the premium palette + bubble override.
 *
 * Idempotent and total over CUSTOMIZABLE_TOKENS and the bubble vars: any token
 * not present has its inline override removed, so disabling a custom theme or
 * dropping a single colour cleanly falls back to the base. Passing null for both
 * clears everything.
 */
export function applyCustomThemeVars(
  colors: Partial<Record<ThemeToken, string>> | null,
  bubbles?: BubbleTheme | null
): void {
  const root = document.documentElement;
  for (const token of CUSTOMIZABLE_TOKENS) {
    const value = colors?.[token];
    if (value && isHexColor(value)) {
      root.style.setProperty(`--color-${token}`, value);
    } else {
      root.style.removeProperty(`--color-${token}`);
    }
  }

  // Derived companions. Cleared first, then set only when their source is a
  // valid custom colour, so falling back to the base theme is clean. The hover
  // shade is only derived when the user did not set primary-strong themselves.
  for (const token of DERIVED_TOKENS) root.style.removeProperty(`--color-${token}`);

  const primaryRgb = colors?.primary && isHexColor(colors.primary) ? toRgb(colors.primary) : null;
  if (primaryRgb) {
    const explicitStrong = colors?.['primary-strong'];
    if (explicitStrong && isHexColor(explicitStrong)) {
      root.style.setProperty('--color-primary-strong', explicitStrong);
    } else {
      root.style.setProperty('--color-primary-strong', toHex(darken(primaryRgb, 0.16)));
    }
    root.style.setProperty(
      '--color-primary-foreground',
      luminance(primaryRgb) > 0.55 ? '#0a0f0c' : '#ffffff'
    );
  }

  const secondaryRgb =
    colors?.secondary && isHexColor(colors.secondary) ? toRgb(colors.secondary) : null;
  if (secondaryRgb) {
    root.style.setProperty(
      '--color-secondary-foreground',
      luminance(secondaryRgb) > 0.55 ? '#08131a' : '#ffffff'
    );
  }

  // Per-bubble colour. SOLID only — a bubble sits over the wallpaper (which can
  // be a video), so any translucency would let it bleed through. Opacity fields
  // that may exist on older saved themes are ignored; the colour is applied flat.
  for (const bubbleVar of BUBBLE_VARS) {
    const color = bubbles?.[bubbleVar.color] as string | undefined;
    if (color && isHexColor(color)) root.style.setProperty(bubbleVar.var, color);
    else root.style.removeProperty(bubbleVar.var);
  }
}
