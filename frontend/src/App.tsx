import { Routes, Route, Navigate } from "react-router-dom";
import { ReactNode } from "react";
import Auth from "@/pages/Auth";
import Landing from "@/pages/marketing/Landing";
import Showcase from "@/pages/marketing/Showcase";
import KnowledgeBase from "@/pages/marketing/KnowledgeBase";
import AppShell from "@/components/layout/AppShell";
import Settings from "@/pages/settings/Settings";
import Recover from "@/pages/Recover";
import VerifyEmail from "@/pages/VerifyEmail";
import Subscribe from "@/pages/Subscribe";
import { useSession, useUnlockedSession } from "@/lib/session";
import { RelayProvider } from "@/lib/relayContext";
import { CallProvider } from "@/lib/callContext";
import CallOverlay from "@/components/call/CallOverlay";
import { AutoBackupProvider } from "@/lib/backup/AutoBackupContext";
import { useBillingBadge } from "@/pages/settings/useBillingBadge";

function Restoring() {
    return (
        <div className="grid min-h-screen place-items-center">
            <p className="t-base text-muted animate-pulse">unlocking…</p>
        </div>
    );
}

function RequireUnlocked({ children }: { children: ReactNode }) {
    const { status } = useSession();
    if (status === "restoring") return <Restoring />;
    if (status !== "unlocked") return <Navigate to="/login" replace />;
    return <>{children}</>;
}

/**
 * Runs the premium silent-backup controller for the whole unlocked app. Premium
 * status gates writing, but the provider mounts regardless so the Backup tab can
 * explain what auto-backup is and offer the upgrade.
 */
function UnlockedProviders({ children }: { children: ReactNode }) {
    const { account, token } = useUnlockedSession();
    const { badge } = useBillingBadge(token);
    return (
        <AutoBackupProvider
            userId={account.userId}
            username={account.username}
            premium={!!badge}
        >
            {children}
        </AutoBackupProvider>
    );
}

export default function App() {
    const { status, recoveryPending } = useSession();

    if (status === "restoring") return <Restoring />;

    const routes = (
        <Routes>
            {/* Public marketing layer — reachable logged in or out. */}
            <Route path="/" element={<Landing />} />
            <Route path="/showcase" element={<Showcase />} />
            <Route path="/kb" element={<KnowledgeBase />} />

            {/* Login/register. An already-unlocked session skips straight into
                the app, so the nav's Launch App button doubles as "Open App". */}
            <Route
                path="/login"
                element={
                    status === "unlocked" && !recoveryPending ? (
                        <Navigate to="/channels" replace />
                    ) : (
                        <Auth />
                    )
                }
            />

            <Route path="/reset-password" element={<Recover />} />
            <Route path="/recover" element={<Recover />} />
            <Route path="/verify-email" element={<VerifyEmail />} />

            <Route path="/subscribe" element={<Subscribe />} />
            <Route path="/subscribe/done" element={<Subscribe />} />

            <Route
                path="/channels"
                element={
                    <RequireUnlocked>
                        <AppShell />
                    </RequireUnlocked>
                }
            />
            <Route
                path="/chat/:channelId"
                element={
                    <RequireUnlocked>
                        <AppShell />
                    </RequireUnlocked>
                }
            />
            <Route
                path="/settings"
                element={
                    <RequireUnlocked>
                        <Settings />
                    </RequireUnlocked>
                }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );

    if (status === "unlocked") {
        return (
            <RelayProvider>
                <CallProvider>
                    <UnlockedProviders>
                        {routes}
                        <CallOverlay />
                    </UnlockedProviders>
                </CallProvider>
            </RelayProvider>
        );
    }

    return routes;
}
