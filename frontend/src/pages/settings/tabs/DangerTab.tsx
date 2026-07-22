import { useNavigate } from "react-router-dom";
import { useSession } from "@/lib/session";
import { AccountDescriptor } from "@/lib/vault";
import { SettingsSection, SettingRow } from "@/components/settings/SettingsUI";

export default function DangerTab({
    account,
}: {
    account: AccountDescriptor;
}) {
    const session = useSession();
    const navigate = useNavigate();

    async function handleForget() {
        const ok = confirm(
            `Permanently delete "${account.username}" from this device?\n\n` +
                "Private keys, channel keys, and all decrypted messages are erased. " +
                "Without an exported backup file this cannot be undone — the server does not have your keys.",
        );
        if (!ok) return;
        await session.removeAccount(account.userId);
        navigate("/login");
    }

    return (
        <SettingsSection
            title="Danger zone"
            danger
            info="Logging out keeps your keys; erasing deletes them."
            infoDetails="Log out keeps your private keys, channel keys, and decrypted messages on this device so you can unlock again. Erase removes them permanently — without an exported key file it cannot be undone, since the server does not hold your keys."
        >
            <SettingRow
                title="Log out"
                description="Keys stay on this device."
                control={
                    <button onClick={session.logout} className="btn-ghost">
                        Log out
                    </button>
                }
            />
            <SettingRow
                title="Erase identity"
                description="Deletes keys and messages from this device."
                info="Cannot be undone without a backup file."
                infoDetails="Erase removes your private keys, channel keys, and decrypted messages from this device permanently. The server never holds your keys, so without an exported backup there is no way back."
                control={
                    <button onClick={handleForget} className="btn-danger">
                        Erase
                    </button>
                }
            />
        </SettingsSection>
    );
}
