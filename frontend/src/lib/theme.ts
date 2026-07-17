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
  listeners.forEach((l) => l());
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
  'foreground',
  'muted',
  'primary',
  'secondary',
  'border',
] as const;

export type ThemeToken = (typeof CUSTOMIZABLE_TOKENS)[number];

export const TOKEN_LABELS: Record<ThemeToken, string> = {
  bg: 'Background',
  surface: 'Panels',
  'surface-raised': 'Inputs',
  foreground: 'Text',
  muted: 'Subtle text',
  primary: 'Accent',
  secondary: 'Accent 2',
  border: 'Borders',
};

/**
 * Companions derived from a chosen accent so the whole button state tracks it:
 * the hover shade (primary-strong) and the readable text on top
 * (primary-foreground / secondary-foreground). Without this, changing the accent
 * left the hover colour and button text on the default green.
 */
const DERIVED_TOKENS = ['primary-strong', 'primary-foreground', 'secondary-foreground'] as const;

function toRgb(hex: string): [number, number, number] | null {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return (
    '#' +
    [r, g, b]
      .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
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
export function isHexColor(v: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/**
 * Apply (or clear) the premium palette override.
 *
 * Idempotent and total over CUSTOMIZABLE_TOKENS: any token not present in
 * `colors` has its inline override removed, so disabling a custom theme or
 * dropping a single colour cleanly falls back to the base. Passing null clears
 * everything.
 */
export function applyCustomThemeVars(colors: Partial<Record<ThemeToken, string>> | null): void {
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
  // valid custom colour, so falling back to the base theme is clean.
  for (const t of DERIVED_TOKENS) root.style.removeProperty(`--color-${t}`);

  const primaryRgb = colors?.primary && isHexColor(colors.primary) ? toRgb(colors.primary) : null;
  if (primaryRgb) {
    root.style.setProperty('--color-primary-strong', toHex(darken(primaryRgb, 0.16)));
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
}
