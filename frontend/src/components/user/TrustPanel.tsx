import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, X } from "lucide-react";
import { safetyNumber, keyFingerprint } from "@/lib/crypto";
import type { Contact } from "@/lib/vault";

// The pinned key stays until a fresh safety-number comparison; accepting a
// changed key is a separate flow (it needs the pending new key, which TOFU
// deliberately does not retain). Here we only warn and let the user re-verify.

/**
 * End-to-end trust verification.
 *
 * The encryption proves a message came from whoever holds a given signing key.
 * It cannot prove that key belongs to the person you think -- a malicious relay
 * could hand each side a key it controls and sit in the middle. The only fix is
 * out-of-band comparison: both people read the same safety number and confirm it
 * matches. This panel shows that number and lets the user record the result.
 *
 * A verified mark is tied to a specific key; the vault clears it automatically
 * if the key ever changes and this panel surfaces that as a loud warning.
 */

interface Props {
    mySignKey: string;
    /** The contact(s) to verify. Opened from a message menu, this is one person. */
    contacts: Contact[];
    /** Session-scoped verification lookup (not persisted). */
    isVerified: (userId: string) => boolean;
    onClose: () => void;
    onSetVerified: (userId: string, verified: boolean) => void;
}

interface Derived {
    number: string;
    theirFp: string;
}

export default function TrustPanel({
    mySignKey,
    contacts,
    isVerified,
    onClose,
    onSetVerified,
}: Props) {
    const [derived, setDerived] = useState<Record<string, Derived>>({});
    const [myFp, setMyFp] = useState("");

    useEffect(() => {
        let cancelled = false;
        keyFingerprint(mySignKey).then((fp) => !cancelled && setMyFp(fp));
        (async () => {
            const out: Record<string, Derived> = {};
            for (const c of contacts) {
                out[c.userId] = {
                    number: await safetyNumber(mySignKey, c.signPublicKey),
                    theirFp: await keyFingerprint(c.signPublicKey),
                };
            }
            if (!cancelled) setDerived(out);
        })();
        return () => {
            cancelled = true;
        };
    }, [mySignKey, contacts]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black p-4 sm:items-center"
            onClick={onClose}
        >
            <div
                className="modal-panel max-h-[85vh] max-w-md space-y-3 overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                    <h2 className="t-h4 flex-1 font-semibold tracking-wider uppercase">
                        verify contacts
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-muted hover:text-foreground"
                        aria-label="Close"
                    >
                        <X size={18} />
                    </button>
                </div>

                <p className="t-small text-muted">
                    Compare a safety number with the other person over a channel
                    you already trust. in person, a call, another app. If both
                    of you see the same number, no one is sitting in the middle.
                    Then mark them verified. This lasts the current session
                    only. you will verify again after reconnecting or logging
                    back in.
                </p>

                <div className="border-border bg-surface-raised t-small space-y-1 rounded border p-3">
                    <p className="text-muted">your key fingerprint</p>
                    <p className="text-primary font-mono tracking-wider">
                        {myFp || "…"}
                    </p>
                </div>

                {contacts.length === 0 && (
                    <p className="t-base text-muted">
                        No one to verify yet. a contact appears here once they
                        have sent a message.
                    </p>
                )}

                {contacts.map((c) => {
                    const d = derived[c.userId];
                    const verified = isVerified(c.userId);
                    return (
                        <div
                            key={c.userId}
                            className="border-border space-y-2 rounded border p-3"
                        >
                            <div className="flex items-center gap-2">
                                <span className="t-h4 flex-1 truncate font-medium">
                                    {c.displayName || "unknown"}
                                </span>
                                {c.keyChangedAt ? (
                                    <span className="tag bg-error-soft text-error inline-flex items-center gap-1">
                                        <ShieldAlert size={11} /> key changed
                                    </span>
                                ) : verified ? (
                                    <span className="tag bg-ok-soft text-ok inline-flex items-center gap-1">
                                        <ShieldCheck size={11} /> verified
                                    </span>
                                ) : (
                                    <span className="tag bg-warn-soft text-warn">
                                        unverified
                                    </span>
                                )}
                            </div>

                            {c.keyChangedAt && (
                                <p className="border-error-line bg-error-soft t-small text-error rounded border p-2">
                                    This contact's signing key changed. That
                                    happens on a reinstall or new device. but it
                                    is also exactly what a relay attack looks
                                    like. Verify a fresh safety number before
                                    trusting it again.
                                </p>
                            )}

                            <div className="space-y-1">
                                <p className="t-small text-muted">
                                    safety number
                                </p>
                                <p className="bg-surface-raised t-small rounded p-2 font-mono leading-relaxed tracking-wider">
                                    {d?.number ?? "…"}
                                </p>
                            </div>

                            <button
                                onClick={() =>
                                    onSetVerified(c.userId, !verified)
                                }
                                className={`t-base ${verified ? "btn-ghost" : "btn-primary"} px-3 py-1.5`}
                            >
                                {verified
                                    ? "remove verification"
                                    : "mark as verified"}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
