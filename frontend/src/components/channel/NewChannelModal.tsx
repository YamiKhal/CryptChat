import { useState } from "react";
import { Plus, LogIn, ArrowLeft } from "lucide-react";
import { MAX_CHANNEL_NAME } from "@/components/channel/ChannelNameModal";

type Mode = "choice" | "create" | "join";

export function NewChannelModal({
    premium,
    busy,
    error,
    onCreate,
    onJoin,
    onClose,
}: {
    premium: boolean;
    busy: boolean;
    error: string;
    onCreate: (name: string, incognito: boolean) => void;
    onJoin: (code: string) => void;
    onClose: () => void;
}) {
    const [mode, setMode] = useState<Mode>("choice");
    const [name, setName] = useState("");
    const [incognito, setIncognito] = useState(false);
    const [code, setCode] = useState("");

    return (
        <div
            className="modal-backdrop"
            onClick={onClose}
        >
            <div
                className="modal-panel max-w-xs space-y-3"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                    {mode !== "choice" && (
                        <button
                            onClick={() => setMode("choice")}
                            className="text-muted hover:text-primary transition-colors"
                            title="Back"
                            aria-label="Back"
                        >
                            <ArrowLeft size={16} />
                        </button>
                    )}
                    <p className="t-base text-muted">
                        {mode === "choice"
                            ? "New channel"
                            : mode === "create"
                              ? "Create a channel"
                              : "Join a channel"}
                    </p>
                </div>

                {mode === "choice" && (
                    <div className="space-y-2">
                        <button
                            onClick={() => setMode("create")}
                            className="btn-ghost w-full justify-start"
                        >
                            <Plus size={16} />
                            Create a channel
                        </button>
                        <button
                            onClick={() => setMode("join")}
                            className="btn-ghost w-full justify-start"
                        >
                            <LogIn size={16} />
                            Join with a code
                        </button>
                    </div>
                )}

                {mode === "create" && (
                    <div className="space-y-3">
                        <input
                            className="field w-full"
                            placeholder="channel name (optional)"
                            maxLength={MAX_CHANNEL_NAME}
                            value={name}
                            autoFocus
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !busy &&
                                onCreate(name, incognito)
                            }
                        />

                        {premium && (
                            <label className="flex items-start gap-2">
                                <input
                                    type="checkbox"
                                    className="accent-primary mt-0.5"
                                    checked={incognito}
                                    onChange={(e) =>
                                        setIncognito(e.target.checked)
                                    }
                                />
                                <span className="t-small">
                                    Incognito
                                    <span className="text-muted mt-0.5 block">
                                        Members show as colours — no names, no
                                        avatars. Hides who's who in the UI, not
                                        from the server.
                                    </span>
                                </span>
                            </label>
                        )}

                        <button
                            onClick={() => onCreate(name, incognito)}
                            disabled={busy}
                            className="btn-primary w-full"
                        >
                            Create {incognito ? "incognito " : ""}channel
                        </button>
                    </div>
                )}

                {mode === "join" && (
                    <div className="space-y-3">
                        <input
                            className="field w-full font-mono tracking-widest uppercase"
                            placeholder="XXXXXXXX"
                            maxLength={8}
                            value={code}
                            autoFocus
                            onChange={(e) =>
                                setCode(e.target.value.toUpperCase())
                            }
                            onKeyDown={(e) =>
                                e.key === "Enter" &&
                                !busy &&
                                code.trim() &&
                                onJoin(code)
                            }
                        />
                        <button
                            onClick={() => onJoin(code)}
                            disabled={busy || !code.trim()}
                            className="btn-primary w-full"
                        >
                            Join channel
                        </button>
                    </div>
                )}

                {error && <p className="t-small text-error">{error}</p>}
            </div>
        </div>
    );
}
