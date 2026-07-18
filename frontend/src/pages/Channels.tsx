import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { generateChannelKey } from '../lib/crypto';
import { useSession } from '../lib/session';
import { useRelayContext } from '../lib/relayContext';
import { StoredChannel } from '../lib/vault';
import Avatar from '../components/Avatar';

export default function Channels() {
  const { vault, token, account, lock } = useSession();
  const { connected, revision } = useRelayContext();
  const navigate = useNavigate();

  const [channels, setChannels] = useState<StoredChannel[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [premium, setPremium] = useState(false);
  const [incognitoNew, setIncognitoNew] = useState(false);

  const reload = useCallback(() => {
    if (!vault) return;
    setChannels(vault.listChannels());
  }, [vault]);

  useEffect(reload, [reload, revision]);

  // Premium gates offering the incognito toggle. The server enforces it too, so
  // this is just UI: a non-premium user simply never sees the option.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .limits(token)
      .then((res) => !cancelled && setPremium(Boolean(res.premium)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Unread badges. Recomputed on every relay revision, so a message that lands
  // while the list is open bumps the count without a manual refresh. Channels
  // are few and transcripts are already local, so loading them here is cheap.
  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    (async () => {
      const counts: Record<string, number> = {};
      for (const channel of vault.listChannels()) {
        counts[channel.channelId] = await vault.unreadCount(channel.channelId);
      }
      if (!cancelled) setUnread(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [vault, revision]);

  /**
   * Reconcile local channels against server membership.
   *
   * The server knows which channels this user belongs to; only this device
   * knows which of them it can decrypt. A channel present on the server but
   * missing locally is recorded with hasKey: false so the relay will request
   * a key for it on the next connect.
   */
  useEffect(() => {
    if (!vault || !token) return;
    let cancelled = false;

    api
      .listChannels(token)
      .then(async ({ channels: remote }) => {
        if (cancelled) return;
        let changed = false;

        for (const summary of remote) {
          const dmType = summary.type === 'dm' ? 'dm' : undefined;
          const local = vault.getChannel(summary.channelId);
          if (!local) {
            // This is also how the *peer* of a DM learns the channel is a DM:
            // they never called /channel/dm, they just received a key-offer, so
            // the server's list is where type/peerId/blocked arrive.
            await vault.saveChannel({
              channelId: summary.channelId,
              code: summary.code,
              key: '',
              hasKey: false,
              incognito: summary.incognito,
              type: dmType,
              peerId: summary.peerId,
              blocked: summary.blocked,
              joinedAt: summary.joinedAt,
            });
            changed = true;
          } else if (
            local.code !== summary.code ||
            local.incognito !== summary.incognito ||
            local.type !== dmType ||
            local.peerId !== summary.peerId ||
            Boolean(local.blocked) !== Boolean(summary.blocked)
          ) {
            // Code rotated, or we learned DM/incognito/block state from the server.
            await vault.saveChannel({
              ...local,
              code: summary.code,
              incognito: summary.incognito,
              type: dmType,
              peerId: summary.peerId,
              blocked: summary.blocked,
            });
            changed = true;
          }
        }

        if (changed) reload();
      })
      .catch(() => {
        // Offline: local channels remain usable, since messages are decrypted
        // and stored on this device.
      });

    return () => {
      cancelled = true;
    };
  }, [vault, token, reload]);

  async function handleCreate() {
    if (!vault || !token) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.createChannel(token, incognitoNew);

      // The creator mints the channel key locally. The server issues the code
      // and nothing else -- it never sees this value.
      const key = await generateChannelKey();

      await vault.saveChannel({
        channelId: res.channelId,
        code: res.code,
        key,
        hasKey: true,
        incognito: res.incognito,
        joinedAt: new Date().toISOString(),
      });
      setIncognitoNew(false);

      reload();
      navigate(`/chat/${res.channelId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!vault || !token) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await api.joinChannel(token, code.trim());

      const existing = vault.getChannel(res.channelId);
      if (existing?.hasKey) {
        navigate(`/chat/${res.channelId}`);
        return;
      }

      // Membership is registered, but the key is not here yet: the server has
      // no key to hand over. An online member wraps it for our public key and
      // sends it back over the relay, which lands as a `key-offer`. Until then
      // the channel exists locally but is unreadable.
      await vault.saveChannel({
        channelId: res.channelId,
        code: res.code,
        key: '',
        hasKey: false,
        incognito: res.incognito,
        joinedAt: new Date().toISOString(),
      });

      reload();

      if (res.members.length === 0) {
        setNotice('Joined. You are the only member — no key to receive yet.');
      } else {
        setNotice('Joined. Waiting for a member to send the channel key…');
      }

      setCode('');
      navigate(`/chat/${res.channelId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!vault || !account) return null;

  const profile = vault.profile;

  return (
    <div className="min-h-screen mx-auto max-w-md space-y-4 p-4">
      <header className="flex items-center gap-3">
        <Avatar asset={profile.avatar} name={profile.displayName} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{profile.displayName}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-primary' : 'bg-warn'
              }`}
            />
            {connected ? 'relay connected' : 'reconnecting…'}
          </p>
        </div>
        <Link to="/settings" className="btn-ghost px-3 py-1.5 text-xs">
          settings
        </Link>
        <button onClick={lock} className="btn-ghost px-3 py-1.5 text-xs" title="Lock vault">
          lock
        </button>
      </header>

      <section className="card space-y-3">
        <button onClick={handleCreate} disabled={busy} className="btn-primary w-full">
          Create {incognitoNew ? 'incognito ' : ''}channel
        </button>

        {premium && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={incognitoNew}
              onChange={(e) => setIncognitoNew(e.target.checked)}
            />
            <span className="text-[11px]">
              Incognito
              <span className="mt-0.5 block text-muted">
                Members appear as colours only — no names or avatars are shown or sent, and colours
                are per-channel. This hides who's who in the interface; the server still routes by
                membership, so it is not anonymity from a determined member.
              </span>
            </span>
          </label>
        )}

        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-wider text-muted">or join</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex gap-2">
          <input
            className="field flex-1 font-mono uppercase tracking-widest"
            placeholder="XXXXXXXX"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
          <button onClick={handleJoin} disabled={busy || !code.trim()} className="btn-ghost">
            Join
          </button>
        </div>

        {error && (
          <p className="rounded border border-error/30 bg-error/10 p-4 text-xs text-error">{error}</p>
        )}
        {notice && (
          <p className="rounded border border-info/30 bg-info/10 p-4 text-xs text-info">{notice}</p>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-muted">channels</p>

        {channels.length === 0 && (
          <p className="text-xs text-muted">No channels yet. Create one or join with a code.</p>
        )}

        {channels.map((channel) => (
          <button
            key={channel.channelId}
            onClick={() => navigate(`/chat/${channel.channelId}`)}
            className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3
                       text-left transition-colors hover:border-primary/50"
          >
            <div className="min-w-0 flex-1">
              {channel.type === 'dm' ? (
                <p className="truncate text-sm font-medium text-foreground">
                  {(channel.peerId && vault.getContact(channel.peerId)?.displayName) || 'direct message'}
                </p>
              ) : (
                <p className="font-mono text-sm tracking-widest text-primary">
                  {channel.code || '········'}
                </p>
              )}
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                joined {new Date(channel.joinedAt).toLocaleDateString()}
                {channel.type === 'dm' && <span className="tag bg-primary/10 text-primary">direct</span>}
                {channel.blocked && <span className="tag bg-error/10 text-error">blocked</span>}
                {channel.incognito && <span className="tag bg-secondary/10 text-secondary">incognito</span>}
              </p>
            </div>
            {unread[channel.channelId] > 0 && (
              <span
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary
                           px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
                aria-label={`${unread[channel.channelId]} unread`}
              >
                {unread[channel.channelId] > 99 ? '99+' : unread[channel.channelId]}
              </span>
            )}
            {channel.hasKey ? (
              <span className="tag bg-primary/10 text-primary">keyed</span>
            ) : (
              <span className="tag animate-pulse bg-warn/10 text-warn">no key</span>
            )}
          </button>
        ))}
      </section>
    </div>
  );
}
