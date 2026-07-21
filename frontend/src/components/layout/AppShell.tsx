import { useState } from "react";
import { useParams } from "react-router-dom";
import { MessagesSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Channels from "@/pages/channels/Channels";
import Chat from "@/pages/chat/Chat";

const HIDE_KEY = "dc:sidebarHidden";

/**
 * Two-pane responsive shell
 */
export default function AppShell() {
    const { channelId } = useParams<{ channelId: string }>();

    // Desktop-only preference: hide the sidebar for a roomier chat.
    const [sidebarHidden, setSidebarHidden] = useState(
        () => localStorage.getItem(HIDE_KEY) === "1",
    );

    function toggleSidebar(hidden: boolean) {
        setSidebarHidden(hidden);
        localStorage.setItem(HIDE_KEY, hidden ? "1" : "0");
    }

    return (
        <div className="h-full">
            <div className="flex h-full">
                <aside
                    className={`border-border w-full flex-col border-r lg:w-85 lg:shrink-0 ${
                        channelId ? "hidden lg:flex" : "flex"
                    } ${sidebarHidden ? "lg:hidden" : "lg:flex"}`}
                >
                    <div className="border-border hidden h-14.25 shrink-0 items-center justify-between border-b px-3 lg:flex">
                        <span className="t-base text-muted font-semibold tracking-wider">
                            CryptChat
                        </span>
                        <button
                            onClick={() => toggleSidebar(true)}
                            className="text-muted hover:bg-surface-raised hover:text-primary rounded p-1.5 transition-colors"
                            title="Hide channel panel"
                            aria-label="Hide channel panel"
                        >
                            <PanelLeftClose size={18} />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1">
                        <Channels />
                    </div>
                </aside>

                {sidebarHidden && (
                    <div className="border-border hidden w-10 shrink-0 flex-col items-center border-r py-2 lg:flex">
                        <button
                            onClick={() => toggleSidebar(false)}
                            className="text-muted hover:bg-surface-raised hover:text-primary rounded p-1.5 transition-colors"
                            title="Show channel panel"
                            aria-label="Show channel panel"
                        >
                            <PanelLeftOpen size={18} />
                        </button>
                    </div>
                )}

                <main
                    className={`min-w-0 flex-1 flex-col ${channelId ? "flex" : "hidden lg:flex"}`}
                >
                    {channelId ? (
                        <div
                            className={`flex h-full min-h-0 w-full flex-col ${
                                sidebarHidden ? "mx-auto max-w-3xl" : ""
                            }`}
                        >
                            <Chat />
                        </div>
                    ) : (
                        <div className="grid h-full place-items-center p-6 text-center">
                            <div className="text-muted space-y-3">
                                <MessagesSquare
                                    size={48}
                                    className="mx-auto"
                                    aria-hidden
                                />
                                <p className="t-h4">No channel selected</p>
                                <p className="t-base">
                                    Pick a channel on the left to start reading
                                </p>
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
