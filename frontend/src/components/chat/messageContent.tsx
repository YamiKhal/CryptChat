import { useEffect, useState, Fragment, ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { BinaryAsset, unpackAsset, decodeImage } from "@/lib/binary";
import { segmentize } from "@/lib/links";
import { InlineNode, toBlocks } from "@/lib/format";
import MediaViewer from "@/components/chat/MediaViewer";

/**
 * Turn a run of plain text into React, promoting URLs to anchors.
 *
 * `segmentize` returns data, never markup, so peer-controlled text can never
 * turn into HTML. Anchors are http/https only and carry noopener/noreferrer,
 * and nothing is prefetched: rendering a message must not cause a network
 * request.
 */
function renderText(text: string): ReactNode {
    return segmentize(text).map((segment, i) =>
        segment.type === "link" ? (
            <a
                key={i}
                href={segment.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary decoration-primary hover:decoration-primary-strong underline underline-offset-2"
                onClick={(e) => e.stopPropagation()}
            >
                {segment.value}
            </a>
        ) : (
            <Fragment key={i}>{segment.value}</Fragment>
        ),
    );
}

/**
 * An inline `||spoiler||` run.
 *
 * Covered by a solid box until clicked. The revealed flag lives in component
 * state, so it resets the moment the bubble unmounts -- leaving and reopening
 * the chat hides it again. Once revealed the text keeps a faint tint so it stays
 * legible that these words were hidden. Click is used rather than hover so it
 * works the same by tap on touch and it stops propagation so revealing a word
 * does not also trigger the whole-message spoiler behind it.
 */
function InlineSpoiler({ children }: { children: ReactNode }) {
    const [revealed, setRevealed] = useState(false);

    if (revealed) {
        return (
            <span className="bg-surface-raised rounded-sm px-0.5">
                {children}
            </span>
        );
    }

    return (
        <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
                e.stopPropagation();
                setRevealed(true);
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setRevealed(true);
                }
            }}
            className="bg-foreground cursor-pointer rounded-sm align-baseline text-transparent transition select-none"
            title="Spoiler. click to reveal"
        >
            {children}
        </span>
    );
}

/** Render a parsed inline node tree, recursing through the formatting marks. */
function renderInline(nodes: InlineNode[]): ReactNode {
    return nodes.map((node, i) => {
        switch (node.type) {
            case "text":
                return <Fragment key={i}>{renderText(node.value)}</Fragment>;
            case "bold":
                return (
                    <strong key={i} className="font-semibold">
                        {renderInline(node.children)}
                    </strong>
                );
            case "italic":
                return <em key={i}>{renderInline(node.children)}</em>;
            case "strike":
                return <s key={i}>{renderInline(node.children)}</s>;
            case "spoiler":
                return (
                    <InlineSpoiler key={i}>
                        {renderInline(node.children)}
                    </InlineSpoiler>
                );
        }
    });
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
    1: "t-h3 font-semibold",
    2: "t-h4 font-semibold",
    3: "t-lead font-semibold",
};

/**
 * Render a message body with formatting (**bold**, __italic__, ~~strike~~,
 * ||spoiler|| and `#` headings) plus clickable links.
 *
 * `trailing` is inline chrome (edited marker, lock/burn icons) flowed onto the
 * end of the LAST line rather than dropped onto a new one, so short appendages
 * ride alongside the text and wrap with it.
 */
export function Body({
    text,
    trailing,
}: {
    text: string;
    trailing?: ReactNode;
}) {
    const blocks = toBlocks(text);
    return (
        <div className="wrap-break-word">
            {blocks.map((block, i) => {
                const last = i === blocks.length - 1;
                const content = (
                    <>
                        {renderInline(block.children)}
                        {last && trailing}
                    </>
                );
                return block.type === "heading" ? (
                    <p
                        key={i}
                        className={`${HEADING_CLASS[block.level]} mt-1 first:mt-0`}
                    >
                        {content}
                    </p>
                ) : (
                    <p key={i} className="whitespace-pre-wrap">
                        {content}
                    </p>
                );
            })}
        </div>
    );
}

/**
 * A password-locked message the recipient has not opened yet.
 *
 * The whole body is the unlock button. tap it and the password prompt opens
 * (the context menu still offers Unlock too). Minimal chrome: a lock, one word,
 * the hint if there is one. The plaintext only ever lands in the unlocking
 * user's own vault.
 */
export function LockedBody({
    hint,
    onUnlock,
}: {
    hint?: string;
    onUnlock?: () => void;
}) {
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onUnlock?.();
            }}
            disabled={!onUnlock}
            className="group/lock -mx-0.5 flex items-center gap-2 rounded-md px-0.5 py-0.5 text-left disabled:cursor-default"
            title={onUnlock ? "Unlock this message" : undefined}
        >
            <span className="bg-surface text-muted group-hover/lock:bg-primary-soft group-hover/lock:text-primary grid size-7 flex-none place-items-center rounded-full transition-colors">
                <LockKeyhole size={13} aria-hidden="true" />
            </span>
            <span className="min-w-0">
                <span className="t-base text-foreground block font-medium">
                    Locked
                </span>
                <span className="t-small text-muted block">
                    {hint
                        ? hint
                        : onUnlock
                          ? "tap to unlock"
                          : "locked message"}
                </span>
            </span>
        </button>
    );
}

/** Decodes an attached image back to an object URL for the life of the bubble.
 *  `bare` drops the in-bubble framing (margin + border) for an image-only
 *  message, which is rendered as a plain rounded photo with no bubble chrome. */
export function Attachment({
    asset,
    bare,
}: {
    asset: BinaryAsset;
    bare?: boolean;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let release: (() => void) | null = null;
        try {
            const decoded = unpackAsset(asset);
            const handle = decodeImage(decoded.bytes, decoded.mime);
            release = handle.release;
            setUrl(handle.url);
        } catch {
            setFailed(true);
        }
        return () => release?.();
    }, [asset]);

    if (failed)
        return <p className="t-base text-error">unsupported attachment</p>;
    if (!url) return null;

    return (
        <MediaViewer src={url}>
            <img
                src={url}
                alt=""
                className={
                    bare
                        ? "max-h-80 w-full max-w-full rounded-2xl object-contain"
                        : "border-border mt-1 max-h-64 w-full max-w-full rounded border object-contain"
                }
            />
        </MediaViewer>
    );
}
