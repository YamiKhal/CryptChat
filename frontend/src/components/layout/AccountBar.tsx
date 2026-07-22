import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, User, LogOut } from 'lucide-react';
import { useSession } from '@/lib/session';
import { useRelayContext } from '@/lib/relayContext';
import { UserProfile } from '@/lib/vault';
import { ContextMenu, useContextMenu } from '@/components/ui/ContextMenu';
import { UserProfileModal } from '@/components/user/UserProfileModal';
import { LogoutConfirmModal } from '@/components/layout/LogoutConfirmModal';
import Avatar from '@/components/ui/Avatar';

/**
 * The Discord-style account bar pinned to the bottom of a side column.
 *
 * Shared between the channel list and the settings sidebar so the two footers
 * are identical. The left half (identity) is the profile handle: click to view
 * your own card, right-click / long-press for the account menu. The right half
 * is controls -- the settings cog, which lights up while the settings page is
 * open and doubles as the way back to the channels.
 */
export default function AccountBar() {
  const { vault, account, logout } = useSession();
  const { connected } = useRelayContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const menu = useContextMenu();
  const [showProfile, setShowProfile] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  if (!vault || !account) return null;

  const profile = vault.profile;
  const onSettings = pathname.startsWith('/settings');

  // Assembled from your own Profile the same way Chat builds a peer's card, so
  // the one viewer renders both.
  const self: UserProfile = {
    userId: account.userId,
    displayName: profile.displayName,
    avatar: profile.avatar,
    bio: profile.bio,
    background: profile.background,
  };

  return (
    <>
      <div className="flex min-h-16 shrink-0 items-center gap-2 border-t border-border bg-surface px-3">
        {/* Left: identity. Click opens your card; right-click / long-press opens
            the account menu. Only this half is the profile handle. */}
        <button
          type="button"
          {...menu.handlers}
          className="hover:bg-surface-raised -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg
                     px-1.5 py-1 text-left transition-colors"
          title="You — right-click for options"
        >
          <Avatar asset={profile.avatar} name={profile.displayName} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate t-h4 font-medium">{profile.displayName}</p>
            <p className="flex items-center gap-1.5 t-small text-muted">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  connected ? 'bg-primary' : 'bg-warn'
                }`}
              />
              {connected ? 'relay connected' : 'reconnecting…'}
            </p>
          </div>
        </button>

        {/* Right: controls. The cog stays a cog on the settings page but lights
            up to mark it active, and a second click returns to the channels. */}
        <button
          onClick={() => navigate(onSettings ? '/channels' : '/settings')}
          className={`flex-none rounded-lg p-2 transition-colors ${
            onSettings
              ? 'bg-primary-soft text-primary'
              : 'text-muted hover:bg-surface-raised hover:text-primary'
          }`}
          title={onSettings ? 'Close settings' : 'Settings'}
          aria-label="Settings"
          aria-pressed={onSettings}
        >
          <SettingsIcon size={18} />
        </button>
      </div>

      {menu.isOpen && menu.position && (
        <ContextMenu
          position={menu.position}
          onClose={menu.close}
          items={[
            {
              label: 'View profile',
              icon: <User size={15} />,
              onSelect: () => setShowProfile(true),
            },
            {
              label: 'Settings',
              icon: <SettingsIcon size={15} />,
              onSelect: () => navigate('/settings'),
            },
            {
              label: 'Log out',
              icon: <LogOut size={15} />,
              danger: true,
              onSelect: () => setConfirmLogout(true),
            },
          ]}
        />
      )}

      {showProfile && <UserProfileModal profile={self} onClose={() => setShowProfile(false)} />}

      {confirmLogout && (
        <LogoutConfirmModal
          onConfirm={() => {
            setConfirmLogout(false);
            logout();
          }}
          onClose={() => setConfirmLogout(false)}
        />
      )}
    </>
  );
}
