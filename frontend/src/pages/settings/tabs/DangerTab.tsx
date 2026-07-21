import { useNavigate } from "react-router-dom";
import { useSession } from "@/lib/session";
import { AccountDescriptor } from "@/lib/vault";
import {
    SettingsSection,
    SettingBlock,
} from "@/components/settings/SettingsUI";

export default function DangerTab({
    account,
}: {
    account: AccountDescriptor;
}) {
    const session = useSession();
    const navigate = useNavigate();

    function handleForget() {
        const ok = confirm(
            `Permanently delete "${account.username}" from this device?\n\n` +
                "Private keys, channel keys, and all decrypted messages are erased. " +
                "Without an exported key file this cannot be undone — the server does not have your keys.",
        );
        if (!ok) return;
        session.removeAccount(account.userId);
        navigate("/");
    }

    return (
        <SettingsSection
            title="Danger zone"
            danger
            info="Logging out keeps your keys; erasing deletes them."
            infoDetails="Log out keeps your private keys, channel keys, and decrypted messages on this device so you can unlock again. Erase removes them permanently — without an exported key file it cannot be undone, since the server does not hold your keys."
        >
            <SettingBlock>
                <button
                    onClick={session.logout}
                    className="btn-ghost w-full"
                >
                    Log out (keeps keys on this device)
                </button>
                <button onClick={handleForget} className="btn-danger w-full">
                    Erase this identity from this device
                </button>
            </SettingBlock>
        </SettingsSection>
    );
}
