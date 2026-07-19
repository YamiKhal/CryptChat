import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { MessagesSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Channels from '../pages/Channels';
import Chat from '../pages/Chat';

const HIDE_KEY = 'dc:sidebarHidden';

/**
 * Two-pane responsive shell (WhatsApp Web style).
 *
 * One element backs both /channels and /chat/:channelId, so navigating between
 * them never remounts the panes -- it just changes which channel the right side
 * reads from useParams. Desktop (lg+) shows the channel sidebar and the chat
 * side by side; below lg it collapses to a single view: the list when no channel
 * is selected, the chat when one is, with the chat header's back arrow returning.
 *
 * The whole shell is width-capped and centered, so on a wide monitor the content
 * does not sprawl edge to edge. The sidebar can be hidden on desktop to give the
 * chat more room -- still bounded, not truly full-bleed.
 */
export default function AppShell() {
  const { channelId } = useParams<{ channelId: string }>();

  // Desktop-only preference: hide the sidebar for a roomier chat. Persisted so a
  // reload keeps the chosen layout. Ignored on mobile, where the single-view
  // logic below owns which pane is on screen.
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(HIDE_KEY) === '1'
  );

  function toggleSidebar(hidden: boolean) {
    setSidebarHidden(hidden);
    localStorage.setItem(HIDE_KEY, hidden ? '1' : '0');
  }

  return (
    <div className="h-full">
      <div className="flex h-full">
        {/* Channel sidebar. Mobile: only when no channel is open. Desktop: always,
            unless the user collapsed it. */}
        <aside
          className={`w-full flex-col border-r border-border lg:w-85 lg:shrink-0 ${
            channelId ? 'hidden lg:flex' : 'flex'
          } ${sidebarHidden ? 'lg:hidden' : 'lg:flex'}`}
        >
          <div className="hidden h-14.25 shrink-0 items-center justify-between border-b border-border px-3 lg:flex">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              dark-chat
            </span>
            <button
              onClick={() => toggleSidebar(true)}
              className="rounded p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-primary"
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

        {/* Collapsed-sidebar rail: a slim reveal button so the sidebar can come
            back. Desktop only, and only while hidden. */}
        {sidebarHidden && (
          <div className="hidden w-10 shrink-0 flex-col items-center border-r border-border py-2 lg:flex">
            <button
              onClick={() => toggleSidebar(false)}
              className="rounded p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-primary"
              title="Show channel panel"
              aria-label="Show channel panel"
            >
              <PanelLeftOpen size={18} />
            </button>
          </div>
        )}

        {/* Chat panel. Mobile: only when a channel is open. Desktop: always, with
            an empty state when nothing is selected. Constrained to a readable
            column when the sidebar is hidden, so it never spans the full width. */}
        <main
          className={`min-w-0 flex-1 flex-col ${channelId ? 'flex' : 'hidden lg:flex'}`}
        >
          {channelId ? (
            <div
              className={`flex h-full min-h-0 w-full flex-col ${
                sidebarHidden ? 'mx-auto max-w-3xl' : ''
              }`}
            >
              <Chat />
            </div>
          ) : (
            <div className="grid h-full place-items-center p-6 text-center">
              <div className="space-y-3 text-muted">
                <MessagesSquare size={48} className="mx-auto" aria-hidden />
                <p className="text-sm">No channel selected</p>
                <p className="text-xs">Pick a channel on the left to start reading.</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
