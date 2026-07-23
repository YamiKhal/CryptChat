import { useState, useEffect, useCallback } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Trash2 } from "lucide-react";
import { api, TwoFactorCredential } from "@/lib/api";
import {
    SettingsSection,
    SettingBlock,
} from "@/components/settings/SettingsUI";

/**
 * Two-factor (WebAuthn) management.
 *
 * Self-contained: it fetches its own credential list so Settings does not have
 * to thread the state through. The copy is deliberately honest about scope --
 * this protects the login path, not the vault. Someone with a stolen database
 * dump AND the password decrypts the vault directly; the assertion never runs.
 * It is not a substitute for a strong password and the panel says so.
 */

export default function TwoFactorSection({ token }: { token: string }) {
    const [credentials, setCredentials] = useState<TwoFactorCredential[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [label, setLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{
        kind: "ok" | "error";
        text: string;
    } | null>(null);

    const reload = useCallback(() => {
        api.twoFactorStatus(token)
            .then((res) => setCredentials(res.credentials))
            .catch(() => {})
            .finally(() => setLoaded(true));
    }, [token]);

    useEffect(reload, [reload]);

    async function enroll() {
        setStatus(null);
        setBusy(true);
        try {
            const { options, challengeToken } =
                await api.twoFactorRegisterOptions(token);
            // Prompts the authenticator to create a credential. Throws on cancel.
            const response = await startRegistration({
                optionsJSON: options as Parameters<
                    typeof startRegistration
                >[0]["optionsJSON"],
            });
            await api.twoFactorRegisterVerify(token, {
                response,
                challengeToken,
                label: label.trim() || undefined,
            });
            setLabel("");
            setStatus({
                kind: "ok",
                text: "Security key added. It is now required at login.",
            });
            reload();
        } catch (err) {
            // A user cancelling the browser prompt lands here too; keep it gentle.
            setStatus({
                kind: "error",
                text: (err as Error).message || "enrollment cancelled",
            });
        } finally {
            setBusy(false);
        }
    }

    async function remove(cred: TwoFactorCredential) {
        if (
            !confirm(
                `Remove "${cred.label}"?\n\n` +
                    (credentials.length === 1
                        ? "This is your last key. login will no longer ask for a second factor."
                        : "You will still need one of your other keys at login."),
            )
        ) {
            return;
        }
        setBusy(true);
        try {
            await api.twoFactorRemove(token, cred.id);
            reload();
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <SettingsSection
            title="Two-factor login"
            info="A passkey or security key asked for at login, on top of your password."
            infoDetails="A passkey or security key asked for at login, on top of your password. It protects against a stolen password. but not against a leaked backup: your messages are encrypted under your password, which this does not replace. It is an extra lock on the door, not a stronger vault."
        >
            {(status || (loaded && credentials.length > 0)) && (
                <SettingBlock>
                    {status && (
                        <p
                            className={`t-small rounded border p-3 ${
                                status.kind === "ok"
                                    ? "border-primary-line bg-primary-soft text-primary"
                                    : "border-error-line bg-error-soft text-error"
                            }`}
                        >
                            {status.text}
                        </p>
                    )}

                    {loaded && credentials.length > 0 && (
                        <ul className="space-y-1">
                            {credentials.map((cred) => (
                                <li
                                    key={cred.id}
                                    className="border-border bg-surface-raised flex items-center gap-2 rounded border px-3 py-2"
                                >
                                    <span className="t-base flex-1 truncate">
                                        {cred.label}
                                    </span>
                                    <span className="t-small text-muted">
                                        {new Date(
                                            cred.createdAt,
                                        ).toLocaleDateString()}
                                    </span>
                                    <button
                                        onClick={() => remove(cred)}
                                        disabled={busy}
                                        className="text-muted hover:text-error"
                                        title="Remove"
                                        aria-label={`Remove ${cred.label}`}
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </SettingBlock>
            )}

            <SettingBlock>
                <label className="block space-y-1">
                    <span className="t-base text-muted">
                        name for a new key (optional)
                    </span>
                    <input
                        className="field"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="e.g. YubiKey, phone"
                        maxLength={64}
                    />
                </label>

                <button
                    onClick={enroll}
                    disabled={busy}
                    className="btn-ghost t-base w-full"
                >
                    {credentials.length > 0
                        ? "add another security key"
                        : "add a security key"}
                </button>
            </SettingBlock>
        </SettingsSection>
    );
}
