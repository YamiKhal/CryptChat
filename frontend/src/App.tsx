import { Routes, Route, Navigate } from "react-router-dom";
import { ReactNode } from "react";
import Auth from "@/pages/Auth";
import AppShell from "@/components/layout/AppShell";
import Settings from "@/pages/settings/Settings";
import Recover from "@/pages/Recover";
import VerifyEmail from "@/pages/VerifyEmail";
import Subscribe from "@/pages/Subscribe";
import { useSession } from "@/lib/session";
import { RelayProvider } from "@/lib/relayContext";
import { CallProvider } from "@/lib/callContext";
import CallOverlay from "@/components/call/CallOverlay";

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
    if (status !== "unlocked") return <Navigate to="/" replace />;
    return <>{children}</>;
}

export default function App() {
    const { status, recoveryPending } = useSession();

    if (status === "restoring") return <Restoring />;

    const routes = (
        <Routes>
            <Route
                path="/"
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
                    {routes}
                    <CallOverlay />
                </CallProvider>
            </RelayProvider>
        );
    }

    return routes;
}
