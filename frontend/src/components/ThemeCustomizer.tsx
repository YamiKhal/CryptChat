import { useEffect, useRef, useState, ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Crown, RotateCcw } from 'lucide-react';
import { Vault } from '../lib/vault';
import { fileToAsset, BinaryAsset, base64UrlToBytes, bytesToDataUrl } from '../lib/binary';
import {
  CUSTOMIZABLE_TOKENS,
  TOKEN_LABELS,
  ThemeToken,
  applyCustomThemeVars,
} from '../lib/theme';

/**
 * Premium palette + wallpaper editor.
 *
 * Purely cosmetic, purely local. "Premium only" is a product perk gated here in
 * the UI; there is no server secret behind it, because a user recolouring their
 * own screen is nobody's threat. Non-premium users get an honest teaser rather
 * than a hidden control.
 *
 * Colours apply live (the native picker gives instant feedback) and persist to
 * the vault, debounced so dragging the picker does not reseal the vault on every
 * frame. The base light/dark toggle keeps working underneath: any token left
 * unset follows the base.
 */

interface Props {
  vault: Vault;
  isPremium: boolean;
  /** Re-read vault-backed state after a persist (session.refresh). */
  onChange: () => void;
}

/** The colour the picker should open on: an override if set, else the live base value. */
function seedColor(colors: Record<string, string>, token: ThemeToken): string {
  if (colors[token]) return colors[token];
  const computed = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-${token}`)
    .trim();
  // Pickers only accept #rrggbb; fall back to black if a token resolved to
  // something else (it never should, our tokens are all hex).
  return /^#[0-9a-fA-F]{6}$/.test(computed) ? computed : '#000000';
}

function assetToDataUrl(asset: BinaryAsset | undefined): string | undefined {
  if (!asset) return undefined;
  try {
    return bytesToDataUrl(base64UrlToBytes(asset.data), asset.mime);
  } catch {
    return undefined;
  }
}

export default function ThemeCustomizer({ vault, isPremium, onChange }: Props) {
  const prefs = vault.preferences;
  const [enabled, setEnabled] = useState(prefs.customTheme?.enabled ?? false);
  const [colors, setColors] = useState<Record<string, string>>(prefs.customTheme?.colors ?? {});
  const [background, setBackground] = useState<BinaryAsset | undefined>(prefs.chatBackground);
  const [error, setError] = useState('');
  const bgInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Live preview: reflect the current palette on the page as it is edited.
  useEffect(() => {
    applyCustomThemeVars(enabled ? colors : null);
  }, [enabled, colors]);

  function persist(next: { enabled: boolean; colors: Record<string, string> }) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      vault
        .setPreferences({ customTheme: { enabled: next.enabled, colors: next.colors } })
        .then(onChange)
        .catch((e) => setError((e as Error).message));
    }, 350);
  }

  function setToken(token: ThemeToken, value: string) {
    const next = { ...colors, [token]: value };
    setColors(next);
    persist({ enabled, colors: next });
  }

  function toggleEnabled(next: boolean) {
    setEnabled(next);
    persist({ enabled: next, colors });
  }

  function reset() {
    setColors({});
    persist({ enabled, colors: {} });
  }

  async function chooseBackground(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      // Re-encoded through canvas like every image here: EXIF (including GPS)
      // stripped, size bounded.
      const asset = await fileToAsset(file, { maxDimension: 1600, mime: 'image/webp', quality: 0.82 });
      setBackground(asset);
      await vault.setPreferences({ chatBackground: asset });
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeBackground() {
    setBackground(undefined);
    await vault.setPreferences({ chatBackground: undefined });
    onChange();
  }

  if (!isPremium) {
    return (
      <div className="space-y-2 rounded border border-warn/30 bg-warn/10 p-3">
        <p className="flex items-center gap-1.5 text-xs text-warn">
          <Crown size={13} className="fill-warn/25" aria-hidden="true" />
          Custom colours and chat wallpaper are a supporter perk.
        </p>
        <Link to="/subscribe" className="text-[11px] text-warn underline hover:no-underline">
          Become a supporter
        </Link>
      </div>
    );
  }

  const bgUrl = assetToDataUrl(background);

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
        />
        <span className="text-xs">
          Custom palette
          <span className="mt-1 block text-[11px] text-muted">
            Overrides sit on top of the {enabled ? 'current' : ''} light/dark base. Anything you
            leave untouched follows the base theme.
          </span>
        </span>
      </label>

      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {CUSTOMIZABLE_TOKENS.map((token) => (
              <label
                key={token}
                className="flex items-center gap-2 rounded border border-border bg-surface-raised px-2 py-1.5"
              >
                <input
                  type="color"
                  className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                  value={seedColor(colors, token)}
                  onChange={(e) => setToken(token, e.target.value)}
                  aria-label={TOKEN_LABELS[token]}
                />
                <span className="truncate text-[11px]">{TOKEN_LABELS[token]}</span>
              </label>
            ))}
          </div>
          <button onClick={reset} className="btn-ghost w-full text-xs">
            <RotateCcw size={12} aria-hidden="true" />
            Reset colours to base
          </button>
        </>
      )}

      <div className="space-y-2">
        <span className="text-xs text-muted">Chat wallpaper</span>
        {bgUrl && (
          <div
            className="h-20 w-full rounded border border-border bg-cover bg-center"
            style={{ backgroundImage: `url(${bgUrl})` }}
            aria-label="Current chat wallpaper"
          />
        )}
        <input
          ref={bgInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={chooseBackground}
        />
        <div className="flex gap-2">
          <button onClick={() => bgInput.current?.click()} className="btn-ghost flex-1 text-xs">
            {bgUrl ? 'change wallpaper' : 'choose wallpaper'}
          </button>
          {bgUrl && (
            <button onClick={removeBackground} className="btn-ghost text-xs text-error">
              remove
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted">
          Shown behind your messages on this device only. Stored in your encrypted vault — the
          server never sees it. Message bubbles stay solid so text is always readable.
        </p>
      </div>

      {error && <p className="text-[11px] text-error">{error}</p>}
    </div>
  );
}
