import { useState, useEffect } from "react";
import { LinkPreview } from "@/lib/crypto";
import { unpackAsset, decodeImage } from "@/lib/binary";
import { isSafeUrl } from "@/lib/links";
import MediaViewer from "@/components/chat/MediaViewer";

/**
 * A link preview, rendered entirely from the encrypted envelope.
 *
 * Every byte here -- title, description, thumbnail -- was fetched by the
 * *sender* and shipped E2E. This component makes no network request of any
 * kind. That is the whole design: if it loaded a remote image or embedded a
 * YouTube iframe, every recipient's IP address would be handed to that host
 * the moment the message rendered and posting a link to a server you control
 * would deanonymize the channel.
 *
 * The YouTube "embed" is therefore a thumbnail and a link, not an iframe.
 * Clicking is the user's own explicit choice to reveal themselves.
 */
export default function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
    const [imageUrl, setImageUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!preview.image) return;
        let release: (() => void) | null = null;
        try {
            const decoded = unpackAsset(preview.image);
            const handle = decodeImage(decoded.bytes, decoded.mime);
            release = handle.release;
            setImageUrl(handle.url);
        } catch {
            setImageUrl(null);
        }
        return () => release?.();
    }, [preview.image]);

    // The sender controls this URL, so re-check the scheme rather than trusting
    // it: javascript: in an href is script execution.
    if (!isSafeUrl(preview.url)) return null;

    let host = "";
    try {
        host = new URL(preview.url).hostname;
    } catch {
        return null;
    }

    // A link that is itself an image renders as the image, with no card chrome.
    // The bytes came E2E in the envelope and unpackAsset already rejected
    // anything off the image allowlist, so a GIF here plays with its frames
    // intact -- it was never run through the canvas.
    if (preview.kind === "image") {
        if (!imageUrl) return null;
        return (
            <div className="border-border mt-1 overflow-hidden rounded border">
                <MediaViewer src={imageUrl}>
                    <img
                        src={imageUrl}
                        alt=""
                        className="max-h-80 w-auto max-w-full object-contain"
                    />
                </MediaViewer>
            </div>
        );
    }

    return (
        <a
            href={preview.url}
            target="_blank"
            // noreferrer also strips the Referer header, so the destination does not
            // learn which app sent the visitor. noopener stops window.opener access.
            rel="noopener noreferrer nofollow"
            className="border-border bg-surface hover:border-primary mt-1 block overflow-hidden rounded border transition-colors"
        >
            {imageUrl && (
                <div className="relative">
                    <img
                        src={imageUrl}
                        alt=""
                        className="max-h-48 w-full object-cover"
                    />
                    {preview.kind === "youtube" && (
                        <div className="absolute inset-0 grid place-items-center">
                            <span className="bg-surface text-primary grid h-10 w-10 place-items-center rounded-full">
                                ▶
                            </span>
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-0.5 p-2">
                <p className="t-small text-muted tracking-wider uppercase">
                    {preview.siteName || host}
                </p>
                {preview.title && (
                    <p className="t-base text-foreground line-clamp-2 font-medium">
                        {preview.title}
                    </p>
                )}
                {preview.description && (
                    <p className="t-small text-muted line-clamp-2">
                        {preview.description}
                    </p>
                )}
            </div>
        </a>
    );
}
