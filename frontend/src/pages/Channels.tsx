import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Copy,
  Pencil,
  LogOut,
  Ban,
  Image as ImageIcon,
  Trash2,
  Check,
  X,
  Plus,
  Key,
} from "lucide-react";
import { api } from "../lib/api";
import { generateChannelKey } from "../lib/crypto";
import { fileToAsset, BinaryAsset } from "../lib/binary";
import { useSession } from "../lib/session";
import { useRelayContext } from "../lib/relayContext";
import { StoredChannel } from "../lib/vault";
import {
  ContextMenu,
  useContextMenu,
  MenuItem,
} from "../components/ContextMenu";
import { ChannelNameModal } from "../components/ChannelNameModal";
import { NewChannelModal } from "../components/NewChannelModal";
import { ChannelIcon } from "../components/ChannelIcon";
import AccountBar from "../components/AccountBar";

/**
 * One channel row plus its context-menu wiring.
 *
 * Split out for the same reason MessageRow is in Chat: `useContextMenu` is a
 * hook and cannot be called inside the list's map(). Each row tracks its own
 * press, then lifts the opened position up to the page, which owns the single
 * menu so two rows never render one at once.
 */
function ChannelRow({
  channel,
  peerName,
  peerAvatar,
  unread,
  active,
  onOpen,
  onOpenMenu,
  onAccept,
  onDecline,
}: {
  channel: StoredChannel;
  peerName?: string;
  peerAvatar?: BinaryAsset;
  unread: number;
  active?: boolean;
  onOpen: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { handlers, position, close } = useContextMenu();

  // A touch long-press opens the menu, then releasing the finger synthesises a
  // click on the button -- which would navigate into the chat as the menu opens.
  // Swallow exactly that trailing click. Only for touch: a mouse right-click
  // fires no click, so leaving the flag set would wrongly eat a later real one.
  const pointerType = useRef("mouse");
  const swallowClick = useRef(false);

  useEffect(() => {
    if (position) {
      if (pointerType.current !== "mouse") swallowClick.current = true;
      onOpenMenu(position.x, position.y);
      close();
    }
  }, [position, onOpenMenu, close]);

  const isDm = channel.type === "dm";
  // The code is never a title -- it is an identifier, not a name. An unnamed
  // channel is just "Group"; a DM is the peer. The code lives in the menu.
  const title = isDm ? peerName || "direct message" : channel.label || "Group";
  // A pending DM invitation: the row does not open (there is no key and nothing
  // to read yet), it offers accept / decline instead.
  const request = Boolean(channel.request);

  // Nested buttons are invalid, so the row is a div: the identity is one button
  // (open / menu), and the accept/decline controls are their own buttons beside it.
  return (
    <div
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors
                 hover:border-primary ${
                   active
                     ? "border-primary bg-primary-soft"
                     : "border-border bg-surface"
                 }`}
    >
      <button
        onPointerDownCapture={(e) => {
          pointerType.current = e.pointerType;
        }}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false;
            return;
          }
          if (request) return; // nothing to open until accepted
          onOpen();
        }}
        {...handlers}
        className="flex cursor-pointer min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="relative">
          <ChannelIcon
            channel={channel}
            peerName={peerName}
            peerAvatar={peerAvatar}
            size="md"
          />
          {unread > 0 && (
            <span
              className="absolute -bottom-1 left-4 inline-flex min-w-5 flex-none items-center justify-center rounded-full
                         bg-error px-0.5 py-0.5 t-small font-semibold text-white"
              aria-label={`${unread} unread`}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate t-h4 font-medium text-foreground">
            {title}
          </p>
          {request ? (
            <p className="t-small text-primary">wants to message you</p>
          ) : (
            <p className="flex items-center gap-1.5 t-small text-muted">
              joined {new Date(channel.joinedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </button>

      {request ? (
        <div className="flex flex-none items-center gap-1.5">
          <button
            onClick={onAccept}
            title="Accept"
            aria-label="Accept message request"
            className="rounded-full p-1.5 text-ok transition-colors hover:bg-ok-soft"
          >
            <Check size={18} />
          </button>
          <button
            onClick={onDecline}
            title="Decline"
            aria-label="Decline message request"
            className="rounded-full p-1.5 text-error transition-colors hover:bg-error-soft"
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        <>
          {isDm && (
            <span className="tag bg-primary-soft text-primary">direct</span>
          )}
          {channel.blocked && (
            <span className="tag bg-error-soft text-error">blocked</span>
          )}
          {channel.incognito && (
            <span className="tag bg-secondary-soft text-secondary">
              incognito
            </span>
          )}
          {!channel.hasKey && (
            <span
              className="tag flex-none animate-pulse bg-warn-soft text-warn"
              title="Waiting for the channel key"
            >
              <Key size={14} />
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default function Channels() {
  const { vault, token, account } = useSession();
  const { revision } = useRelayContext();
  const navigate = useNavigate();
  // Which channel is open in the panel beside us (desktop two-pane), so its row
  // reads as selected. Undefined on the bare /channels route.
  const { channelId: activeChannelId } = useParams<{ channelId: string }>();

  const [channels, setChannels] = useState<StoredChannel[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [premium, setPremium] = useState(false);
  // The create/join modal, opened from the "+" beside the channels header.
  const [showNew, setShowNew] = useState(false);
  const [menu, setMenu] = useState<{
    channel: StoredChannel;
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<StoredChannel | null>(null);
  // The group whose picture the hidden file input is about to set.
  const iconTarget = useRef<StoredChannel | null>(null);
  const iconInput = useRef<HTMLInputElement>(null);

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
          const dmType = summary.type === "dm" ? "dm" : undefined;
          const local = vault.getChannel(summary.channelId);
          if (!local) {
            // This is also how the *peer* of a DM learns the channel is a DM:
            // they never called /channel/dm, they just received a key-offer, so
            // the server's list is where type/peerId/blocked arrive.
            await vault.saveChannel({
              channelId: summary.channelId,
              code: summary.code,
              key: "",
              hasKey: false,
              incognito: summary.incognito,
              type: dmType,
              peerId: summary.peerId,
              blocked: summary.blocked,
              request: summary.request,
              joinedAt: summary.joinedAt,
            });
            changed = true;
          } else if (
            local.code !== summary.code ||
            local.incognito !== summary.incognito ||
            local.type !== dmType ||
            local.peerId !== summary.peerId ||
            Boolean(local.blocked) !== Boolean(summary.blocked) ||
            Boolean(local.request) !== Boolean(summary.request)
          ) {
            // Code rotated, or we learned DM/incognito/block/request state.
            await vault.saveChannel({
              ...local,
              code: summary.code,
              incognito: summary.incognito,
              type: dmType,
              peerId: summary.peerId,
              blocked: summary.blocked,
              request: summary.request,
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
    // revision: a relay event (notably a 'dm-request' nudge, which bumps it) must
    // re-pull the server list so an incoming DM invitation appears without a
    // manual refresh.
  }, [vault, token, reload, revision]);

  async function handleCreate(name: string, incognito: boolean) {
    if (!vault || !token) return;
    setError("");
    setBusy(true);
    try {
      const res = await api.createChannel(token, incognito);

      // The creator mints the channel key locally. The server issues the code
      // and nothing else -- it never sees this value.
      const key = await generateChannelKey();

      await vault.saveChannel({
        channelId: res.channelId,
        code: res.code,
        key,
        hasKey: true,
        incognito: res.incognito,
        label: name.trim() || undefined,
        joinedAt: new Date().toISOString(),
      });

      setShowNew(false);
      reload();
      navigate(`/chat/${res.channelId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(code: string) {
    if (!vault || !token) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const res = await api.joinChannel(token, code.trim());

      const existing = vault.getChannel(res.channelId);
      if (existing?.hasKey) {
        setShowNew(false);
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
        key: "",
        hasKey: false,
        incognito: res.incognito,
        joinedAt: new Date().toISOString(),
      });

      reload();

      if (res.members.length === 0) {
        setNotice("Joined. You are the only member — no key to receive yet.");
      } else {
        setNotice("Joined. Waiting for a member to send the channel key…");
      }

      setShowNew(false);
      navigate(`/chat/${res.channelId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setNotice("Channel code copied.");
    } catch {
      // Clipboard blocked (insecure context, denied permission): surface the
      // code so it can still be copied by hand rather than failing silently.
      setNotice(`Channel code: ${code}`);
    }
    setError("");
  }

  async function handleRename(channel: StoredChannel, name: string) {
    if (!vault) return;
    await vault.saveChannel({ ...channel, label: name.trim() || undefined });
    reload();
  }

  function pickIcon(channel: StoredChannel) {
    iconTarget.current = channel;
    iconInput.current?.click();
  }

  async function handleIconFile(file: File | undefined) {
    const channel = iconTarget.current;
    iconTarget.current = null;
    if (iconInput.current) iconInput.current.value = "";
    if (!file || !vault || !channel) return;
    try {
      // Square, downscaled, re-encoded to WebP -- the re-encode strips EXIF, same
      // pipeline as the profile avatar. A channel icon is local, but a picture a
      // user drops in should never keep GPS metadata regardless.
      const icon = await fileToAsset(file, {
        maxDimension: 256,
        square: true,
        mime: "image/webp",
        quality: 0.85,
      });
      await vault.saveChannel({ ...channel, icon });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemoveIcon(channel: StoredChannel) {
    if (!vault) return;
    await vault.saveChannel({ ...channel, icon: undefined });
    reload();
  }

  async function handleAcceptDm(channel: StoredChannel) {
    if (!vault || !token) return;
    setError("");
    try {
      await api.acceptDm(token, channel.channelId);
      // Drop the request flag locally; the withheld key and messages now flow
      // over the relay (resumeDelivery), which lands the key via a key-offer.
      await vault.saveChannel({ ...channel, request: false });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeclineDm(channel: StoredChannel) {
    if (!vault || !token) return;
    if (
      !confirm(
        "Decline this message request? It is removed and they are not told.",
      )
    )
      return;
    // Declining is leaving the pending DM: the server drops the membership, the
    // queued messages, and the parked key.
    await api.leaveChannel(token, channel.channelId).catch(() => {});
    await vault.removeChannel(channel.channelId);
    reload();
  }

  async function handleLeave(channel: StoredChannel) {
    if (!vault || !token) return;
    const message =
      channel.type === "dm"
        ? "Leave this direct message? It is removed from this device; the other person keeps their copy."
        : "Leave this channel? Its key and local messages are deleted from this device.";
    if (!confirm(message)) return;
    await api.leaveChannel(token, channel.channelId).catch(() => {});
    await vault.removeChannel(channel.channelId);
    reload();
  }

  async function handleToggleBlock(channel: StoredChannel) {
    if (!vault || !token) return;
    const next = !channel.blocked;
    try {
      if (next) await api.blockDm(token, channel.channelId);
      else await api.unblockDm(token, channel.channelId);
      await vault.saveChannel({ ...channel, blocked: next });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function menuItems(channel: StoredChannel): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: "Copy channel code",
        icon: <Copy size={14} />,
        onSelect: () => copyCode(channel.code),
      },
      {
        label: channel.label ? "Rename" : "Set a name",
        icon: <Pencil size={14} />,
        onSelect: () => setRenaming(channel),
      },
    ];
    // A group's picture is settable; a DM's icon always tracks the peer's own
    // avatar, so there is nothing to set here.
    if (channel.type !== "dm") {
      items.push({
        label: channel.icon ? "Change picture" : "Set a picture",
        icon: <ImageIcon size={14} />,
        onSelect: () => pickIcon(channel),
      });
      if (channel.icon) {
        items.push({
          label: "Remove picture",
          icon: <Trash2 size={14} />,
          onSelect: () => handleRemoveIcon(channel),
        });
      }
    }
    if (channel.type === "dm") {
      items.push({
        label: channel.blocked ? "Unblock" : "Block",
        icon: <Ban size={14} />,
        danger: !channel.blocked,
        onSelect: () => handleToggleBlock(channel),
      });
    }
    items.push({
      label: channel.type === "dm" ? "Leave conversation" : "Leave channel",
      icon: <LogOut size={14} />,
      danger: true,
      onSelect: () => handleLeave(channel),
    });
    return items;
  }

  if (!vault || !account) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center justify-between px-1">
          <p className="t-base uppercase tracking-wider text-muted">
            channels
          </p>
          <button
            onClick={() => {
              setError("");
              setNotice("");
              setShowNew(true);
            }}
            className="rounded p-1 text-muted transition-colors hover:bg-surface-raised hover:text-primary"
            title="New channel"
            aria-label="New channel"
          >
            <Plus size={18} />
          </button>
        </div>

        {/* Feedback from row actions and joins. Create/join errors live in the
            modal instead, so they are not doubled here while it is open. */}
        {error && !showNew && (
          <p className="rounded border border-error-line bg-error-soft p-2 t-base text-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded border border-info-line bg-info-soft p-2 t-base text-info">
            {notice}
          </p>
        )}

        {channels.length === 0 && (
          <p className="px-1 t-base text-muted">
            No channels yet. Create one or join with a code.
          </p>
        )}

        {channels.map((channel) => (
          <ChannelRow
            key={channel.channelId}
            channel={channel}
            peerName={
              channel.peerId
                ? vault.getContact(channel.peerId)?.displayName
                : undefined
            }
            peerAvatar={
              channel.peerId
                ? vault.getContact(channel.peerId)?.avatar
                : undefined
            }
            unread={unread[channel.channelId] ?? 0}
            active={channel.channelId === activeChannelId}
            onOpen={() => navigate(`/chat/${channel.channelId}`)}
            onOpenMenu={(x, y) => setMenu({ channel, x, y })}
            onAccept={() => handleAcceptDm(channel)}
            onDecline={() => handleDeclineDm(channel)}
          />
        ))}
      </div>

      <AccountBar />

      {showNew && (
        <NewChannelModal
          premium={premium}
          busy={busy}
          error={error}
          onCreate={handleCreate}
          onJoin={handleJoin}
          onClose={() => {
            setShowNew(false);
            setError("");
          }}
        />
      )}

      {menu && (
        <ContextMenu
          items={menuItems(menu.channel)}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}

      {renaming && (
        <ChannelNameModal
          channel={renaming}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => handleRename(renaming, name)}
        />
      )}

      <input
        ref={iconInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleIconFile(e.target.files?.[0])}
      />
    </div>
  );
}
