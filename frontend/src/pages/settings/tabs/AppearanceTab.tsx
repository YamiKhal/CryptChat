import { useState, useEffect } from "react";
import { useSession } from "@/lib/session";
import { base64UrlToBytes, bytesToDataUrl } from "@/lib/binary";
import { Vault, ChatTextSize } from "@/lib/vault";
import ThemeToggle from "@/components/theme/ThemeToggle";
import ThemeCustomizer from "@/components/settings/ThemeCustomizer";
import { Toggle } from "@/components/ui/Toggle";
import {
    SettingsSection,
    SettingRow,
    SegmentedControl,
} from "@/components/settings/SettingsUI";
import { ChatPreview } from "@/pages/settings/components/ChatPreview";
import { useBillingBadge } from "@/pages/settings/useBillingBadge";
import { SetStatus } from "@/pages/settings/types";

const LOCALE_HOUR12 =
    new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hour12 ??
    false;

const TEXT_SIZE_OPTIONS: { value: ChatTextSize; label: string }[] = [
    { value: "tiny", label: "Tiny" },
    { value: "small", label: "Small" },
    { value: "normal", label: "Normal" },
    { value: "large", label: "Large" },
];

export default function AppearanceTab({
    vault,
    setStatus,
}: {
    vault: Vault;
    setStatus: SetStatus;
}) {
    const session = useSession();
    const { badge } = useBillingBadge(session.token);

    const [alwaysPreview, setAlwaysPreview] = useState(false);
    const [showBadge, setShowBadge] = useState(false);
    const [leftAligned, setLeftAligned] = useState(false);
    const [textSize, setTextSize] = useState<ChatTextSize>("normal");
    const [hideImages, setHideImages] = useState(false);
    const [hideBubbles, setHideBubbles] = useState(false);
    const [clock12h, setClock12h] = useState(false);

    useEffect(() => {
        setAlwaysPreview(vault.preferences.alwaysPreviewLinks);
        setShowBadge(Boolean(vault.preferences.showSupporterBadge));
        setLeftAligned(Boolean(vault.preferences.messagesLeftAligned));
        setTextSize(vault.preferences.chatTextSize ?? "normal");
        setHideImages(Boolean(vault.preferences.hideProfileImages));
        setHideBubbles(Boolean(vault.preferences.hideMessageBubbles));
        setClock12h(vault.preferences.clock12h ?? LOCALE_HOUR12);
    }, [vault]);

    async function handlePreviewToggle(next: boolean) {
        setAlwaysPreview(next);
        try {
            await vault.setPreferences({ alwaysPreviewLinks: next });
            session.refresh();
        } catch (err) {
            setAlwaysPreview(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleToggleShowBadge(next: boolean) {
        setShowBadge(next);
        try {
            await vault.setPreferences({ showSupporterBadge: next });
            session.refresh();
        } catch (err) {
            setShowBadge(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSetLeftAligned(next: boolean) {
        setLeftAligned(next);
        try {
            await vault.setPreferences({ messagesLeftAligned: next });
            session.refresh();
        } catch (err) {
            setLeftAligned(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSetTextSize(next: ChatTextSize) {
        const prev = textSize;
        setTextSize(next);
        try {
            await vault.setPreferences({ chatTextSize: next });
            session.refresh();
        } catch (err) {
            setTextSize(prev);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSetHideImages(next: boolean) {
        setHideImages(next);
        try {
            await vault.setPreferences({ hideProfileImages: next });
            session.refresh();
        } catch (err) {
            setHideImages(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSetHideBubbles(next: boolean) {
        setHideBubbles(next);
        try {
            await vault.setPreferences({ hideMessageBubbles: next });
            session.refresh();
        } catch (err) {
            setHideBubbles(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function handleSetClock12h(next: boolean) {
        setClock12h(next);
        try {
            await vault.setPreferences({ clock12h: next });
            session.refresh();
        } catch (err) {
            setClock12h(!next);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    // Current wallpaper as a data URL, so the preview can show it behind the
    // sample messages. Reads straight from the vault, which ThemeCustomizer
    // persists to; session.refresh re-renders this after a change.
    const wallpaperAsset = vault.preferences.chatBackground;
    const wallpaperUrl = wallpaperAsset
        ? bytesToDataUrl(
              base64UrlToBytes(wallpaperAsset.data),
              wallpaperAsset.mime,
          )
        : undefined;

    return (
        <div className="space-y-8">
            {/* Live preview. Reflects text size and the picture / column
                choices, the custom palette (which applies to the page's CSS
                tokens live), a set wallpaper and the supporter crown. */}
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
                infoDetails="Your theme choice is stored only on this device. the server never sees it. Dark is the default."
            >
                <SettingRow title="Light / dark" control={<ThemeToggle />} />
            </SettingsSection>

            <ThemeCustomizer
                vault={vault}
                isPremium={!!badge}
                onChange={session.refresh}
            />

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
                    infoDetails="Switches message timestamps between 24-hour (15:05) and 12-hour (3:05 PM). Defaults to your device's own convention until you choose. A local display preference. it changes nothing about what you send."
                >
                    <div className="pt-1">
                        <SegmentedControl
                            value={clock12h ? "12" : "24"}
                            options={[
                                { value: "24", label: "24h" },
                                { value: "12", label: "12h" },
                            ]}
                            onChange={(v) => handleSetClock12h(v === "12")}
                        />
                    </div>
                </SettingRow>

                <SettingRow
                    title="Profile pictures"
                    description="Show avatars beside messages."
                    info="Hide them for a denser transcript."
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
                    description="Wrap messages in a colored bubble."
                    info="Turn off for a flat, IRC-style transcript with no bubble behind the text."
                    infoDetails="With bubbles off, message text sits directly on the chat background with no fill, border, or tail. Spacing and alignment are unchanged. only the bubble's paint is dropped. A purely local display choice."
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
                    description="Every message on the left, Discord-style."
                    info="Yours included, each under its own name."
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

            {/* Supporter-badge visibility. a display choice, so it lives with
                the rest of them. Only a supporter has a crown to show. */}
            {badge && (
                <SettingsSection title="Supporter badge">
                    <SettingRow
                        title="Show my crown"
                        description="Crown on your messages."
                        info="Just cosmetic. Never shown in incognito."
                        infoDetails="When on, a supporter crown appears on your messages for others. It is a personal flourish, not proof of payment. anyone's client can display one. and it is never shown in incognito channels. Paid status is a detail about you, so sharing it is your choice."
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
                    description="Prefix a link with ! to preview just that one."
                    info="On means the server fetches every link you send."
                    infoDetails="Building a preview asks the server to fetch that URL, so the relay learns which link you sent. the one thing it otherwise never sees. The preview itself is encrypted and sent with your message, so people reading it never load anything and their IP stays private. Links always work as plain clickable text with this off."
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
    );
}
