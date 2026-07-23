import {
    CornerUpLeft,
    Smile,
    Copy,
    Download,
    Pencil,
    Trash2,
    LockKeyhole,
    ShieldCheck,
    MessageCircle,
    User,
    Ban,
    LogOut,
    Image as ImageIcon,
} from "lucide-react";
import { StoredMessage, StoredChannel, Contact } from "@/lib/vault";
import { buildReplyRef } from "@/lib/limits";
import { MenuItem } from "@/components/ui/ContextMenu";
import { downloadAttachment } from "@/pages/chat/utils";

/** Everything the per-message context menu needs from the page. */
export interface MessageMenuContext {
    menuPos: { x: number; y: number };
    token: string | null;
    selfId: string;
    contacts: Record<string, Contact>;
    incognito: boolean;
    isDm: boolean;
    isVerified: (userId: string) => boolean;
    setReplyTo: (ref: ReturnType<typeof buildReplyRef>) => void;
    setReactingTo: (r: { id: string; x: number; y: number }) => void;
    setUnlocking: (message: StoredMessage) => void;
    setVerifyingContact: (contact: Contact) => void;
    openProfile: (userId: string) => void;
    handleStartDm: (userId: string) => void;
    handleStartEdit: (message: StoredMessage) => void;
    handleDelete: (message: StoredMessage) => void;
    setError: (message: string) => void;
}

/** Built per-target so the menu can offer download only where there is a file. */
export function buildMessageMenuItems(
    message: StoredMessage,
    ctx: MessageMenuContext,
): MenuItem[] {
    const isOther = message.senderId !== ctx.selfId;
    const knownSender =
        isOther && !ctx.incognito && Boolean(ctx.contacts[message.senderId]);

    const items: MenuItem[] = [
        {
            label: "Reply",
            icon: <CornerUpLeft size={13} />,
            onSelect: () => ctx.setReplyTo(buildReplyRef(message)),
        },
        {
            label: "React",
            icon: <Smile size={13} />,
            onSelect: () =>
                ctx.setReactingTo({
                    id: message.id,
                    x: ctx.menuPos.x,
                    y: ctx.menuPos.y,
                }),
        },
    ];

    // A still-locked message: unlocking is the primary action, so it leads.
    if (message.locked) {
        items.unshift({
            label: "Unlock",
            icon: <LockKeyhole size={13} />,
            onSelect: () => ctx.setUnlocking(message),
        });
    }

    if (message.body.trim()) {
        items.push({
            label: "Copy text",
            icon: <Copy size={13} />,
            onSelect: () => navigator.clipboard?.writeText(message.body),
        });
    }

    for (const attachment of message.attachments ?? []) {
        items.push({
            label: `Download ${attachment.name}`,
            icon: <Download size={13} />,
            // Downloading decrypts locally: the blob store holds ciphertext and
            // the key rides in the envelope, so the server cannot serve the
            // plaintext even if it wanted to.
            onSelect: () =>
                downloadAttachment(attachment, ctx.token!).catch((e) =>
                    ctx.setError(e.message),
                ),
        });
    }

    // Verify this specific sender: their safety number, scoped to them. Only
    // for others (you don't verify yourself) and never in incognito.
    if (knownSender) {
        items.push({
            label: ctx.isVerified(message.senderId)
                ? "Safety number ✓"
                : "Verify safety number",
            icon: <ShieldCheck size={13} />,
            onSelect: () =>
                ctx.setVerifyingContact(ctx.contacts[message.senderId]),
        });
        // View this member's profile card. Only for others with a pinned identity,
        // and never in incognito -- there is no profile to show for a color tag.
        items.push({
            label: "View profile",
            icon: <User size={13} />,
            onSelect: () => ctx.openProfile(message.senderId),
        });
    }

    // Start a 1:1 DM with this member. Not offered inside a DM (already one) or
    // in incognito (there is no stable identity to open a DM against).
    if (isOther && !ctx.incognito && !ctx.isDm) {
        items.push({
            label: "Direct message",
            icon: <MessageCircle size={13} />,
            onSelect: () => ctx.handleStartDm(message.senderId),
        });
    }

    // Edit and delete are author-only: the vault enforces it on both ends, but
    // there is no reason to offer the action on someone else's message. A
    // tombstone offers neither.
    if (message.senderId === ctx.selfId && !message.deleted) {
        if (message.body.trim()) {
            items.push({
                label: "Edit",
                icon: <Pencil size={13} />,
                onSelect: () => ctx.handleStartEdit(message),
            });
        }
        items.push({
            label: "Delete",
            icon: <Trash2 size={13} />,
            danger: true,
            onSelect: () => ctx.handleDelete(message),
        });
    }

    return items;
}

/** Everything the header (channel) context menu needs from the page. */
export interface HeaderMenuContext {
    isDm: boolean;
    dmBlocked: boolean;
    contacts: Record<string, Contact>;
    openProfile: (userId: string) => void;
    copyChannelCode: () => void;
    setRenamingChannel: (open: boolean) => void;
    onPickIcon: () => void;
    handleRemoveIcon: () => void;
    handleToggleBlock: () => void;
    handleLeave: () => void;
}

export function buildHeaderMenuItems(
    channel: StoredChannel,
    ctx: HeaderMenuContext,
): MenuItem[] {
    const items: MenuItem[] = [];
    // A DM's header opens the peer's profile; a group has no single person.
    if (
        ctx.isDm &&
        channel.peerId &&
        !channel.incognito &&
        ctx.contacts[channel.peerId]
    ) {
        items.push({
            label: "View profile",
            icon: <User size={14} />,
            onSelect: () => ctx.openProfile(channel.peerId!),
        });
    }
    items.push(
        {
            label: "Copy channel code",
            icon: <Copy size={14} />,
            onSelect: () => ctx.copyChannelCode(),
        },
        {
            label: channel.label ? "Rename" : "Set a name",
            icon: <Pencil size={14} />,
            onSelect: () => ctx.setRenamingChannel(true),
        },
    );
    // A group's picture is settable; a DM's icon always tracks the peer.
    if (!ctx.isDm) {
        items.push({
            label: channel.icon ? "Change picture" : "Set a picture",
            icon: <ImageIcon size={14} />,
            onSelect: () => ctx.onPickIcon(),
        });
        if (channel.icon) {
            items.push({
                label: "Remove picture",
                icon: <Trash2 size={14} />,
                onSelect: () => ctx.handleRemoveIcon(),
            });
        }
    }
    if (ctx.isDm) {
        items.push({
            label: ctx.dmBlocked ? "Unblock" : "Block",
            icon: <Ban size={14} />,
            danger: !ctx.dmBlocked,
            onSelect: () => ctx.handleToggleBlock(),
        });
    }
    items.push({
        label: ctx.isDm ? "Leave conversation" : "Leave channel",
        icon: <LogOut size={14} />,
        danger: true,
        onSelect: () => ctx.handleLeave(),
    });
    return items;
}
