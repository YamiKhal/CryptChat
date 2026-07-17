import { useState, useEffect, useRef, ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { fileToAsset, BinaryAsset } from '../lib/binary';
import {
  exportKeyBundle,
  importKeyBundle,
  keyFingerprint,
  EncryptedBundle,
} from '../lib/crypto';
import { saveAccount, Vault } from '../lib/vault';
import Avatar from '../components/Avatar';

export default function Settings() {
  const session = useSession();
  const { vault, account } = session;
  const { broadcastProfileEverywhere } = useRelayContext();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState<BinaryAsset | undefined>();
  const [fingerprint, setFingerprint] = useState('');
  const [alwaysPreview, setAlwaysPreview] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<EncryptedBundle | null>(null);
  const [importPassword, setImportPassword] = useState('');

  const avatarInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!vault) return;
    setDisplayName(vault.profile.displayName);
    setAvatar(vault.profile.avatar);
    setAlwaysPreview(vault.preferences.alwaysPreviewLinks);
    keyFingerprint(vault.identity.signPublicKey).then(setFingerprint);
  }, [vault]);

  if (!vault || !account) {
    return (
      <div className="min-h-screen grid place-items-center p-4">
        <div className="card space-y-3 text-center">
          <p className="text-sm">Unlock your vault to change settings.</p>
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

  async function handleSaveProfile() {
    if (!displayName.trim()) {
      setStatus({ kind: 'error', text: 'display name cannot be empty' });
      return;
    }
    setBusy(true);
    try {
      await vault!.setProfile({ displayName: displayName.trim(), avatar });
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
    ok: 'border-primary/30 bg-primary/10 text-primary',
    error: 'border-error/30 bg-error/10 text-error',
    info: 'border-info/30 bg-info/10 text-info',
  } as const;

  return (
    <div className="mx-auto min-h-screen max-w-md space-y-4 p-4">
      <header className="flex items-center gap-3">
        <Link to="/channels" className="text-muted transition-colors hover:text-primary">
          ←
        </Link>
        <h1 className="flex-1 text-sm font-semibold uppercase tracking-wider">settings</h1>
        <button onClick={session.lock} className="btn-ghost px-3 py-1.5 text-xs">
          lock
        </button>
      </header>

      {status && (
        <p className={`rounded border p-4 text-xs ${statusStyles[status.kind]}`}>{status.text}</p>
      )}

      {/* profile */}
      <section className="card space-y-4">
        <h2 className="text-xs uppercase tracking-wider text-muted">profile</h2>

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
            <button onClick={() => avatarInput.current?.click()} className="btn-ghost text-xs">
              choose image
            </button>
            {avatar && (
              <button
                onClick={() => setAvatar(undefined)}
                className="block text-xs text-muted hover:text-error"
              >
                remove
              </button>
            )}
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-muted">display name</span>
          <input
            className="field"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={48}
          />
        </label>

        <p className="text-[11px] text-muted">
          Your name and picture are encrypted and signed, then sent only to members of channels you
          are in. The server stores neither — it only ever holds a hash of your username.
        </p>

        <button onClick={handleSaveProfile} disabled={busy} className="btn-primary w-full">
          Save profile
        </button>
      </section>

      {/* privacy */}
      <section className="card space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-muted">link previews</h2>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={alwaysPreview}
            onChange={(e) => handlePreviewToggle(e.target.checked)}
          />
          <span className="text-xs">
            Always preview links
            <span className="mt-1 block text-[11px] text-muted">
              Off by default. Prefix a link with <span className="text-primary">!</span> to preview
              just that one.
            </span>
          </span>
        </label>

        <p className="rounded border border-warn/30 bg-warn/10 p-4 text-[11px] text-warn">
          Building a preview asks the server to fetch that URL, so the relay learns which link you
          sent — the one thing it otherwise never sees. The preview itself is encrypted and sent
          with your message, so people reading it never load anything and their IP stays private.
          Links always work as plain clickable text with this off.
        </p>
      </section>

      {/* identity */}
      <section className="card space-y-2">
        <h2 className="text-xs uppercase tracking-wider text-muted">identity</h2>
        <div className="space-y-1 text-xs">
          <p className="text-muted">username</p>
          <p className="font-mono">{account.username}</p>
        </div>
        <div className="space-y-1 text-xs">
          <p className="text-muted">key fingerprint</p>
          <p className="font-mono tracking-wider text-primary">{fingerprint}</p>
        </div>
        <p className="text-[11px] text-muted">
          Read this to a contact over another channel. If it matches what they see next to your
          name, no one swapped keys in between.
        </p>
      </section>

      {/* export */}
      <section className="card space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-muted">export keys</h2>
        <p className="text-[11px] text-muted">
          Writes your private keys and every channel key to an encrypted file, so you can move this
          identity to another device. The server cannot do this for you — it has never held these
          keys.
        </p>
        <label className="block space-y-1">
          <span className="text-xs text-muted">passphrase for the file (min 12)</span>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={exportPassphrase}
            onChange={(e) => setExportPassphrase(e.target.value)}
          />
        </label>
        <p className="rounded border border-warn/30 bg-warn/10 p-4 text-[11px] text-warn">
          Use a different passphrase from your login password. This file leaves the device; if it
          shares the account secret, one leaked file is a full account compromise.
        </p>
        <button onClick={handleExport} disabled={busy} className="btn-ghost w-full">
          Export key file
        </button>
      </section>

      {/* import */}
      <section className="card space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-muted">import keys</h2>
        <p className="text-[11px] text-muted">
          Restore an identity exported from another device. Replaces this device's keys and merges
          in the channel keys from the file.
        </p>

        <input
          ref={bundleInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleBundleFile}
        />
        <button onClick={() => bundleInput.current?.click()} className="btn-ghost w-full text-xs">
          {importFile ? 'key file loaded ✓' : 'choose key file'}
        </button>

        <label className="block space-y-1">
          <span className="text-xs text-muted">file passphrase</span>
          <input
            className="field"
            type="password"
            value={importPassphrase}
            onChange={(e) => setImportPassphrase(e.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted">your account password (re-encrypts the vault here)</span>
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
      </section>

      {/* accounts */}
      <section className="card space-y-2">
        <h2 className="text-xs uppercase tracking-wider text-muted">identities on this device</h2>
        {session.accounts.map((other) => (
          <div
            key={other.userId}
            className={`flex items-center gap-2 rounded border p-4 ${
              other.userId === account.userId ? 'border-primary/40 bg-primary/5' : 'border-border'
            }`}
          >
            <Avatar name={other.username} size="sm" />
            <span className="flex-1 truncate text-xs">{other.username}</span>
            {other.userId === account.userId ? (
              <span className="tag bg-primary/10 text-primary">active</span>
            ) : (
              <button
                onClick={() => {
                  session.selectAccount(other.userId);
                  navigate('/channels');
                }}
                className="text-[11px] text-muted hover:text-primary"
              >
                switch
              </button>
            )}
          </div>
        ))}
        <p className="text-[11px] text-muted">
          Each identity has a separate encrypted store keyed by its own password. Switching does not
          expose one to the other.
        </p>
      </section>

      {/* danger */}
      <section className="card space-y-3 border-error/30">
        <h2 className="text-xs uppercase tracking-wider text-error">danger zone</h2>
        <button onClick={session.logout} className="btn-ghost w-full">
          Log out (keeps keys on this device)
        </button>
        <button onClick={handleForget} className="btn-danger w-full">
          Erase this identity from this device
        </button>
      </section>
    </div>
  );
}
