import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
    User,
    Palette,
    Volume2,
    ShieldCheck,
    CreditCard,
    KeyRound,
    AlertTriangle,
    LogOut,
    ArrowLeft,
} from "lucide-react";
import { useSession } from "@/lib/session";
import ThemeToggle from "@/components/theme/ThemeToggle";
import AccountBar from "@/components/layout/AccountBar";
import { LogoutConfirmModal } from "@/components/layout/LogoutConfirmModal";
import { SubNav } from "@/pages/settings/components/SubNav";
import { SettingsStatus } from "@/pages/settings/types";
import ProfileTab from "@/pages/settings/tabs/ProfileTab";
import AppearanceTab from "@/pages/settings/tabs/AppearanceTab";
import SoundsTab from "@/pages/settings/tabs/SoundsTab";
import AccountTab from "@/pages/settings/tabs/AccountTab";
import BillingTab from "@/pages/settings/tabs/BillingTab";
import KeysTab from "@/pages/settings/tabs/KeysTab";
import DangerTab from "@/pages/settings/tabs/DangerTab";

type TabId =
    | "profile"
    | "appearance"
    | "sounds"
    | "account"
    | "billing"
    | "keys"
    | "danger";

const TABS: { id: TabId; label: string; icon: typeof User }[] = [
    { id: "profile", label: "Profile", icon: User },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "sounds", label: "Sounds", icon: Volume2 },
    { id: "account", label: "Account", icon: ShieldCheck },
    { id: "billing", label: "Subscription", icon: CreditCard },
    { id: "keys", label: "Backup & devices", icon: KeyRound },
    { id: "danger", label: "Danger zone", icon: AlertTriangle },
];

const STATUS_STYLES = {
    ok: "border-primary-line bg-primary-soft text-primary",
    error: "border-error-line bg-error-soft text-error",
    info: "border-info-line bg-info-soft text-info",
} as const;

export default function Settings() {
    const session = useSession();
    const { vault, account } = session;

    const [status, setStatus] = useState<SettingsStatus>(null);
    const [tab, setTab] = useState<TabId | null>(null);
    const [subSections, setSubSections] = useState<
        { id: string; title: string }[]
    >([]);
    const [showLogout, setShowLogout] = useState(false);

    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = contentRef.current;
        if (!tab || !el) {
            setSubSections([]);
            return;
        }
        const collect = () => {
            const nodes = el.querySelectorAll<HTMLElement>(
                "[data-settings-section]",
            );
            const next = Array.from(nodes).map((n) => ({
                id: n.id,
                title: n.dataset.title ?? "",
            }));
            setSubSections((prev) =>
                prev.length === next.length &&
                prev.every((p, i) => p.id === next[i].id)
                    ? prev
                    : next,
            );
        };
        collect();
        const observer = new MutationObserver(collect);
        observer.observe(el, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [tab]);

    function jumpToSection(id: string) {
        document
            .getElementById(id)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if (!vault || !account) {
        return (
            <div className="grid h-full place-items-center p-4">
                <div className="card space-y-3 text-center">
                    <p className="t-h4">
                        Unlock your vault to change settings.
                    </p>
                    <Link to="/login" className="btn-ghost">
                        Unlock
                    </Link>
                </div>
            </div>
        );
    }

    const activeTab = TABS.find((t) => t.id === tab);

    return (
        <div className="flex h-full">
            {/* category list. the left column, mirroring the channel list. On mobile
          it is the whole screen until a category is chosen. */}
            <aside
                className={`border-border bg-surface w-full flex-col border-r lg:flex lg:w-85 lg:shrink-0 ${
                    tab ? "hidden lg:flex" : "flex"
                }`}
            >
                <div className="border-border flex h-14.25 shrink-0 items-center gap-3 border-b px-3">
                    <Link
                        to="/channels"
                        className="text-muted hover:text-primary transition-colors"
                        aria-label="Back to channels"
                    >
                        <ArrowLeft size={18} />
                    </Link>
                    <h1 className="t-base text-muted flex-1 font-semibold tracking-wider">
                        Settings
                    </h1>
                    <ThemeToggle />
                </div>
                <nav className="flex-1 space-y-1 overflow-y-auto p-2">
                    {TABS.map((t) => (
                        <div key={t.id}>
                            <button
                                onClick={() => setTab(t.id)}
                                className={`t-h4 flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                                    tab === t.id
                                        ? "bg-primary-soft text-primary"
                                        : t.id === "danger"
                                          ? "text-error hover:bg-error-soft"
                                          : "text-foreground hover:bg-surface-raised"
                                }`}
                            >
                                <t.icon size={16} className="flex-none" />
                                {t.label}
                            </button>
                            {/* Quick-jump to the sections within the open tab. */}
                            {tab === t.id && subSections.length > 1 && (
                                <SubNav
                                    items={subSections}
                                    onJump={jumpToSection}
                                />
                            )}
                        </div>
                    ))}
                </nav>
                {/* A wide, always-visible log-out at the foot of the category list, on
            top of the account-bar menu. Confirmed before it fires. */}
                <div className="shrink-0 p-2">
                    <button
                        onClick={() => setShowLogout(true)}
                        className="border-border t-base text-muted hover:border-error-line hover:bg-error-soft hover:text-error flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2 font-medium transition-colors"
                    >
                        <LogOut size={15} />
                        Log out
                    </button>
                </div>
                <AccountBar />
            </aside>

            {/* active category. the right pane, mirroring the chat panel. */}
            <main
                className={`min-w-0 flex-1 flex-col ${tab ? "flex" : "hidden lg:flex"}`}
            >
                <div className="border-border flex h-14.25 shrink-0 items-center gap-3 border-b px-4">
                    <button
                        onClick={() => setTab(null)}
                        className="text-muted hover:bg-surface-raised hover:text-primary -ml-1 rounded-lg p-1.5 transition-colors lg:hidden"
                        aria-label="Back to settings"
                    >
                        <ArrowLeft size={18} />
                    </button>
                    <h2 className="t-h4 font-semibold tracking-wider uppercase">
                        {activeTab?.label ?? "settings"}
                    </h2>
                </div>

                {tab === null ? (
                    <div className="text-muted grid h-full place-items-center p-6 text-center">
                        <p className="t-h4">Select a settings category.</p>
                    </div>
                ) : (
                    <div
                        ref={contentRef}
                        className="mx-auto w-full max-w-2xl flex-1 space-y-6 overflow-y-auto p-4 lg:p-6"
                    >
                        {status && (
                            <p
                                className={`t-base animate-fade-in rounded-lg border p-3 ${STATUS_STYLES[status.kind]}`}
                            >
                                {status.text}
                            </p>
                        )}

                        {tab === "profile" && (
                            <ProfileTab
                                vault={vault}
                                account={account}
                                setStatus={setStatus}
                            />
                        )}
                        {tab === "appearance" && (
                            <AppearanceTab
                                vault={vault}
                                setStatus={setStatus}
                            />
                        )}
                        {tab === "sounds" && (
                            <SoundsTab vault={vault} setStatus={setStatus} />
                        )}
                        {tab === "account" && (
                            <AccountTab
                                vault={vault}
                                account={account}
                                setStatus={setStatus}
                            />
                        )}
                        {tab === "billing" && (
                            <BillingTab setStatus={setStatus} />
                        )}
                        {tab === "keys" && (
                            <KeysTab account={account} setStatus={setStatus} />
                        )}
                        {tab === "danger" && <DangerTab account={account} />}
                    </div>
                )}
            </main>

            {showLogout && (
                <LogoutConfirmModal
                    onConfirm={() => {
                        setShowLogout(false);
                        session.logout();
                    }}
                    onClose={() => setShowLogout(false)}
                />
            )}
        </div>
    );
}
