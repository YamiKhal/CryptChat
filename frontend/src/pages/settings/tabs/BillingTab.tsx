import { useState } from "react";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import SubscriptionSection from "@/components/settings/SubscriptionSection";
import { useBillingBadge } from "@/pages/settings/useBillingBadge";
import { SetStatus } from "@/pages/settings/types";

export default function BillingTab({ setStatus }: { setStatus: SetStatus }) {
    const session = useSession();
    const { badge, portalUrl, setBadge } = useBillingBadge(session.token);

    const [redeemCode, setRedeemCode] = useState("");
    const [busy, setBusy] = useState(false);

    async function handleRedeem() {
        setStatus(null);
        setBusy(true);
        try {
            const res = await api.redeem(session.token!, redeemCode.trim());
            setBadge(res.badge);
            setRedeemCode("");

            const months = res.redeemed.months ?? 0;
            const period = months === 1 ? "1 month" : `${months} months`;

            // "Redeemed!" with an unchanged expiry date reads as a bug. Say where the
            // months went.
            setStatus({
                kind: "ok",
                text: res.redeemed.parked
                    ? `${period} banked. They start when your current subscription stops renewing — you will not pay for gifted time.`
                    : "Badge activated.",
            });
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-8">
            <SubscriptionSection
                badge={badge}
                portalUrl={portalUrl}
                redeemCode={redeemCode}
                onCodeChange={setRedeemCode}
                onRedeem={handleRedeem}
                busy={busy}
            />
        </div>
    );
}
