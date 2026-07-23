import { useState, FormEvent, useRef, ChangeEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useSession } from "@/lib/session";
import { readBackupFile } from "@/lib/backup/exportImport";
import Avatar from "@/components/ui/Avatar";
import { InfoTip } from "@/components/ui/InfoTip";

type Mode = "login" | "register";

export default function Auth() {
    const session = useSession();
    const navigate = useNavigate();

    const [mode, setMode] = useState<Mode>("login");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [email, setEmail] = useState("");
    const [remember, setRemember] = useState(true);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const recoveryPhrase = session.recoveryPhrase;
    const [phraseAcknowledged, setPhraseAcknowledged] = useState(false);
    const restoreInput = useRef<HTMLInputElement>(null);

    const locked = session.status === "locked" && session.account !== null;
    const needsImport = session.needsImport;

    async function handleRestoreFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setError("");
        setBusy(true);
        try {
            const container = await readBackupFile(file);
            // When restoring into a known account (the needs-import screen after
            // a login), the file must belong to that identity -- otherwise a
            // stray backup would silently replace it.
            if (
                session.account &&
                container.account.userId !== session.account.userId
            ) {
                throw new Error("this backup belongs to a different identity");
            }
            // Reloads into the locked screen, where the backup-era password
            // unlocks it. No navigate needed.
            await session.restoreFromBackup(container);
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        } finally {
            // Let the same file be re-picked if it failed.
            if (restoreInput.current) restoreInput.current.value = "";
        }
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError("");

        if (mode === "register" && password !== confirm) {
            setError("passwords do not match");
            return;
        }

        setBusy(true);

        try {
            if (locked) {
                await session.unlock(password, remember);
            } else if (mode === "register") {
                await session.register(
                    username,
                    password,
                    email.trim() || undefined,
                );
                // Deliberately does NOT navigate.
                return;
            } else {
                await session.login(username, password, remember);
            }
            navigate("/channels");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
            setPassword("");
            setConfirm("");
        }
    }

    return (
        <div className="grid min-h-screen place-items-center p-4">
            <div className="w-full max-w-sm space-y-4">
                <header className="space-y-1 text-center">
                    <h1 className="t-h1 text-primary font-bold tracking-tight">
                        CryptChat
                    </h1>
                    <p className="t-base text-muted">
                        end-to-end encrypted chat
                    </p>
                </header>

                {recoveryPhrase ? (
                    <div className="card space-y-4">
                        <h2 className="t-h4 text-muted font-semibold tracking-wider uppercase">
                            Your recovery code
                        </h2>

                        <p className="t-base text-warn">
                            Write these 24 words down and keep them somewhere
                            safe. This is the <strong>only</strong> way back
                            into your account if you forget your password or
                            lose this device. These will never be shown again.
                        </p>

                        <ol className="border-border bg-surface-raised grid grid-cols-3 gap-x-3 gap-y-1 rounded border p-4">
                            {recoveryPhrase.split(" ").map((word, i) => (
                                <li
                                    key={i}
                                    className="t-base flex gap-1.5 font-mono"
                                >
                                    <span className="truncate">{word}</span>
                                </li>
                            ))}
                        </ol>

                        <button
                            type="button"
                            className="btn-ghost t-base w-full"
                            onClick={() =>
                                navigator.clipboard?.writeText(recoveryPhrase)
                            }
                        >
                            copy to clipboard
                        </button>

                        <label className="t-base text-muted flex items-start gap-2">
                            <input
                                type="checkbox"
                                checked={phraseAcknowledged}
                                onChange={(e) =>
                                    setPhraseAcknowledged(e.target.checked)
                                }
                                className="accent-primary mt-0.5"
                            />
                            <span>
                                I wrote it down. Without it, a forgotten
                                password means my channels are gone for good.
                            </span>
                        </label>

                        <button
                            className="btn-primary w-full"
                            disabled={!phraseAcknowledged}
                            onClick={() => {
                                session.acknowledgeRecovery();
                                navigate("/channels");
                            }}
                        >
                            Continue
                        </button>
                    </div>
                ) : needsImport ? (
                    <div className="card space-y-4">
                        <div className="flex items-center gap-3">
                            <Avatar
                                name={session.account!.username}
                                size="md"
                            />
                            <div className="min-w-0">
                                <p className="t-h4 truncate font-medium">
                                    {session.account!.username}
                                </p>
                                <p className="t-base text-warn">
                                    nothing on this device
                                </p>
                            </div>
                        </div>

                        <p className="border-info-line bg-info-soft t-base text-info rounded-lg border p-3">
                            Password's right, but this device has none of your
                            data. the server never held it. Restore your backup
                            file to continue.
                        </p>

                        <input
                            ref={restoreInput}
                            type="file"
                            accept="application/json,.json"
                            className="hidden"
                            onChange={handleRestoreFile}
                        />
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => restoreInput.current?.click()}
                            className="btn-primary w-full"
                        >
                            {busy ? "restoring…" : "Restore from backup file"}
                        </button>

                        {error && (
                            <p className="border-error-line bg-error-soft t-base text-error rounded border p-4">
                                {error}
                            </p>
                        )}

                        <button
                            type="button"
                            className="t-base text-muted hover:text-foreground w-full"
                            onClick={() => session.logout()}
                        >
                            use a different account
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="card space-y-4">
                        {locked ? (
                            <div className="space-y-3">
                                <div className="flex items-center gap-3">
                                    <Avatar
                                        name={session.account!.username}
                                        size="md"
                                    />
                                    <div className="min-w-0">
                                        <p className="t-h4 truncate font-medium">
                                            {session.account!.username}
                                        </p>
                                        <p className="t-base text-muted">
                                            Vault Locked
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <>
                                <label className="block space-y-1">
                                    <span className="t-base text-muted">
                                        Username
                                        {mode == "register" && (
                                            <span className="text-error">
                                                {" "}
                                                *
                                            </span>
                                        )}
                                    </span>
                                    <input
                                        className="field"
                                        autoComplete="username"
                                        value={username}
                                        onChange={(e) =>
                                            setUsername(e.target.value)
                                        }
                                        placeholder="Anon"
                                    />
                                </label>
                            </>
                        )}

                        <label className="block space-y-1">
                            <div className="m-0 flex w-full flex-row justify-between">
                                <span className="t-base text-muted">
                                    Password
                                    {mode == "register" && (
                                        <span className="text-error"> *</span>
                                    )}
                                </span>
                                {mode === "login" && (
                                    <Link
                                        to="/recover"
                                        className="t-base text-primary hover:text-primary-strong block w-full text-end"
                                    >
                                        Forgot your password?
                                    </Link>
                                )}
                            </div>
                            <input
                                className="field"
                                type="password"
                                autoComplete={
                                    mode === "register"
                                        ? "new-password"
                                        : "current-password"
                                }
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your password"
                            />
                        </label>

                        {mode === "register" && !locked && (
                            <>
                                <label className="block space-y-1">
                                    <span className="t-base text-muted">
                                        Confirm Password
                                        {mode == "register" && (
                                            <span className="text-error">
                                                {" "}
                                                *
                                            </span>
                                        )}
                                    </span>
                                    <input
                                        className="field"
                                        type="password"
                                        autoComplete="new-password"
                                        value={confirm}
                                        onChange={(e) =>
                                            setConfirm(e.target.value)
                                        }
                                    />
                                </label>

                                <label className="block space-y-1">
                                    <span className="t-base text-muted flex flex-row items-center gap-1">
                                        Email{" "}
                                        <div className="flex w-max">
                                            <InfoTip
                                                tip="It remains encrypted and hidden. Only used for password recovery. You can't send files without a verified email. Providing it is optional."
                                                details="An email lets you reset a forgotten password. It is encrypted, never shown to
                      anyone and never displayed in full, not even to you. You can add or remove it
                      later in Settings. Skipping it costs you the ability to send files in chats."
                                                title="How we use your Email"
                                            />
                                        </div>
                                    </span>
                                    <input
                                        className="field"
                                        type="email"
                                        autoComplete="email"
                                        value={email}
                                        onChange={(e) =>
                                            setEmail(e.target.value)
                                        }
                                        placeholder="Optional Email"
                                    />
                                </label>
                            </>
                        )}

                        <label className="t-base text-muted flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={remember}
                                onChange={(e) => setRemember(e.target.checked)}
                                className="accent-primary"
                            />
                            Keep unlocked in this tab
                        </label>

                        {error && (
                            <p className="border-error-line bg-error-soft t-base text-error rounded border p-4">
                                {error}
                            </p>
                        )}

                        <button className="btn-primary w-full" disabled={busy}>
                            {busy
                                ? "working…"
                                : locked
                                  ? "Unlock"
                                  : mode === "login"
                                    ? "Unlock"
                                    : "Register"}
                        </button>

                        {locked ? (
                            <button
                                type="button"
                                className="t-base text-muted hover:text-foreground w-full"
                                onClick={() => session.logout()}
                            >
                                Use a different account
                            </button>
                        ) : (
                            <div className="flex w-full flex-col justify-between md:flex-row">
                                <button
                                    type="button"
                                    className="t-base text-muted hover:text-foreground w-full"
                                    onClick={() => {
                                        setMode(
                                            mode === "login"
                                                ? "register"
                                                : "login",
                                        );
                                        setError("");
                                    }}
                                >
                                    {mode === "login"
                                        ? "Create identity"
                                        : "Have an identity? Log in"}
                                </button>
                            </div>
                        )}
                    </form>
                )}

                {!locked &&
                    !needsImport &&
                    session.accounts.length > 0 &&
                    !recoveryPhrase && (
                        <div className="space-y-2">
                            <p className="t-base text-muted tracking-wider uppercase">
                                identities on this device
                            </p>
                            {session.accounts.map((account) => (
                                <button
                                    key={account.userId}
                                    onClick={() => {
                                        session.selectAccount(account.userId);
                                        setUsername(account.username);
                                        setMode("login");
                                    }}
                                    className="border-border hover:border-primary flex w-full items-center gap-3 rounded border p-4 text-left transition-colors"
                                >
                                    <Avatar name={account.username} size="sm" />
                                    <span className="t-h4 flex-1 truncate">
                                        {account.username}
                                    </span>
                                    <span className="tag bg-surface-raised text-muted">
                                        locked
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}

                {!locked && !needsImport && !recoveryPhrase && (
                    <div className="space-y-2 text-center">
                        <input
                            ref={restoreInput}
                            type="file"
                            accept="application/json,.json"
                            className="hidden"
                            onChange={handleRestoreFile}
                        />
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => restoreInput.current?.click()}
                            className="t-base text-muted hover:text-primary w-full"
                        >
                            Restore from a backup file
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
