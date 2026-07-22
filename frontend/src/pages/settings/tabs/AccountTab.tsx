import { useState, useEffect } from "react";
import { useSession } from "@/lib/session";
import { keyFingerprint } from "@/lib/crypto";
import { api, EmailState } from "@/lib/api";
import { Vault, AccountDescriptor } from "@/lib/vault";
import { InfoTip } from "@/components/ui/InfoTip";
import TwoFactorSection from "@/components/settings/TwoFactorSection";
import {
    SettingsSection,
    SettingBlock,
    SettingRow,
} from "@/components/settings/SettingsUI";
import { SetStatus } from "@/pages/settings/types";

export default function AccountTab({
    vault,
    account,
    setStatus,
}: {
    vault: Vault;
    account: AccountDescriptor;
    setStatus: SetStatus;
}) {
    const session = useSession();

    const [fingerprint, setFingerprint] = useState("");
    const [email, setEmail] = useState<EmailState | null>(null);
    const [emailInput, setEmailInput] = useState("");
    const [emailPassword, setEmailPassword] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        keyFingerprint(vault.identity.signPublicKey).then(setFingerprint);
    }, [vault]);

    useEffect(() => {
        if (!session.token) return;
        let cancelled = false;
        api.getEmail(session.token)
            .then((res) => !cancelled && setEmail(res))
            .catch(() => !cancelled && setEmail({ mask: null, verified: false }));
        return () => {
            cancelled = true;
        };
    }, [session.token]);

    async function handleSetEmail() {
        setStatus(null);
        setBusy(true);
        try {
            const res = await api.setEmail(
                session.token!,
                emailInput.trim(),
                emailPassword,
            );
            setEmail((e) => ({
                ...(e ?? { mask: null, verified: false }),
                pendingMask: res.pendingMask,
            }));
            setEmailInput("");
            setEmailPassword("");
            setStatus({
                kind: "ok",
                text: "Confirmation link sent. The address is not attached until you use it.",
            });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    async function handleRemoveEmail() {
        setStatus(null);
        // Losing the address means losing password reset entirely, and the recovery
        // code alone cannot get you back in -- worth one confirmation.
        if (
            !confirm(
                "Remove your email?\n\nYou will no longer be able to reset a forgotten password. Your recovery code alone cannot log you in.",
            )
        ) {
            return;
        }
        setBusy(true);
        try {
            await api.removeEmail(session.token!, emailPassword);
            setEmail({ mask: null, verified: false });
            setEmailPassword("");
            setStatus({
                kind: "ok",
                text: "Address removed. The stored ciphertext is gone.",
            });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-8">
            <SettingsSection title="Identity">
                <SettingRow
                    title="Username"
                    control={
                        <span className="t-base font-mono text-muted">
                            {account.username}
                        </span>
                    }
                />
                <SettingRow
                    title="Key fingerprint"
                    info="Read this to a contact to confirm no one swapped keys."
                    infoDetails="Read this to a contact over another channel. If it matches what they see next to your name, no one swapped keys in between."
                >
                    <p className="t-base text-primary font-mono tracking-wider">
                        {fingerprint}
                    </p>
                </SettingRow>
            </SettingsSection>

            {session.token && <TwoFactorSection token={session.token} />}

            <SettingsSection
                title="Email"
                info="Optional, encrypted, and only for password resets."
                infoDetails="Shown partially on purpose — the full address is encrypted and the server only decrypts it to send you mail. Nobody can read it back out, including you. It exists so you can reset a forgotten password; it cannot decrypt your channels, and an account without one works exactly the same otherwise."
            >
                <SettingBlock>
                    {email === null ? (
                        <p className="t-base text-muted">loading…</p>
                    ) : email.mask ? (
                        <div className="t-base space-y-1">
                            <p className="text-muted">on file</p>
                            <p className="flex items-center gap-2 font-mono">
                                {email.mask}
                                {email.verified ? (
                                    <span className="tag bg-ok-soft text-ok">
                                        verified
                                    </span>
                                ) : (
                                    <span className="tag bg-warn-soft text-warn">
                                        unconfirmed
                                    </span>
                                )}
                            </p>
                        </div>
                    ) : (
                        <p className="t-base text-muted">
                            No email on this account.
                        </p>
                    )}

                    {email?.pendingMask && (
                        <p className="border-info-line bg-info-soft t-base text-info rounded border p-3">
                            Waiting on confirmation for{" "}
                            <span className="font-mono">{email.pendingMask}</span>
                            . The link expires in 24 hours.
                        </p>
                    )}
                </SettingBlock>

                <SettingBlock>
                    <label className="block space-y-1">
                        <span className="t-base text-muted">
                            {email?.mask ? "change to" : "add an address"}
                        </span>
                        <input
                            className="field"
                            type="email"
                            autoComplete="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="t-base text-muted flex items-center gap-1.5">
                            your account password
                            <InfoTip
                                title="Why your password?"
                                tip="Anyone who could silently swap this address could hijack the account."
                                details="Your password is required here because anyone who could silently swap this address could take the account by resetting it."
                            />
                        </span>
                        <input
                            className="field"
                            type="password"
                            autoComplete="current-password"
                            value={emailPassword}
                            onChange={(e) => setEmailPassword(e.target.value)}
                        />
                    </label>

                    <button
                        className="btn-ghost t-base w-full"
                        disabled={busy || !emailInput.trim() || !emailPassword}
                        onClick={handleSetEmail}
                    >
                        {email?.mask ? "change address" : "add address"}
                    </button>

                    {email?.mask && (
                        <button
                            className="t-base text-error w-full hover:underline"
                            disabled={busy || !emailPassword}
                            onClick={handleRemoveEmail}
                        >
                            remove my address
                        </button>
                    )}
                </SettingBlock>
            </SettingsSection>
        </div>
    );
}
