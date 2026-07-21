import { useEffect, useState } from "react";
import { api, Badge as BadgeState } from "@/lib/api";

/**
 * Fetches the account's supporter badge and Stripe portal URL. Shared by the
 * Appearance tab (supporter crown) and the Subscription tab.
 */
export function useBillingBadge(token: string | null) {
    const [badge, setBadge] = useState<BadgeState | null>(null);
    const [portalUrl, setPortalUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        api.billingStatus(token)
            .then((res) => {
                if (cancelled) return;
                setBadge(res.badge);
                setPortalUrl(res.portalUrl);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [token]);

    return { badge, portalUrl, setBadge };
}
