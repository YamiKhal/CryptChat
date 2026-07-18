import { useEffect, useRef, useState, ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Crown, RotateCcw, Download, Upload } from 'lucide-react';
import { Vault } from '../lib/vault';
import {
  fileToAsset,
  BinaryAsset,
  base64UrlToBytes,
  bytesToDataUrl,
  bytesToBase64Url,
} from '../lib/binary';
import {
  CUSTOMIZABLE_TOKENS,
  TOKEN_LABELS,
  ThemeToken,
  BubbleTheme,
  isHexColor,
  applyCustomThemeVars,
} from '../lib/theme';
import { SettingsSection, SettingRow, SettingBlock } from './SettingsUI';
import { Toggle } from './Toggle';
import { InfoTip } from './InfoTip';

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
  const [bubbles, setBubbles] = useState<BubbleTheme>(prefs.customTheme?.bubbles ?? {});
  const [background, setBackground] = useState<BinaryAsset | undefined>(prefs.chatBackground);
  const [error, setError] = useState('');
  const bgInput = useRef<HTMLInputElement>(null);
  const themeInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Live preview: reflect the current palette + bubble overrides on the page as
  // they are edited.
  useEffect(() => {
    applyCustomThemeVars(enabled ? colors : null, enabled ? bubbles : null);
  }, [enabled, colors, bubbles]);

  function persist(next: { enabled: boolean; colors: Record<string, string>; bubbles: BubbleTheme }) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      vault
        .setPreferences({
          customTheme: { enabled: next.enabled, colors: next.colors, bubbles: next.bubbles },
        })
        .then(onChange)
        .catch((e) => setError((e as Error).message));
    }, 350);
  }

  function setToken(token: ThemeToken, value: string) {
    const next = { ...colors, [token]: value };
    setColors(next);
    persist({ enabled, colors: next, bubbles });
  }

  function setBubble(patch: Partial<BubbleTheme>) {
    const next = { ...bubbles, ...patch };
    setBubbles(next);
    persist({ enabled, colors, bubbles: next });
  }

  function toggleEnabled(next: boolean) {
    setEnabled(next);
    persist({ enabled: next, colors, bubbles });
  }

  function reset() {
    setColors({});
    setBubbles({});
    persist({ enabled, colors: {}, bubbles: {} });
  }

  /** Download the current palette + bubble overrides as a shareable JSON theme. */
  function exportTheme() {
    const payload = { version: 1, colors, bubbles };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `darkchat-theme-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Load a theme JSON, keeping only valid hex colours and sane opacities. */
  async function importTheme(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (themeInput.current) themeInput.current.value = '';
    if (!file) return;
    setError('');
    try {
      const parsed = JSON.parse(await file.text()) as {
        colors?: Record<string, string>;
        bubbles?: BubbleTheme;
      };

      const nextColors: Record<string, string> = {};
      for (const token of CUSTOMIZABLE_TOKENS) {
        const v = parsed.colors?.[token];
        if (typeof v === 'string' && isHexColor(v)) nextColors[token] = v;
      }

      const nextBubbles: BubbleTheme = {};
      const b = parsed.bubbles ?? {};
      const colorKeys = ['selfBg', 'selfBorder', 'otherBg', 'otherBorder'] as const;
      const opacityKeys = ['selfBgOpacity', 'selfBorderOpacity', 'otherBgOpacity', 'otherBorderOpacity'] as const;
      for (const k of colorKeys) {
        const v = b[k];
        if (typeof v === 'string' && isHexColor(v)) nextBubbles[k] = v;
      }
      for (const k of opacityKeys) {
        const v = b[k];
        if (typeof v === 'number' && v >= 0 && v <= 1) nextBubbles[k] = v;
      }

      setColors(nextColors);
      setBubbles(nextBubbles);
      setEnabled(true);
      persist({ enabled: true, colors: nextColors, bubbles: nextBubbles });
    } catch {
      setError('not a valid theme file');
    }
  }

  async function chooseBackground(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      // An animated GIF or a video must be kept as-is -- running it through the
      // canvas would flatten a GIF to one frame and cannot handle video at all.
      // These wallpapers are shown on this device only and never sent, so there
      // is no EXIF-broadcast concern to re-encode away.
      const animated = file.type === 'image/gif' || file.type.startsWith('video/');
      let asset: BinaryAsset;
      if (animated) {
        if (file.size > 8 * 1024 * 1024) {
          setError('An animated or video wallpaper must be under 8MB.');
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        asset = { mime: file.type, data: bytesToBase64Url(bytes) };
      } else {
        // Static images are re-encoded through canvas: EXIF (including GPS)
        // stripped, size bounded.
        asset = await fileToAsset(file, { maxDimension: 1600, mime: 'image/webp', quality: 0.82 });
      }
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
      <SettingsSection title="Custom theme">
        <SettingBlock>
          <p className="flex items-center gap-1.5 text-xs text-warn">
            <Crown size={13} className="fill-warn/25" aria-hidden="true" />
            Custom colours and chat wallpaper are a supporter perk.
          </p>
          <Link to="/subscribe" className="btn-ghost w-full text-xs">
            Become a supporter
          </Link>
        </SettingBlock>
      </SettingsSection>
    );
  }

  const bgUrl = assetToDataUrl(background);

  return (
    <SettingsSection
      title="Custom theme"
      info="Overrides sit on top of the light/dark base; anything untouched follows it."
      infoDetails="Your colour overrides sit on top of the current light/dark base. Anything you leave untouched follows the base theme, so toggling light/dark still works underneath."
    >
      <SettingRow
        title="Custom palette"
        description="Recolour on top of the base theme."
        control={
          <Toggle checked={enabled} onChange={toggleEnabled} label="Enable custom palette" />
        }
      />

      {enabled && (
        <SettingBlock>
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
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted">Message bubbles</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <BubbleControl
                label="Your bubble fill"
                color={bubbles.selfBg ?? seedColor(colors, 'primary')}
                opacity={bubbles.selfBgOpacity ?? 0.15}
                onColor={(v) => setBubble({ selfBg: v })}
                onOpacity={(v) => setBubble({ selfBgOpacity: v })}
              />
              <BubbleControl
                label="Your bubble border"
                color={bubbles.selfBorder ?? seedColor(colors, 'primary')}
                opacity={bubbles.selfBorderOpacity ?? 0.3}
                onColor={(v) => setBubble({ selfBorder: v })}
                onOpacity={(v) => setBubble({ selfBorderOpacity: v })}
              />
              <BubbleControl
                label="Others' bubble fill"
                color={bubbles.otherBg ?? seedColor(colors, 'surface-raised')}
                opacity={bubbles.otherBgOpacity ?? 1}
                onColor={(v) => setBubble({ otherBg: v })}
                onOpacity={(v) => setBubble({ otherBgOpacity: v })}
              />
              <BubbleControl
                label="Others' bubble border"
                color={bubbles.otherBorder ?? seedColor(colors, 'border')}
                opacity={bubbles.otherBorderOpacity ?? 1}
                onColor={(v) => setBubble({ otherBorder: v })}
                onOpacity={(v) => setBubble({ otherBorderOpacity: v })}
              />
            </div>
          </div>

          <button onClick={reset} className="btn-ghost w-full text-xs">
            <RotateCcw size={12} aria-hidden="true" />
            Reset colours to base
          </button>

          {/* Share a palette as a JSON file. Import validates before applying, so
              a hand-edited or hostile file cannot inject anything but colours. */}
          <input
            ref={themeInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={importTheme}
          />
          <div className="flex gap-2">
            <button onClick={exportTheme} className="btn-ghost flex-1 text-xs">
              <Download size={12} aria-hidden="true" />
              Export theme
            </button>
            <button onClick={() => themeInput.current?.click()} className="btn-ghost flex-1 text-xs">
              <Upload size={12} aria-hidden="true" />
              Import theme
            </button>
          </div>
        </SettingBlock>
      )}

      <SettingBlock>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">Chat wallpaper</span>
          <InfoTip
            title="Chat wallpaper"
            tip="Image, GIF, or MP4 — shown behind your messages on this device only."
            details="Shown behind your messages on this device only. Stored in your encrypted vault — the server never sees it. A still image, an animated GIF, or an MP4/WebM video all work; video loops and scales to fill. Message bubbles stay over a scrim so text is always readable."
          />
        </div>
        {bgUrl &&
          (background?.mime.startsWith('video/') ? (
            <video
              src={bgUrl}
              className="h-20 w-full rounded border border-border object-cover"
              autoPlay
              loop
              muted
              playsInline
              aria-label="Current chat wallpaper"
            />
          ) : (
            <div
              className="h-20 w-full rounded border border-border bg-cover bg-center"
              style={{ backgroundImage: `url(${bgUrl})` }}
              aria-label="Current chat wallpaper"
            />
          ))}
        <input
          ref={bgInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
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
        {error && <p className="text-[11px] text-error">{error}</p>}
      </SettingBlock>
    </SettingsSection>
  );
}

/** A colour swatch plus an opacity slider, for one bubble surface. */
function BubbleControl({
  label,
  color,
  opacity,
  onColor,
  onOpacity,
}: {
  label: string;
  color: string;
  opacity: number;
  onColor: (value: string) => void;
  onOpacity: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5 rounded border border-border bg-surface-raised p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px]">{label}</span>
        <input
          type="color"
          className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
          value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#000000'}
          onChange={(e) => onColor(e.target.value)}
          aria-label={`${label} colour`}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted">opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)}
          className="flex-1 accent-primary"
          aria-label={`${label} opacity`}
        />
        <span className="w-8 text-right text-[10px] tabular-nums text-muted">
          {Math.round(opacity * 100)}%
        </span>
      </div>
    </div>
  );
}
