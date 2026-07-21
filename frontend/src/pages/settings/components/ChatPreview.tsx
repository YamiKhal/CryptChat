import Badge from "@/components/ui/Badge";
import { ChatTextSize } from "@/lib/vault";

/**
 * A miniature transcript that mirrors the chat-display choices live. It carries
 * its own data-chat-size so the CSS size variables resolve exactly as they will
 * in a real chat, and remounts on any change (via key) to replay the fade.
 */
export function ChatPreview({
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
        return d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12,
        });
    };
    return (
        <div className="space-y-1.5">
            <p className="t-base text-muted px-1 font-medium">Preview</p>
            <div
                key={`${size}-${hideImages}-${hideBubbles}-${hour12}-${leftAligned}-${Boolean(wallpaper)}-${Boolean(supporter)}`}
                data-chat-size={size}
                data-chat-bubbles={hideBubbles ? "hidden" : undefined}
                className="animate-fade-in border-border bg-bg space-y-2 rounded-lg border bg-cover bg-center p-3 motion-reduce:animate-none"
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
        <div
            className={`flex items-start gap-2 ${right ? "flex-row-reverse" : ""}`}
        >
            {!hideImages && (
                <div
                    className="border-border bg-surface-raised flex-none rounded-full border"
                    style={{
                        width: "var(--chat-avatar)",
                        height: "var(--chat-avatar)",
                    }}
                />
            )}
            <div
                className={`flex min-w-0 flex-col ${right ? "items-end" : "items-start"}`}
            >
                <span
                    className={`flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}
                    style={{ fontSize: "var(--chat-name)" }}
                >
                    <span className="text-foreground font-semibold">
                        {name}
                    </span>
                    {supporter && <Badge size="sm" />}
                    <span
                        className="text-muted"
                        style={{ fontSize: "var(--chat-time)" }}
                    >
                        {time}
                    </span>
                </span>
                <div
                    data-bubble
                    className="mt-0.5 w-fit rounded-lg border px-2 py-1"
                    style={{
                        fontSize: "var(--chat-body)",
                        background: right
                            ? "var(--bubble-self-bg)"
                            : "var(--bubble-other-bg)",
                        borderColor: right
                            ? "var(--bubble-self-border)"
                            : "var(--bubble-other-border)",
                    }}
                >
                    {text}
                </div>
            </div>
        </div>
    );
}
