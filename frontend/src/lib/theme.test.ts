import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTheme,
  setTheme,
  toggleTheme,
  applyTheme,
  isHexColor,
  applyCustomThemeVars,
} from './theme';

/**
 * Theme persistence.
 *
 * The one behaviour that must not regress: dark is the default for anything
 * unset. The pre-paint script in index.html relies on the same rule, so a light
 * flash on first load would mean these two drifted apart.
 */

// jsdom's localStorage is shadowed by Node's experimental (undefined) one in
// this setup, so stand up a minimal store. theme.ts degrades to dark without
// one; here we want to exercise the persistence path.
function installStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
}

describe('theme', () => {
  beforeEach(() => {
    installStorage();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to dark when nothing is stored', () => {
    expect(getTheme()).toBe('dark');
  });

  it('defaults to dark for an unrecognised stored value', () => {
    localStorage.setItem('cryptchat.theme', 'chartreuse');
    expect(getTheme()).toBe('dark');
  });

  it('persists and reflects a set theme', () => {
    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(localStorage.getItem('cryptchat.theme')).toBe('light');
  });

  it('stamps the attribute the CSS keys off', () => {
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applyTheme sets the attribute without persisting', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('cryptchat.theme')).toBeNull();
  });

  it('toggles dark -> light -> dark', () => {
    expect(getTheme()).toBe('dark');
    expect(toggleTheme()).toBe('light');
    expect(getTheme()).toBe('light');
    expect(toggleTheme()).toBe('dark');
    expect(getTheme()).toBe('dark');
  });
});

describe('custom palette', () => {
  beforeEach(() => {
    applyCustomThemeVars(null);
  });

  it('accepts #rgb and #rrggbb, rejects anything else', () => {
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#00ff85')).toBe(true);
    expect(isHexColor('00ff85')).toBe(false);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#12')).toBe(false);
    expect(isHexColor('rgb(0,0,0)')).toBe(false);
  });

  it('sets inline vars for provided tokens', () => {
    applyCustomThemeVars({ primary: '#ff00aa', bg: '#111111' });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-primary')).toBe('#ff00aa');
    expect(root.style.getPropertyValue('--color-bg')).toBe('#111111');
  });

  it('ignores non-hex values instead of writing garbage vars', () => {
    applyCustomThemeVars({ primary: 'javascript:alert(1)' });
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('');
  });

  it('clears tokens not present in the next apply (total over the token set)', () => {
    applyCustomThemeVars({ primary: '#ff00aa' });
    applyCustomThemeVars({ bg: '#222222' });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-primary')).toBe('');
    expect(root.style.getPropertyValue('--color-bg')).toBe('#222222');
  });

  it('null clears everything', () => {
    applyCustomThemeVars({ primary: '#ff00aa', secondary: '#00aaff' });
    applyCustomThemeVars(null);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-primary')).toBe('');
    expect(root.style.getPropertyValue('--color-secondary')).toBe('');
  });

  it('derives a hover shade and readable text from a custom accent', () => {
    applyCustomThemeVars({ primary: '#3366ff' });
    const root = document.documentElement;
    // A distinct, darker hover shade — not left on the base green.
    const strong = root.style.getPropertyValue('--color-primary-strong');
    expect(strong).toMatch(/^#[0-9a-f]{6}$/);
    expect(strong).not.toBe('#3366ff');
    // A dark accent gets white text on top.
    expect(root.style.getPropertyValue('--color-primary-foreground')).toBe('#ffffff');
  });

  it('puts dark text on a light accent', () => {
    applyCustomThemeVars({ primary: '#ffe066' });
    expect(document.documentElement.style.getPropertyValue('--color-primary-foreground')).toBe(
      '#0a0f0c'
    );
  });

  it('clears the derived companions when the accent is removed', () => {
    applyCustomThemeVars({ primary: '#3366ff' });
    applyCustomThemeVars({ bg: '#111111' });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-primary-strong')).toBe('');
    expect(root.style.getPropertyValue('--color-primary-foreground')).toBe('');
  });
});
