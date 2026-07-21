import { useState } from "react";
import { StoredChannel } from "@/lib/vault";

export const MAX_CHANNEL_NAME = 60;

export function ChannelNameModal({
    channel,
    onClose,
    onSubmit,
}: {
    channel: StoredChannel;
    onClose: () => void;
    onSubmit: (name: string) => void;
}) {
    const [name, setName] = useState(channel.label ?? "");

    function submit() {
        onSubmit(name);
        onClose();
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={onClose}
        >
            <div
                className="border-border bg-surface w-full max-w-xs space-y-3 rounded-lg border p-4"
                onClick={(e) => e.stopPropagation()}
            >
                <p className="t-base text-muted">Name this channel</p>
                <input
                    className="field"
                    value={name}
                    maxLength={MAX_CHANNEL_NAME}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder="channel name"
                    autoFocus
                />
                <p className="t-small text-muted">
                    This is a local rename. Only you would be able to see this
                    name change.
                </p>
                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="btn-ghost t-base">
                        cancel
                    </button>
                    <button onClick={submit} className="btn-primary t-base">
                        save
                    </button>
                </div>
            </div>
        </div>
    );
}
