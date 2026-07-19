import { useState, useEffect, useRef, ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  User,
  Palette,
  Volume2,
  Play,
  Upload,
  X,
  ShieldCheck,
  CreditCard,
  KeyRound,
  AlertTriangle,
  LogOut,
  ArrowLeft,
} from 'lucide-react';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import {
  fileToAsset,
  BinaryAsset,
  base64UrlToBytes,
  bytesToDataUrl,
  bytesToBase64Url,
} from '../lib/binary';
import {
  exportKeyBundle,
  importKeyBundle,
  keyFingerprint,
  EncryptedBundle,
} from '../lib/crypto';
import { saveAccount, Vault, ChatTextSize } from '../lib/vault';
import { api, EmailState, Badge as BadgeState } from '../lib/api';
import Avatar from '../components/Avatar';
import Badge from '../components/Badge';
import SubscriptionSection from '../components/SubscriptionSection';
import ThemeToggle from '../components/ThemeToggle';
import ThemeCustomizer from '../components/ThemeCustomizer';
import TwoFactorSection from '../components/TwoFactorSection';
import { Toggle } from '../components/Toggle';
import { InfoTip } from '../components/InfoTip';
import { SettingsSection, SettingRow, SegmentedControl, SettingBlock } from '../components/SettingsUI';
import AccountBar from '../components/AccountBar';
import { LogoutConfirmModal } from '../components/LogoutConfirmModal';
import {
  SoundSettings,
  DEFAULT_SOUND_SETTINGS,
  configureSounds,
  configureCustomSounds,
  previewSound,
  type SoundEvent,
} from '../lib/sounds';

// The device locale's own clock convention, used as the default before the user
// makes an explicit choice (so the toggle starts on whatever the locale shows).
const LOCALE_HOUR12 =
  new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 ?? false;

const TEXT_SIZE_OPTIONS: { value: ChatTextSize; label: string }[] = [
  { value: 'tiny', label: 'Tiny' },
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
];

type TabId = 'profile' | 'appearance' | 'sounds' | 'account' | 'billing' | 'keys' | 'danger';

const TABS: { id: TabId; label: string; icon: typeof User }[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'sounds', label: 'Sounds', icon: Volume2 },
  { id: 'account', label: 'Account', icon: ShieldCheck },
  { id: 'billing', label: 'Subscription', icon: CreditCard },
  { id: 'keys', label: 'Keys & devices', icon: KeyRound },
  { id: 'danger', label: 'Danger zone', icon: AlertTriangle },
];

export default function Settings() {
  const session = useSession();
  const { vault, account } = session;
  const { broadcastProfileEverywhere } = useRelayContext();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState<BinaryAsset | undefined>();
  const [bio, setBio] = useState('');
  const [background, setBackground] = useState<BinaryAsset | undefined>();
  const [fingerprint, setFingerprint] = useState('');
  const [alwaysPreview, setAlwaysPreview] = useState(false);
  const [showBadge, setShowBadge] = useState(false);
  const [leftAligned, setLeftAligned] = useState(false);
  const [textSize, setTextSize] = useState<ChatTextSize>('normal');
  const [hideImages, setHideImages] = useState(false);
  const [hideBubbles, setHideBubbles] = useState(false);
  const [clock12h, setClock12h] = useState(false);
  const [sound, setSound] = useState<SoundSettings>(DEFAULT_SOUND_SETTINGS);
  const [customSounds, setCustomSounds] = useState<Partial<Record<SoundEvent, BinaryAsset>>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Active category. null = the category list itself, which is the mobile
  // landing view; desktop shows both panes and uses it for the empty hint.
  const [tab, setTab] = useState<TabId | null>(null);
  // The sections currently rendered in the active tab, read from the DOM so the
  // sidebar's quick-jump list stays in step with conditionally-shown sections
  // (supporter badge, loaded 2FA keys). {id, title} per SettingsSection.
  const [subSections, setSubSections] = useState<{ id: string; title: string }[]>([]);

  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<EncryptedBundle | null>(null);
  const [importPassword, setImportPassword] = useState('');

  // null = not loaded yet, distinct from "loaded and there is no address".
  const [email, setEmail] = useState<EmailState | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [badge, setBadge] = useState<BadgeState | null>(null);
  // Stripe's hosted portal login page: the only route to cancelling, since we
  // hold no customer id to cancel with.
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [showLogout, setShowLogout] = useState(false);

  // The scrolling pane that holds the active tab's sections; the sidebar reads
  // its section markers and scrolls it when a quick-jump item is clicked.
  const contentRef = useRef<HTMLDivElement>(null);

  const avatarInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  // One hidden file input shared by every sound row; the pending event says which
  // cue the chosen file belongs to.
  const soundFileInput = useRef<HTMLInputElement>(null);
  const pendingSoundEvent = useRef<SoundEvent | null>(null);

  useEffect(() => {
    if (!vault) return;
    setDisplayName(vault.profile.displayName);
    setAvatar(vault.profile.avatar);
    setBio(vault.profile.bio ?? '');
    setBackground(vault.profile.background);
    setAlwaysPreview(vault.preferences.alwaysPreviewLinks);
    setShowBadge(Boolean(vault.preferences.showSupporterBadge));
    setLeftAligned(Boolean(vault.preferences.messagesLeftAligned));
    setTextSize(vault.preferences.chatTextSize ?? 'normal');
    setHideImages(Boolean(vault.preferences.hideProfileImages));
    setHideBubbles(Boolean(vault.preferences.hideMessageBubbles));
    setClock12h(vault.preferences.clock12h ?? LOCALE_HOUR12);
    setSound({ ...DEFAULT_SOUND_SETTINGS, ...(vault.preferences.sound ?? {}) });
    setCustomSounds(vault.preferences.customSounds ?? {});
    keyFingerprint(vault.identity.signPublicKey).then(setFingerprint);
  }, [vault]);

  // Account-layer state lives on the server, not in the vault, so it is fetched
  // rather than read locally. Failures are left silent: this is supplementary
  // information and an unreachable billing endpoint should not present itself as
  // a broken settings page.
  useEffect(() => {
    if (!session.token) return;
    let cancelled = false;

    api
      .getEmail(session.token)
      .then((res) => !cancelled && setEmail(res))
      .catch(() => !cancelled && setEmail({ mask: null, verified: false }));

    api
      .billingStatus(session.token)
      .then((res) => {
        if (cancelled) return;
        setBadge(res.badge);
        setPortalUrl(res.portalUrl);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [session.token]);

  // Keep the sidebar's quick-jump list in step with what the active tab actually
  // renders. A MutationObserver catches sections that mount late (the supporter
  // badge once billing resolves, the 2FA list once it loads) without a poll.
  useEffect(() => {
    const el = contentRef.current;
    if (!tab || !el) {
      setSubSections([]);
      return;
    }
    const collect = () => {
      const nodes = el.querySelectorAll<HTMLElement>('[data-settings-section]');
      const next = Array.from(nodes).map((n) => ({ id: n.id, title: n.dataset.title ?? '' }));
      setSubSections((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id) ? prev : next
      );
    };
    collect();
    const observer = new MutationObserver(collect);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tab]);

  function jumpToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (!vault || !account) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="card space-y-3 text-center">
          <p className="t-h4">Unlock your vault to change settings.</p>
          <Link to="/" className="btn-ghost">
            Unlock
          </Link>
        </div>
      </div>
    );
  }

  async function handleAvatar(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      // Square-cropped, downscaled, re-encoded to WebP. The re-encode is what
      // strips EXIF -- an unmodified phone photo carries GPS coordinates, and
      // an avatar is broadcast to every channel member.
      const asset = await fileToAsset(file, {
        maxDimension: 256,
        square: true,
        mime: 'image/webp',
        quality: 0.85,
      });
      setAvatar(asset);
      setStatus({ kind: 'info', text: 'Avatar ready. Save to apply.' });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleBackground(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      // A wider banner than the avatar, but the same EXIF-stripping re-encode.
      // Broadcast to channel members like the rest of the profile, so metadata
      // must not ride along. Kept modest (640px / q0.7): the banner shares the
      // profile envelope with the avatar and must stay well under the 256KB cap,
      // and it is only ever shown as a small header strip.
      const asset = await fileToAsset(file, {
        maxDimension: 640,
        mime: 'image/webp',
        quality: 0.7,
      });
      setBackground(asset);
      setStatus({ kind: 'info', text: 'Banner ready. Save to apply.' });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  // Applied immediately rather than on Save: a privacy toggle should never sit
  // in a state the user thinks is active but is not yet persisted.
  async function handlePreviewToggle(next: boolean) {
    setAlwaysPreview(next);
    try {
      await vault!.setPreferences({ alwaysPreviewLinks: next });
      session.refresh();
    } catch (err) {
      setAlwaysPreview(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleToggleShowBadge(next: boolean) {
    setShowBadge(next);
    try {
      await vault!.setPreferences({ showSupporterBadge: next });
      session.refresh();
    } catch (err) {
      setShowBadge(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSetLeftAligned(next: boolean) {
    setLeftAligned(next);
    try {
      await vault!.setPreferences({ messagesLeftAligned: next });
      session.refresh();
    } catch (err) {
      setLeftAligned(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSetTextSize(next: ChatTextSize) {
    const prev = textSize;
    setTextSize(next);
    try {
      await vault!.setPreferences({ chatTextSize: next });
      session.refresh();
    } catch (err) {
      setTextSize(prev);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSetHideImages(next: boolean) {
    setHideImages(next);
    try {
      await vault!.setPreferences({ hideProfileImages: next });
      session.refresh();
    } catch (err) {
      setHideImages(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSetHideBubbles(next: boolean) {
    setHideBubbles(next);
    try {
      await vault!.setPreferences({ hideMessageBubbles: next });
      session.refresh();
    } catch (err) {
      setHideBubbles(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSetClock12h(next: boolean) {
    setClock12h(next);
    try {
      await vault!.setPreferences({ clock12h: next });
      session.refresh();
    } catch (err) {
      setClock12h(!next);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  // Sound cues apply the instant they change (so a toggle is audible right away)
  // and persist to the local vault. The engine is reconfigured immediately rather
  // than waiting for the relay layer's effect, so a test press reflects the new
  // setting without a round-trip.
  async function updateSound(patch: Partial<SoundSettings>) {
    const prev = sound;
    const next = { ...sound, ...patch };
    setSound(next);
    configureSounds(next);
    try {
      await vault!.setPreferences({ sound: next });
      session.refresh();
    } catch (err) {
      setSound(prev);
      configureSounds(prev);
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  function pickCustomSound(event: SoundEvent) {
    pendingSoundEvent.current = event;
    soundFileInput.current?.click();
  }

  // Store the chosen audio file raw (no re-encode) as a small vault asset, then
  // reinstall it in the engine so a test press plays it right away.
  async function handleCustomSoundFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const event = pendingSoundEvent.current;
    if (soundFileInput.current) soundFileInput.current.value = '';
    pendingSoundEvent.current = null;
    if (!file || !event) return;
    // Kept small: the whole vault is re-sealed on save, and these live in local
    // storage alongside everything else.
    if (file.size > 1024 * 1024) {
      setStatus({ kind: 'error', text: 'Sound file must be under 1MB.' });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const asset: BinaryAsset = {
        mime: file.type || 'audio/mpeg',
        data: bytesToBase64Url(bytes),
      };
      const next = { ...customSounds, [event]: asset };
      setCustomSounds(next);
      configureCustomSounds(next);
      await vault!.setPreferences({ customSounds: next });
      session.refresh();
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function clearCustomSound(event: SoundEvent) {
    const next = { ...customSounds };
    delete next[event];
    setCustomSounds(next);
    configureCustomSounds(next);
    try {
      await vault!.setPreferences({ customSounds: next });
      session.refresh();
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    }
  }

  async function handleSaveProfile() {
    if (!displayName.trim()) {
      setStatus({ kind: 'error', text: 'display name cannot be empty' });
      return;
    }
    setBusy(true);
    try {
      await vault!.setProfile({
        displayName: displayName.trim(),
        avatar,
        bio: bio.trim() || undefined,
        background,
      });
      // Peers only know a name if it is sent to them, encrypted and signed.
      await broadcastProfileEverywhere();
      session.refresh();
      setStatus({ kind: 'ok', text: 'Profile saved and sent to your channels.' });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleSetEmail() {
    setStatus(null);
    setBusy(true);
    try {
      const res = await api.setEmail(session.token!, emailInput.trim(), emailPassword);
      setEmail((e) => ({ ...(e ?? { mask: null, verified: false }), pendingMask: res.pendingMask }));
      setEmailInput('');
      setEmailPassword('');
      setStatus({
        kind: 'ok',
        text: 'Confirmation link sent. The address is not attached until you use it.',
      });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveEmail() {
    setStatus(null);
    // Losing the address means losing password reset entirely, and the recovery
    // code alone cannot get you back in -- worth one confirmation.
    if (
      !confirm(
        'Remove your email?\n\nYou will no longer be able to reset a forgotten password. Your recovery code alone cannot log you in.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.removeEmail(session.token!, emailPassword);
      setEmail({ mask: null, verified: false });
      setEmailPassword('');
      setStatus({ kind: 'ok', text: 'Address removed. The stored ciphertext is gone.' });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleRedeem() {
    setStatus(null);
    setBusy(true);
    try {
      const res = await api.redeem(session.token!, redeemCode.trim());
      setBadge(res.badge);
      setRedeemCode('');

      const months = res.redeemed.months ?? 0;
      const period = months === 1 ? '1 month' : `${months} months`;

      // "Redeemed!" with an unchanged expiry date reads as a bug. Say where the
      // months went.
      setStatus({
        kind: 'ok',
        text: res.redeemed.parked
          ? `${period} banked. They start when your current subscription stops renewing — you will not pay for gifted time.`
          : 'Badge activated.',
      });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    setStatus(null);
    if (exportPassphrase.length < 12) {
      setStatus({ kind: 'error', text: 'export passphrase must be at least 12 characters' });
      return;
    }
    setBusy(true);
    try {
      const data = vault!.snapshot();
      const bundle = await exportKeyBundle(
        {
          userId: account!.userId,
          identity: data.identity,
          channels: Object.values(data.channels)
            .filter((c) => c.hasKey)
            .map((c) => ({ channelId: c.channelId, code: c.code, key: c.key })),
        },
        exportPassphrase
      );

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `darkchat-keys-${account!.username}-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);

      setExportPassphrase('');
      setStatus({
        kind: 'ok',
        text: 'Key file downloaded. It is encrypted — the passphrase is the only way in.',
      });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleBundleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    try {
      setImportFile(JSON.parse(await file.text()) as EncryptedBundle);
      setStatus({ kind: 'info', text: 'Key file loaded. Enter its passphrase to import.' });
    } catch {
      setStatus({ kind: 'error', text: 'not a valid key file' });
    }
  }

  /**
   * Import keys from another device.
   *
   * Rebuilds this device's vault from the bundle. The account password is
   * needed too: the bundle passphrase only opens the file, while the vault on
   * *this* device is keyed from the account password.
   */
  async function handleImport() {
    setStatus(null);
    setBusy(true);
    try {
      if (!importFile) throw new Error('choose a key file first');

      const bundle = await importKeyBundle(importFile, importPassphrase);

      if (bundle.userId !== account!.userId) {
        throw new Error('this key file belongs to a different identity');
      }

      const existing = vault!.snapshot();
      const channels = { ...existing.channels };
      for (const channel of bundle.channels) {
        channels[channel.channelId] = {
          channelId: channel.channelId,
          code: channel.code,
          key: channel.key,
          hasKey: true,
          joinedAt: existing.channels[channel.channelId]?.joinedAt ?? new Date().toISOString(),
        };
      }

      const rebuilt = await Vault.create(account!.userId, importPassword, {
        identity: bundle.identity,
        channels,
        contacts: existing.contacts,
        profile: existing.profile,
      });
      await rebuilt.rememberForSession();

      saveAccount({
        ...account!,
        publicKey: bundle.identity.publicKey,
        signPublicKey: bundle.identity.signPublicKey,
        vaultSalt: bundle.identity.vaultSalt,
        lastUsedAt: new Date().toISOString(),
      });

      setImportFile(null);
      setImportPassphrase('');
      setImportPassword('');
      setStatus({ kind: 'ok', text: `Imported ${bundle.channels.length} channel key(s). Reloading…` });

      // Cheapest correct way to rebind every consumer to the rebuilt vault.
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function handleForget() {
    const ok = confirm(
      `Permanently delete "${account!.username}" from this device?\n\n` +
        'Private keys, channel keys, and all decrypted messages are erased. ' +
        'Without an exported key file this cannot be undone — the server does not have your keys.'
    );
    if (!ok) return;
    session.removeAccount(account!.userId);
    navigate('/');
  }

  const statusStyles = {
    ok: 'border-primary-line bg-primary-soft text-primary',
    error: 'border-error-line bg-error-soft text-error',
    info: 'border-info-line bg-info-soft text-info',
  } as const;

  const activeTab = TABS.find((t) => t.id === tab);

  // Current wallpaper as a data URL, so the preview can show it behind the
  // sample messages. Reads straight from the vault, which ThemeCustomizer
  // persists to; session.refresh re-renders this after a change.
  const wallpaperAsset = vault.preferences.chatBackground;
  const wallpaperUrl = wallpaperAsset
    ? bytesToDataUrl(base64UrlToBytes(wallpaperAsset.data), wallpaperAsset.mime)
    : undefined;

  return (
    <div className="flex h-full">
      {/* category list — the left column, mirroring the channel list. On mobile
          it is the whole screen until a category is chosen. */}
      <aside
        className={`w-full flex-col border-r border-border lg:flex lg:w-85 lg:shrink-0 ${
          tab ? 'hidden lg:flex' : 'flex'
        }`}
      >
        <div className="flex h-14.25 shrink-0 items-center gap-3 border-b border-border px-3">
          <Link
            to="/channels"
            className="text-muted transition-colors hover:text-primary"
            aria-label="Back to channels"
          >
            <ArrowLeft size={18}/>
          </Link>
          <h1 className="flex-1 t-h4 font-semibold uppercase tracking-wider">settings</h1>
          <ThemeToggle />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {TABS.map((t) => (
            <div key={t.id}>
              <button
                onClick={() => setTab(t.id)}
                className={`flex w-full items-center cursor-pointer gap-3 rounded-lg px-3 py-2 text-left t-h4 transition-colors ${
                  tab === t.id
                    ? 'bg-primary-soft text-primary'
                    : t.id === 'danger'
                      ? 'text-error hover:bg-error-soft'
                      : 'text-foreground hover:bg-surface-raised'
                }`}
              >
                <t.icon size={16} className="flex-none" />
                {t.label}
              </button>
              {/* Quick-jump to the sections within the open tab. Expands downward
                  when the tab opens and collapses when another is chosen; hidden
                  entirely for tabs with a single section. */}
              {tab === t.id && subSections.length > 1 && (
                <SubNav items={subSections} onJump={jumpToSection} />
              )}
            </div>
          ))}
        </nav>
        {/* A wide, always-visible log-out at the foot of the category list, on
            top of the account-bar menu. Confirmed before it fires. */}
        <div className="shrink-0 p-2">
          <button
            onClick={() => setShowLogout(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border
                       px-4 py-2 t-base font-medium text-muted transition-colors
                       hover:border-error-line hover:bg-error-soft hover:text-error"
          >
            <LogOut size={15} />
            Log out
          </button>
        </div>
        <AccountBar />
      </aside>

      {/* active category — the right pane, mirroring the chat panel. */}
      <main className={`min-w-0 flex-1 flex-col ${tab ? 'flex' : 'hidden lg:flex'}`}>
        <div className="flex h-14.25 shrink-0 items-center gap-3 border-b border-border px-4">
          <button
            onClick={() => setTab(null)}
            className="text-muted transition-colors hover:text-primary lg:hidden"
            aria-label="Back to settings"
          >
            ←
          </button>
          <h2 className="t-h4 font-semibold uppercase tracking-wider">
            {activeTab?.label ?? 'settings'}
          </h2>
        </div>

        {tab === null ? (
          <div className="grid h-full place-items-center p-6 text-center text-muted">
            <p className="t-h4">Select a settings category.</p>
          </div>
        ) : (
          <div
            ref={contentRef}
            className="mx-auto w-full max-w-2xl flex-1 space-y-6 overflow-y-auto p-4 lg:p-6"
          >
            {status && (
              <p className={`rounded border p-4 t-base ${statusStyles[status.kind]}`}>
                {status.text}
              </p>
            )}

            {tab === 'profile' && (
              <div className="space-y-8">
                <SettingsSection
                  title="Profile"
                  info="Only channel members see this — never the server."
                  infoDetails="Your name, picture, bio, and banner are encrypted and signed, then sent only to members of channels you are in. The server stores none of it — it only ever holds a hash of your username."
                >
                  <SettingBlock>
                    <div className="flex items-center gap-4">
                      <Avatar asset={avatar} name={displayName || account.username} size="lg" />
                      <div className="space-y-2">
                        <input
                          ref={avatarInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={handleAvatar}
                        />
                        <button
                          onClick={() => avatarInput.current?.click()}
                          className="btn-ghost t-base"
                        >
                          choose image
                        </button>
                        {avatar && (
                          <button
                            onClick={() => setAvatar(undefined)}
                            className="block t-base text-muted hover:text-error"
                          >
                            remove
                          </button>
                        )}
                      </div>
                    </div>
                  </SettingBlock>

                  <SettingBlock>
                    <label className="block space-y-1">
                      <span className="t-base text-muted">display name</span>
                      <input
                        className="field"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        maxLength={48}
                      />
                    </label>
                  </SettingBlock>

                  <SettingBlock>
                    <label className="block space-y-1">
                      <span className="t-base text-muted">bio</span>
                      <textarea
                        className="field min-h-20 resize-y"
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        maxLength={500}
                        placeholder="A few words about you. Links: [my site](https://example.com)"
                      />
                      <span className="t-small text-muted">
                        {bio.length}/500 — wrap a link as [label](https://…)
                      </span>
                    </label>
                  </SettingBlock>

                  <SettingBlock>
                    <span className="t-base text-muted">profile banner</span>
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-24 shrink-0 overflow-hidden rounded border border-border bg-surface-raised">
                        {background && (
                          <img
                            src={bytesToDataUrl(base64UrlToBytes(background.data), background.mime)}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        )}
                      </div>
                      <div className="space-y-1">
                        <input
                          ref={backgroundInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={handleBackground}
                        />
                        <button
                          onClick={() => backgroundInput.current?.click()}
                          className="btn-ghost t-base"
                        >
                          choose banner
                        </button>
                        {background && (
                          <button
                            onClick={() => setBackground(undefined)}
                            className="block t-base text-muted hover:text-error"
                          >
                            remove
                          </button>
                        )}
                      </div>
                    </div>
                  </SettingBlock>
                </SettingsSection>

                <button onClick={handleSaveProfile} disabled={busy} className="btn-primary w-full">
                  Save profile
                </button>
              </div>
            )}

            {tab === 'appearance' && (
              <div className="space-y-8">
                {/* Live preview. Reflects text size and the picture / column
                    choices, the custom palette (which applies to the page's CSS
                    tokens live), a set wallpaper, and the supporter crown. */}
                <ChatPreview
                  size={textSize}
                  hideImages={hideImages}
                  hideBubbles={hideBubbles}
                  hour12={clock12h}
                  leftAligned={leftAligned}
                  wallpaper={wallpaperUrl}
                  supporter={showBadge && Boolean(badge)}
                />

                <SettingsSection
                  title="Theme"
                  info="Theme is stored only on this device; the server never sees it."
                  infoDetails="Your theme choice is stored only on this device — the server never sees it. Dark is the default."
                >
                  <SettingRow title="Light / dark" control={<ThemeToggle />} />
                </SettingsSection>

                <ThemeCustomizer vault={vault} isPremium={!!badge} onChange={session.refresh} />

                <SettingsSection title="Messages">
                  <SettingRow
                    title="Text size"
                    info="How large message text is drawn. Scales further on desktop."
                    infoDetails="Sets the size of message text throughout your chats. Each preset renders a little larger on a desktop screen than on a phone, so the same choice stays comfortable on both. This is a local display preference and changes nothing about what you send."
                  >
                    <div className="pt-1">
                      <SegmentedControl
                        value={textSize}
                        options={TEXT_SIZE_OPTIONS}
                        onChange={handleSetTextSize}
                      />
                    </div>
                  </SettingRow>

                  <SettingRow
                    title="Time format"
                    info="How message timestamps are written. Local display only."
                    infoDetails="Switches message timestamps between 24-hour (15:05) and 12-hour (3:05 PM). Defaults to your device's own convention until you choose. A local display preference — it changes nothing about what you send."
                  >
                    <div className="pt-1">
                      <SegmentedControl
                        value={clock12h ? '12' : '24'}
                        options={[
                          { value: '24', label: '24h' },
                          { value: '12', label: '12h' },
                        ]}
                        onChange={(v) => handleSetClock12h(v === '12')}
                      />
                    </div>
                  </SettingRow>

                  <SettingRow
                    title="Profile pictures"
                    description="Show avatars beside messages."
                    info="Hide avatars to show names alone, a denser transcript."
                    control={
                      <Toggle
                        checked={!hideImages}
                        onChange={(next) => handleSetHideImages(!next)}
                        label="Show profile pictures"
                      />
                    }
                  />

                  <SettingRow
                    title="Message bubbles"
                    description="Wrap messages in a coloured bubble."
                    info="Turn off for a flat, IRC-style transcript with no bubble behind the text."
                    infoDetails="With bubbles off, message text sits directly on the chat background with no fill, border, or tail. Spacing and alignment are unchanged — only the bubble's paint is dropped. A purely local display choice."
                    control={
                      <Toggle
                        checked={!hideBubbles}
                        onChange={(next) => handleSetHideBubbles(!next)}
                        label="Show message bubbles"
                      />
                    }
                  />

                  <SettingRow
                    title="Single column"
                    description="Discord-style — every message on the left."
                    info="Lay every message on the left, yours included, each under its own name."
                    infoDetails="By default your own messages sit on the right and everyone else's on the left. Single column lays them all on the left, each under its own name and picture, like Discord. Purely a local display choice."
                    control={
                      <Toggle
                        checked={leftAligned}
                        onChange={handleSetLeftAligned}
                        label="Single column layout"
                      />
                    }
                  />
                </SettingsSection>

                {/* Supporter-badge visibility — a display choice, so it lives with
                    the rest of them. Only a supporter has a crown to show. */}
                {badge && (
                  <SettingsSection title="Supporter badge">
                    <SettingRow
                      title="Show my crown to others"
                      description="A supporter crown on your messages. Off by default."
                      info="A personal flourish — not proof of payment, and never shown in incognito."
                      infoDetails="When on, a supporter crown appears on your messages for others. It is a personal flourish, not proof of payment — anyone's client can display one — and it is never shown in incognito channels. Paid status is a detail about you, so sharing it is your choice."
                      control={
                        <Toggle
                          checked={showBadge}
                          onChange={handleToggleShowBadge}
                          label="Show supporter crown"
                        />
                      }
                    />
                  </SettingsSection>
                )}

                <SettingsSection title="Links">
                  <SettingRow
                    title="Always preview links"
                    description="Off by default. Prefix a link with ! to preview just that one."
                    info="Turning this on asks the server to fetch every link you send."
                    infoDetails="Building a preview asks the server to fetch that URL, so the relay learns which link you sent — the one thing it otherwise never sees. The preview itself is encrypted and sent with your message, so people reading it never load anything and their IP stays private. Links always work as plain clickable text with this off."
                    control={
                      <Toggle
                        checked={alwaysPreview}
                        onChange={handlePreviewToggle}
                        label="Always preview links"
                      />
                    }
                  />
                </SettingsSection>
              </div>
            )}

            {tab === 'sounds' && (
              <div className="space-y-8">
                <SettingsSection
                  title="Sounds"
                  info="Generated on this device and never sent anywhere."
                  infoDetails="Every cue is synthesized in your browser — no audio is downloaded and nothing about it leaves the device. These settings are stored locally, like the rest of your display preferences."
                >
                  <SettingRow
                    title="Enable sounds"
                    description="Master switch for every cue below."
                    control={
                      <Toggle
                        checked={sound.enabled}
                        onChange={(v) => updateSound({ enabled: v })}
                        label="Enable sounds"
                      />
                    }
                  />
                  <SettingBlock>
                    <div className="flex items-center gap-3">
                      <span className="t-h4 text-foreground">Volume</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(sound.volume * 100)}
                        disabled={!sound.enabled}
                        onChange={(e) => updateSound({ volume: Number(e.target.value) / 100 })}
                        className="flex-1 accent-primary disabled:opacity-50"
                        aria-label="Sound volume"
                      />
                      <span className="w-9 text-right t-base tabular-nums text-muted">
                        {Math.round(sound.volume * 100)}%
                      </span>
                    </div>
                  </SettingBlock>
                </SettingsSection>

                <SettingsSection
                  title="When to play"
                  description="Press ▶ to hear a cue, ⬆ to use your own file, and the switch to turn it on or off."
                >
                  <SoundRow
                    title="Message from another chat"
                    description="A new message in a channel you do not have open."
                    event="message-in"
                    checked={sound.messageReceived}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageReceived: v })}
                    hasCustom={Boolean(customSounds['message-in'])}
                    onPickCustom={() => pickCustomSound('message-in')}
                    onClearCustom={() => clearCustomSound('message-in')}
                  />
                  <SoundRow
                    title="Message in the open chat"
                    description="Also chime for messages in the chat you are reading."
                    event="message-in-active"
                    checked={sound.messageInActiveChat}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageInActiveChat: v })}
                    hasCustom={Boolean(customSounds['message-in-active'])}
                    onPickCustom={() => pickCustomSound('message-in-active')}
                    onClearCustom={() => clearCustomSound('message-in-active')}
                  />
                  <SoundRow
                    title="Message sent"
                    description="A soft blip when your own message goes out."
                    event="message-sent"
                    checked={sound.messageSent}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageSent: v })}
                    hasCustom={Boolean(customSounds['message-sent'])}
                    onPickCustom={() => pickCustomSound('message-sent')}
                    onClearCustom={() => clearCustomSound('message-sent')}
                  />
                  <SoundRow
                    title="Calls"
                    description="Ring on incoming and outgoing calls. A custom file loops as the ringtone."
                    event="call-incoming"
                    checked={sound.calls}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ calls: v })}
                    hasCustom={Boolean(customSounds['call-incoming'])}
                    onPickCustom={() => pickCustomSound('call-incoming')}
                    onClearCustom={() => clearCustomSound('call-incoming')}
                  />
                  <SoundRow
                    title="Keyboard clicks"
                    description="A faint tick on each keystroke while typing."
                    event="typing"
                    checked={sound.typing}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ typing: v })}
                    hasCustom={Boolean(customSounds['typing'])}
                    onPickCustom={() => pickCustomSound('typing')}
                    onClearCustom={() => clearCustomSound('typing')}
                  />
                </SettingsSection>

                <input
                  ref={soundFileInput}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleCustomSoundFile}
                />
              </div>
            )}

            {tab === 'account' && (
              <div className="space-y-8">
                <SettingsSection title="Identity">
                  <SettingBlock>
                    <p className="t-base text-muted">username</p>
                    <p className="font-mono t-h4">{account.username}</p>
                  </SettingBlock>
                  <SettingBlock>
                    <div className="flex items-center gap-1.5">
                      <p className="t-base text-muted">key fingerprint</p>
                      <InfoTip
                        title="Key fingerprint"
                        tip="Read this to a contact to confirm no one swapped keys."
                        details="Read this to a contact over another channel. If it matches what they see next to your name, no one swapped keys in between."
                      />
                    </div>
                    <p className="font-mono t-h4 tracking-wider text-primary">{fingerprint}</p>
                  </SettingBlock>
                </SettingsSection>

                {session.token && <TwoFactorSection token={session.token} />}

                <SettingsSection
                  title="Email"
                  info="Optional, encrypted, and only for password resets."
                  infoDetails="Shown partially on purpose — the full address is encrypted and the server only decrypts it to send you mail. Nobody can read it back out, including you. It exists so you can reset a forgotten password; it cannot decrypt your channels, and an account without one works exactly the same otherwise."
                >
                  <SettingBlock>
                    {email === null ? (
                      <p className="t-base text-muted">loading…</p>
                    ) : email.mask ? (
                      <div className="space-y-1 t-base">
                        <p className="text-muted">on file</p>
                        <p className="flex items-center gap-2 font-mono">
                          {email.mask}
                          {email.verified ? (
                            <span className="tag bg-ok-soft text-ok">verified</span>
                          ) : (
                            <span className="tag bg-warn-soft text-warn">unconfirmed</span>
                          )}
                        </p>
                      </div>
                    ) : (
                      <p className="t-base text-muted">No email on this account.</p>
                    )}

                    {email?.pendingMask && (
                      <p className="rounded border border-info-line bg-info-soft p-3 t-base text-info">
                        Waiting on confirmation for{' '}
                        <span className="font-mono">{email.pendingMask}</span>. The link expires in
                        24 hours.
                      </p>
                    )}
                  </SettingBlock>

                  <SettingBlock>
                    <label className="block space-y-1">
                      <span className="t-base text-muted">
                        {email?.mask ? 'change to' : 'add an address'}
                      </span>
                      <input
                        className="field"
                        type="email"
                        autoComplete="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="flex items-center gap-1.5 t-base text-muted">
                        your account password
                        <InfoTip
                          title="Why your password?"
                          tip="Anyone who could silently swap this address could hijack the account."
                          details="Your password is required here because anyone who could silently swap this address could take the account by resetting it."
                        />
                      </span>
                      <input
                        className="field"
                        type="password"
                        autoComplete="current-password"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value)}
                      />
                    </label>

                    <button
                      className="btn-ghost w-full t-base"
                      disabled={busy || !emailInput.trim() || !emailPassword}
                      onClick={handleSetEmail}
                    >
                      {email?.mask ? 'change address' : 'add address'}
                    </button>

                    {email?.mask && (
                      <button
                        className="w-full t-base text-error hover:underline"
                        disabled={busy || !emailPassword}
                        onClick={handleRemoveEmail}
                      >
                        remove my address
                      </button>
                    )}
                  </SettingBlock>
                </SettingsSection>
              </div>
            )}

            {tab === 'billing' && (
              <div className="space-y-8">
                <SubscriptionSection
                  badge={badge}
                  portalUrl={portalUrl}
                  redeemCode={redeemCode}
                  onCodeChange={setRedeemCode}
                  onRedeem={handleRedeem}
                  busy={busy}
                />
              </div>
            )}

            {tab === 'keys' && (
              <div className="space-y-8">
                <SettingsSection
                  title="Export keys"
                  info="Save an encrypted copy of your keys to move to another device."
                  infoDetails="Writes your private keys and every channel key to an encrypted file, so you can move this identity to another device. The server cannot do this for you — it has never held these keys."
                >
                  <SettingBlock>
                    <label className="block space-y-1">
                      <span className="flex items-center gap-1.5 t-base text-muted">
                        passphrase for the file (min 12)
                        <InfoTip
                          title="Use a fresh passphrase"
                          tip="Different from your login password — this file leaves the device."
                          details="Use a different passphrase from your login password. This file leaves the device; if it shares the account secret, one leaked file is a full account compromise."
                        />
                      </span>
                      <input
                        className="field"
                        type="password"
                        autoComplete="new-password"
                        value={exportPassphrase}
                        onChange={(e) => setExportPassphrase(e.target.value)}
                      />
                    </label>
                    <button onClick={handleExport} disabled={busy} className="btn-ghost w-full">
                      Export key file
                    </button>
                  </SettingBlock>
                </SettingsSection>

                <SettingsSection
                  title="Import keys"
                  info="Restore an identity exported from another device."
                  infoDetails="Restore an identity exported from another device. Replaces this device's keys and merges in the channel keys from the file."
                >
                  <SettingBlock>
                    <input
                      ref={bundleInput}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={handleBundleFile}
                    />
                    <button
                      onClick={() => bundleInput.current?.click()}
                      className="btn-ghost w-full t-base"
                    >
                      {importFile ? 'key file loaded ✓' : 'choose key file'}
                    </button>

                    <label className="block space-y-1">
                      <span className="t-base text-muted">file passphrase</span>
                      <input
                        className="field"
                        type="password"
                        value={importPassphrase}
                        onChange={(e) => setImportPassphrase(e.target.value)}
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="flex items-center gap-1.5 t-base text-muted">
                        your account password
                        <InfoTip
                          title="Account password"
                          tip="Re-encrypts the restored vault on this device."
                          details="The file passphrase only opens the exported file; your account password re-encrypts the vault on this device, which is keyed from it."
                        />
                      </span>
                      <input
                        className="field"
                        type="password"
                        value={importPassword}
                        onChange={(e) => setImportPassword(e.target.value)}
                      />
                    </label>

                    <button
                      onClick={handleImport}
                      disabled={busy || !importFile || !importPassphrase || !importPassword}
                      className="btn-ghost w-full"
                    >
                      Import
                    </button>
                  </SettingBlock>
                </SettingsSection>

                <SettingsSection
                  title="Identities on this device"
                  info="Each identity is a separate encrypted store."
                  infoDetails="Each identity has a separate encrypted store keyed by its own password. Switching does not expose one to the other."
                >
                  <SettingBlock>
                    {session.accounts.map((other) => (
                      <div
                        key={other.userId}
                        className={`flex items-center gap-2 rounded border p-3 ${
                          other.userId === account.userId
                            ? 'border-primary-line bg-primary-soft'
                            : 'border-border'
                        }`}
                      >
                        <Avatar name={other.username} size="sm" />
                        <span className="flex-1 truncate t-base">{other.username}</span>
                        {other.userId === account.userId ? (
                          <span className="tag bg-primary-soft text-primary">active</span>
                        ) : (
                          <button
                            onClick={() => {
                              session.selectAccount(other.userId);
                              navigate('/channels');
                            }}
                            className="t-small text-muted hover:text-primary"
                          >
                            switch
                          </button>
                        )}
                      </div>
                    ))}
                  </SettingBlock>
                </SettingsSection>
              </div>
            )}

            {tab === 'danger' && (
              <SettingsSection
                title="Danger zone"
                danger
                info="Logging out keeps your keys; erasing deletes them."
                infoDetails="Log out keeps your private keys, channel keys, and decrypted messages on this device so you can unlock again. Erase removes them permanently — without an exported key file it cannot be undone, since the server does not hold your keys."
              >
                <SettingBlock>
                  <button onClick={session.logout} className="btn-ghost w-full">
                    Log out (keeps keys on this device)
                  </button>
                  <button onClick={handleForget} className="btn-danger w-full">
                    Erase this identity from this device
                  </button>
                </SettingBlock>
              </SettingsSection>
            )}
          </div>
        )}
      </main>

      {showLogout && (
        <LogoutConfirmModal
          onConfirm={() => {
            setShowLogout(false);
            session.logout();
          }}
          onClose={() => setShowLogout(false)}
        />
      )}
    </div>
  );
}

/**
 * The quick-jump list under an open settings tab.
 *
 * Renders only when the tab has more than one section. It mounts collapsed and
 * expands downward on the next frame (a 0fr -> 1fr grid-row transition, which
 * animates height without hardcoding one); switching tabs unmounts it, so it
 * collapses away. Each item scrolls its section into view.
 */
function SubNav({
  items,
  onJump,
}: {
  items: { id: string; title: string }[];
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      className={`grid transition-all duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      }`}
    >
      <div className="overflow-hidden">
        <div className="mt-1 ml-5 space-y-0.5 border-l border-border pl-2">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onJump(item.id)}
              className="block cursor-pointer w-full truncate rounded px-2 py-1 text-left t-base text-muted
                         transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              {item.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One sound cue: a labelled row with a preview button and an on/off switch. The
 * preview plays regardless of the toggle so you can hear a cue before enabling
 * it; it is still silenced by the master switch being off only insofar as the
 * whole tab greys out (the toggles disable, but the ▶ always previews).
 */
function SoundRow({
  title,
  description,
  event,
  checked,
  disabled,
  onChange,
  hasCustom,
  onPickCustom,
  onClearCustom,
}: {
  title: string;
  description: string;
  event: SoundEvent;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** Whether a custom sound file is installed for this event. */
  hasCustom: boolean;
  onPickCustom: () => void;
  onClearCustom: () => void;
}) {
  return (
    <SettingRow
      title={title}
      description={description}
      control={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => previewSound(event)}
            className="rounded p-1 text-muted transition-colors hover:text-primary"
            title="Test sound"
            aria-label={`Test the ${title} sound`}
          >
            <Play size={13} />
          </button>
          {hasCustom ? (
            <button
              type="button"
              onClick={onClearCustom}
              className="inline-flex items-center gap-1 rounded border border-primary-line bg-primary-soft
                         px-1.5 py-0.5 t-small text-primary transition-colors hover:text-error"
              title="Remove custom sound (back to the built-in cue)"
            >
              custom
              <X size={10} />
            </button>
          ) : (
            <button
              type="button"
              onClick={onPickCustom}
              className="rounded p-1 text-muted transition-colors hover:text-primary"
              title="Use a custom sound file"
              aria-label={`Choose a custom sound for ${title}`}
            >
              <Upload size={13} />
            </button>
          )}
          <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
        </div>
      }
    />
  );
}

/**
 * A miniature transcript that mirrors the chat-display choices live. It carries
 * its own data-chat-size so the CSS size variables resolve exactly as they will
 * in a real chat, and remounts on any change (via key) to replay the fade.
 */
function ChatPreview({
  size,
  hideImages,
  hideBubbles,
  hour12,
  leftAligned,
  wallpaper,
  supporter,
}: {
  size: ChatTextSize;
  hideImages: boolean;
  /** Drop the bubble fill/border so text sits flat on the background. */
  hideBubbles: boolean;
  /** Sample timestamps in 12-hour form, mirroring the chat's time-format choice. */
  hour12: boolean;
  leftAligned: boolean;
  /** Data URL of the chat wallpaper, if one is set. */
  wallpaper?: string;
  /** Show the supporter crown on your own message. */
  supporter?: boolean;
}) {
  // A fixed afternoon time so the 12h/24h difference is visible; formatted the
  // same way a real message header is.
  const fmt = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12 });
  };
  return (
    <div className="space-y-1.5">
      <p className="px-1 t-base font-medium text-muted">Preview</p>
      <div
        key={`${size}-${hideImages}-${hideBubbles}-${hour12}-${leftAligned}-${Boolean(wallpaper)}-${Boolean(supporter)}`}
        data-chat-size={size}
        data-chat-bubbles={hideBubbles ? 'hidden' : undefined}
        className="animate-fade-in space-y-2 rounded-lg border border-border bg-bg bg-cover bg-center p-3 motion-reduce:animate-none"
        style={
          wallpaper
            ? {
                backgroundImage: `linear-gradient(var(--wallpaper-scrim), var(--wallpaper-scrim)), url(${wallpaper})`,
              }
            : undefined
        }
      >
        <PreviewRow
          name="Ada"
          text="hey — did the keys come through?"
          time={fmt(15, 3)}
          hideImages={hideImages}
        />
        <PreviewRow
          self
          name="You"
          text="yep, decrypted fine 🎉"
          time={fmt(15, 4)}
          hideImages={hideImages}
          leftAligned={leftAligned}
          supporter={supporter}
        />
      </div>
    </div>
  );
}

function PreviewRow({
  self,
  name,
  text,
  time,
  hideImages,
  leftAligned,
  supporter,
}: {
  self?: boolean;
  name: string;
  text: string;
  time: string;
  hideImages: boolean;
  leftAligned?: boolean;
  supporter?: boolean;
}) {
  const right = Boolean(self) && !leftAligned;
  return (
    <div className={`flex items-start gap-2 ${right ? 'flex-row-reverse' : ''}`}>
      {!hideImages && (
        <div
          className="flex-none rounded-full border border-border bg-surface-raised"
          style={{ width: 'var(--chat-avatar)', height: 'var(--chat-avatar)' }}
        />
      )}
      <div className={`flex min-w-0 flex-col ${right ? 'items-end' : 'items-start'}`}>
        <span
          className={`flex items-center gap-1 ${right ? 'flex-row-reverse' : ''}`}
          style={{ fontSize: 'var(--chat-name)' }}
        >
          <span className="font-semibold text-foreground">{name}</span>
          {supporter && <Badge size="sm" />}
          <span className="text-muted" style={{ fontSize: 'var(--chat-time)' }}>
            {time}
          </span>
        </span>
        <div
          data-bubble
          className="mt-0.5 w-fit rounded-lg border px-2 py-1"
          style={{
            fontSize: 'var(--chat-body)',
            background: right ? 'var(--bubble-self-bg)' : 'var(--bubble-other-bg)',
            borderColor: right ? 'var(--bubble-self-border)' : 'var(--bubble-other-border)',
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}
