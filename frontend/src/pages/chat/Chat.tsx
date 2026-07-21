import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { incognitoLabel } from '@/lib/incognito';
import { useCall } from '@/lib/callContext';
import { useSession } from '@/lib/session';
import { useRelayContext } from '@/lib/relayContext';
import { StoredMessage, Vault, Contact, UserProfile, AccountDescriptor } from '@/lib/vault';
import { base64UrlToBytes, bytesToDataUrl } from '@/lib/binary';
import Composer from '@/components/chat/Composer';
import TrustPanel from '@/components/user/TrustPanel';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { ChannelNameModal } from '@/components/channel/ChannelNameModal';
import { UserProfileModal } from '@/components/user/UserProfileModal';
import { ReplyComposing } from '@/components/chat/ReplyRefCard';
import { ChatHeader } from '@/pages/chat/components/ChatHeader';
import { ChatTranscript } from '@/pages/chat/components/ChatTranscript';
import { ComposerAccessories } from '@/pages/chat/components/ComposerAccessories';
import { UnlockModal } from '@/pages/chat/components/UnlockModal';
import { LockComposeModal } from '@/pages/chat/components/LockComposeModal';
import { BurnComposeModal } from '@/pages/chat/components/BurnComposeModal';
import { QuickReactions } from '@/pages/chat/components/QuickReactions';
import { useChannelMessages } from '@/pages/chat/useChannelMessages';
import { useComposer } from '@/pages/chat/useComposer';
import { useChannelActions } from '@/pages/chat/useChannelActions';
import { buildMessageMenuItems, buildHeaderMenuItems } from '@/pages/chat/menus';

export default function Chat() {
  const { channelId } = useParams<{ channelId: string }>();
  const { vault, token, account } = useSession();
  const relay = useRelayContext();
  const {
    send,
    sendReaction,
    sendTyping,
    editMessage,
    deleteMessage,
    openDirectMessage,
    broadcastProfile,
    connected,
    revision,
    bumpRevision,
    typingIn,
    lastPresence,
    isVerified,
    setVerified,
  } = relay;
  const call = useCall();
  const navigate = useNavigate();

  const channel = channelId && vault ? vault.getChannel(channelId) : undefined;
  const isDm = channel?.type === 'dm';

  // Page-owned overlays keyed off a message's context menu.
  const [menu, setMenu] = useState<{ message: StoredMessage; x: number; y: number } | null>(null);
  const [reactingTo, setReactingTo] = useState<{ id: string; x: number; y: number } | null>(null);
  const [verifyingContact, setVerifyingContact] = useState<Contact | null>(null);
  const [unlocking, setUnlocking] = useState<StoredMessage | null>(null);
  const [viewingProfile, setViewingProfile] = useState<UserProfile | null>(null);
  const [showLockModal, setShowLockModal] = useState(false);
  const [showBurnModal, setShowBurnModal] = useState(false);

  const { messages, setMessages, loading, limits, presenceLog, bottomRef } = useChannelMessages({
    vault,
    channelId,
    channel,
    token,
    connected,
    revision,
    bumpRevision,
    broadcastProfile,
    lastPresence,
  });

  const composer = useComposer({
    vault: vault as Vault,
    channelId,
    token,
    account: account as AccountDescriptor,
    limits,
    setMessages,
    send,
    editMessage,
    deleteMessage,
    sendReaction,
    sendTyping,
  });

  const actions = useChannelActions({
    vault: vault as Vault,
    channelId,
    token,
    channel,
    isDm,
    call,
    navigate,
    openDirectMessage,
    setError: composer.setError,
  });

  const contacts = useMemo(() => {
    if (!vault) return {};
    return vault.snapshot().contacts;
  }, [vault, revision]);

  /** Whether a reply's target is on this device, so the quote knows if it can jump. */
  const messageIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  // Premium chat wallpaper, decoded from the vault to a data URL. Rendered
  // behind opaque message bubbles, so it never costs legibility. A video
  // (mp4/webm) is looped and scaled behind the transcript; an image or GIF is a
  // CSS background so an animated GIF keeps its frames.
  const chatBackground = useMemo(() => {
    const asset = vault?.preferences.chatBackground;
    if (!asset) return undefined;
    try {
      const url = bytesToDataUrl(base64UrlToBytes(asset.data), asset.mime);
      return { url, isVideo: asset.mime.startsWith('video/') };
    } catch {
      return undefined;
    }
  }, [vault]);

  const nameFor = useMemo(
    () => (userId: string) => {
      // In an incognito channel nobody has a name; everyone is a per-channel tag.
      if (channel?.incognito && channelId) return incognitoLabel(channelId, userId);
      if (userId === account?.userId) return vault?.profile.displayName ?? 'you';
      return contacts[userId]?.displayName ?? 'unknown';
    },
    [contacts, account, vault, channel?.incognito, channelId],
  );

  /**
   * Open the profile card for a user. Assembles a UserProfile from your own
   * Profile or the peer's pinned Contact. Never in incognito, where there is no
   * stable identity to show a profile for.
   */
  const openProfile = useMemo(
    () => (userId: string) => {
      if (channel?.incognito) return;
      if (userId === account?.userId && vault) {
        const p = vault.profile;
        setViewingProfile({
          userId,
          displayName: p.displayName,
          avatar: p.avatar,
          bio: p.bio,
          background: p.background,
        });
        return;
      }
      const c = contacts[userId];
      if (c) {
        setViewingProfile({
          userId,
          displayName: c.displayName ?? 'unknown',
          avatar: c.avatar,
          bio: c.bio,
          background: c.background,
        });
      }
    },
    [contacts, account, vault, channel?.incognito],
  );

  if (!vault || !account) return null;

  if (!channel) {
    return (
      <div className="grid h-full place-items-center p-4 text-center">
        <div className="card max-w-sm space-y-3">
          <p className="t-h4">This channel is not on this device.</p>
          <Link to="/channels" className="btn-ghost">
            Back to channels
          </Link>
        </div>
      </div>
    );
  }

  const typers = channelId ? typingIn(channelId).filter((id) => id !== account.userId) : [];
  const typerNames = typers.map(nameFor).filter((n) => n && n !== 'unknown');
  const typingLabel =
    typers.length === 0
      ? null
      : typers.length === 1
        ? `${typerNames[0] ?? 'Someone'} is typing…`
        : typerNames.length === typers.length
          ? `${typerNames.join(', ')} are typing…`
          : 'Several people are typing…';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader
        channel={channel}
        vault={vault}
        isDm={isDm}
        dmBlocked={actions.dmBlocked}
        connected={connected}
        limits={limits}
        nameFor={nameFor}
        headerHandlers={actions.headerHandlers}
        onOpenMenu={(x, y) => actions.setHeaderMenu({ x, y })}
        onStartCall={actions.startCall}
        onLeave={actions.handleLeave}
      />

      {!channel.hasKey && (
        <div className="border-b border-warn-line bg-warn-soft px-4 py-3 t-base text-warn">
          <p className="font-medium">Waiting for the channel key</p>
          <p className="mt-1 text-warn">
            Nobody has sent it yet. A member who is online will pass it to you automatically — the
            server cannot, because it has never held it. Messages sent meanwhile stay queued and
            unreadable until the key arrives.
          </p>
        </div>
      )}

      <ChatTranscript
        messages={messages}
        presenceLog={presenceLog}
        loading={loading}
        channel={channel}
        channelId={channelId!}
        account={account}
        vault={vault}
        contacts={contacts}
        limits={limits}
        messageIds={messageIds}
        highlighted={composer.highlighted}
        chatBackground={chatBackground}
        nameFor={nameFor}
        isVerified={isVerified}
        onToggleReaction={composer.handleToggleReaction}
        onJumpToReply={composer.jumpToMessage}
        onOpenMenu={(message, x, y) => setMenu({ message, x, y })}
        bottomRef={bottomRef}
      />

      {composer.error && (
        <p className="border-t border-error-line bg-error-soft px-4 py-2 t-base text-error">
          {composer.error}
        </p>
      )}

      <ComposerAccessories
        upload={composer.upload}
        pending={composer.pending}
        onRemovePending={(blobId) =>
          composer.setPending((c) => c.filter((a) => a.blobId !== blobId))
        }
        typingLabel={typingLabel}
        lockArmed={composer.lockArmed}
        lockCode={composer.lockCode}
        burnTtl={composer.burnTtl}
        spoilerArmed={composer.spoilerArmed}
        editingId={composer.editingId}
        onEditLock={() => setShowLockModal(true)}
        onClearLock={() => {
          composer.setLockArmed(false);
          composer.setLockCode('');
          composer.setLockHint('');
        }}
        onEditBurn={() => setShowBurnModal(true)}
        onClearBurn={() => composer.setBurnTtl(null)}
        onClearSpoiler={() => composer.setSpoilerArmed(false)}
        onCancelEdit={() => {
          composer.setEditingId(null);
          composer.setText('');
        }}
      />

      {composer.replyTo && (
        <ReplyComposing reply={composer.replyTo} onCancel={() => composer.setReplyTo(null)} />
      )}

      {/* Any type. The bytes are encrypted client-side before upload, so the
          relay stores something it cannot read or scan. */}
      <input
        ref={composer.fileRef}
        type="file"
        className="hidden"
        onChange={(e) => composer.handleFile(e.target.files?.[0])}
      />

      {actions.dmBlocked && (
        <div className="flex items-center justify-between border-t border-error-line bg-error-soft px-4 py-2 t-small text-error">
          <span>You blocked this person. Their messages won't reach you.</span>
          <button onClick={actions.handleToggleBlock} className="underline hover:no-underline">
            unblock
          </button>
        </div>
      )}

      <Composer
        value={composer.text}
        onChange={composer.handleType}
        onSend={composer.handleSend}
        onAttach={() => composer.fileRef.current?.click()}
        disabled={!channel.hasKey || actions.dmBlocked}
        sending={composer.sending}
        uploading={Boolean(composer.upload)}
        canSend={Boolean(composer.text.trim()) || composer.pending.length > 0}
        limits={limits}
        placeholder={
          composer.editingId ? 'edit message…' : channel.hasKey ? 'message' : 'waiting for key…'
        }
        canLock={Boolean(limits.premium) && !composer.editingId}
        lockArmed={composer.lockArmed}
        // Opening the modal must not arm anything: the lock only takes effect
        // when the user confirms inside it. Clicking the tool by mistake leaves
        // the message unlocked.
        onToggleLock={() => setShowLockModal(true)}
        canBurn={Boolean(limits.premium)}
        burnArmed={composer.burnTtl != null}
        onToggleBurn={() => setShowBurnModal(true)}
        spoilerArmed={composer.spoilerArmed}
        onToggleSpoiler={composer.editingId ? undefined : () => composer.setSpoilerArmed((s) => !s)}
      />

      {verifyingContact && (
        <TrustPanel
          mySignKey={vault.identity.signPublicKey}
          contacts={[verifyingContact]}
          isVerified={isVerified}
          onClose={() => setVerifyingContact(null)}
          onSetVerified={setVerified}
        />
      )}

      {showLockModal && (
        <LockComposeModal
          initialCode={composer.lockCode}
          initialHint={composer.lockHint}
          armed={composer.lockArmed}
          onConfirm={(code, hint) => {
            composer.setLockArmed(true);
            composer.setLockCode(code);
            composer.setLockHint(hint);
            setShowLockModal(false);
          }}
          onDisable={() => {
            composer.setLockArmed(false);
            composer.setLockCode('');
            composer.setLockHint('');
            setShowLockModal(false);
          }}
          onClose={() => setShowLockModal(false)}
        />
      )}

      {showBurnModal && (
        <BurnComposeModal
          initialTtl={composer.burnTtl}
          armed={composer.burnTtl != null}
          onConfirm={(ttl) => {
            composer.setBurnTtl(ttl);
            setShowBurnModal(false);
          }}
          onDisable={() => {
            composer.setBurnTtl(null);
            setShowBurnModal(false);
          }}
          onClose={() => setShowBurnModal(false)}
        />
      )}

      {unlocking && (
        <UnlockModal
          message={unlocking}
          onClose={() => setUnlocking(null)}
          onSubmit={composer.handleUnlock}
        />
      )}

      {menu && (
        <ContextMenu
          items={buildMessageMenuItems(menu.message, {
            menuPos: { x: menu.x, y: menu.y },
            token,
            selfId: account.userId,
            contacts,
            incognito: Boolean(channel.incognito),
            isDm,
            isVerified,
            setReplyTo: composer.setReplyTo,
            setReactingTo,
            setUnlocking,
            setVerifyingContact,
            openProfile,
            handleStartDm: actions.handleStartDm,
            handleStartEdit: composer.handleStartEdit,
            handleDelete: composer.handleDelete,
            setError: composer.setError,
          })}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}

      {actions.headerMenu && (
        <ContextMenu
          items={buildHeaderMenuItems(channel, {
            isDm,
            dmBlocked: actions.dmBlocked,
            contacts,
            openProfile,
            copyChannelCode: actions.copyChannelCode,
            setRenamingChannel: actions.setRenamingChannel,
            onPickIcon: () => actions.iconInput.current?.click(),
            handleRemoveIcon: actions.handleRemoveIcon,
            handleToggleBlock: actions.handleToggleBlock,
            handleLeave: actions.handleLeave,
          })}
          position={{ x: actions.headerMenu.x, y: actions.headerMenu.y }}
          onClose={() => actions.setHeaderMenu(null)}
        />
      )}

      {actions.renamingChannel && (
        <ChannelNameModal
          channel={channel}
          onClose={() => actions.setRenamingChannel(false)}
          onSubmit={actions.handleRenameChannel}
        />
      )}

      {viewingProfile && (
        <UserProfileModal profile={viewingProfile} onClose={() => setViewingProfile(null)} />
      )}

      <input
        ref={actions.iconInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => actions.handleIconFile(e.target.files?.[0])}
      />

      {/* The quick-reaction strip. A full picker is one tap further in, but the
          common case is one of eight and should not need a search box. */}
      {reactingTo && (
        <QuickReactions
          x={reactingTo.x}
          y={reactingTo.y}
          onPick={(emoji) => {
            const target = messages.find((message) => message.id === reactingTo.id);
            if (target) composer.handleToggleReaction(target, emoji);
            setReactingTo(null);
          }}
          onClose={() => setReactingTo(null)}
        />
      )}
    </div>
  );
}
