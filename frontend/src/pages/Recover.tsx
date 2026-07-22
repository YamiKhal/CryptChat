import { useState, FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { generateSalt, RECOVERY_CODE_WORDS } from "@/lib/crypto";
import { saveAccount, getAccount } from "@/lib/vault";

/**
 * Password recovery, in the only shape that is honest.
 *
 * Two factors, and both are required, because each covers what the other cannot:
 *
 *   - the email proves you control the mailbox, which lets the server accept a
 *     new password;
 *   - the recovery code decrypts your keys, which the server has never held and
 *     cannot help with.
 *
 * A reset without the code produces a working login into an account with no
 * channels and no history. That is not a recovery, and presenting it as one is
 * how a user concludes the app ate their data. So the code step is part of this
 * flow rather than an optional extra afterwards.
 */

type Stage = "request" | "sent" | "reset" | "code" | "done";

export default function Recover() {
    const session = useSession();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const token = params.get("token");

    const [stage, setStage] = useState<Stage>(token ? "reset" : "request");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [phrase, setPhrase] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    async function handleRequest(e: FormEvent) {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
            await api.requestReset(email.trim());
            setStage("sent");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleReset(e: FormEvent) {
        e.preventDefault();
        setError("");
        if (password !== confirm) {
            setError("passwords do not match");
            return;
        }
        setBusy(true);
        try {
            // A fresh salt: the old vault is sealed under the old password and is not
            // coming back, so carrying its salt forward would imply a continuity that
            // does not exist.
            const vaultSalt = await generateSalt();
            const res = await api.resetPassword(token!, password, vaultSalt);

            // Park enough for the code step to run. The vault itself does not exist
            // yet -- it gets built from the recovery blob in the next stage.
            const existing = getAccount(res.userId);
            saveAccount({
                userId: res.userId,
                // `||`, not `??`: an absent local record leaves this blank, and a blank
                // string is not nullish -- so `??` would save an empty username instead
                // of falling through to the label.
                username: existing?.username || "recovered",
                publicKey: res.pubkey,
                signPublicKey: res.signPubkey,
                vaultSalt: res.vaultSalt,
                lastUsedAt: new Date().toISOString(),
            });
            sessionStorage.setItem(`darkchat:tok:${res.userId}`, res.token);
            localStorage.setItem("darkchat:active", res.userId);

            session.selectAccount(res.userId);
            setStage("code");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function handleCode(e: FormEvent) {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
            await session.recoverWithCode(phrase, password);
            setStage("done");
            navigate("/channels");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    const errorBox = error && (
        <p className="border-error-line bg-error-soft t-base text-error rounded border p-4">
            {error}
        </p>
    );

    return (
        <div className="grid min-h-screen place-items-center p-4">
            <div className="w-full max-w-sm space-y-4">
                <header className="space-y-1 text-center">
                    <h1 className="t-h1 text-primary font-bold tracking-tight">
                        CryptChat
                    </h1>
                    <p className="t-base text-muted">Account recovery</p>
                </header>

                {stage === "request" && (
                    <form onSubmit={handleRequest} className="card space-y-4">
                        <label className="block space-y-1">
                            <span className="t-base text-muted">
                                Vault Email
                            </span>
                            <input
                                className="field"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </label>

                        {errorBox}

                        <button className="btn-primary w-full" disabled={busy}>
                            {busy ? "working…" : "Send reset link"}
                        </button>

                        <Link
                            to="/login"
                            className="t-base text-muted hover:text-foreground block w-full text-center"
                        >
                            Back
                        </Link>
                    </form>
                )}

                {stage === "sent" && (
                    <div className="card space-y-4">
                        <p className="t-base text-muted">
                            If that address is attached to a verified account, a
                            reset link is on its way. It may take up to 5
                            minutes. It expires in 30 minutes.
                        </p>
                        <Link
                            to="/login"
                            className="btn-ghost t-base w-full text-center"
                        >
                            Back
                        </Link>
                    </div>
                )}

                {stage === "reset" && (
                    <form onSubmit={handleReset} className="card space-y-4">
                        <label className="block space-y-1">
                            <span className="t-base text-muted">
                                New password
                            </span>
                            <input
                                className="field"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••••••"
                            />
                        </label>

                        <label className="block space-y-1">
                            <span className="t-base text-muted">
                                Confirm password
                            </span>
                            <input
                                className="field"
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                            />
                        </label>

                        <p className="t-base text-muted">
                            Minimum 12 characters. Next you will enter your
                            recovery code.
                        </p>

                        {errorBox}

                        <button className="btn-primary w-full" disabled={busy}>
                            {busy ? "working…" : "Set password"}
                        </button>
                    </form>
                )}

                {stage === "code" && (
                    <form onSubmit={handleCode} className="card space-y-4">
                        <p className="t-base text-muted rounded">
                            Your password is reset. Enter the{" "}
                            {RECOVERY_CODE_WORDS} words you saved when you
                            registered to decrypt your channels.
                        </p>

                        <label className="block space-y-1">
                            <textarea
                                className="field t-base h-28 resize-none font-mono"
                                value={phrase}
                                onChange={(e) => setPhrase(e.target.value)}
                                placeholder={`${RECOVERY_CODE_WORDS} words, in order`}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </label>

                        <p className="t-small text-warn">
                            Continuing without it leaves you logged in with no
                            channels and no history. Nothing can restore them
                            later.
                        </p>

                        {errorBox}

                        <button
                            className="btn-primary w-full"
                            disabled={busy || !phrase.trim()}
                        >
                            {busy ? "decrypting…" : "Restore my channels"}
                        </button>

                        <button
                            type="button"
                            className="t-base text-muted hover:text-foreground w-full"
                            onClick={() => navigate("/channels")}
                        >
                            Continue Without Decryption
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
