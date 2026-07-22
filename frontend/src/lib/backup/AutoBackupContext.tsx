import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { onVaultChange } from '@/lib/vault/events';
import { supportsFileSystemAccess } from '@/lib/backup/support';
import {
  AutoBackupError,
  configureBackup,
  disableBackup,
  reconnectBackup,
  writeBackup,
  isBackupConfigured,
} from '@/lib/backup/autoBackup';

/**
 * App-wide controller for premium silent auto-backup.
 *
 * Mounted once in the unlocked tree so it runs on every route: it listens for
 * vault changes and, debounced, rewrites the user's chosen disk file. The
 * Settings > Backup tab reads the same context to render the toggle and status,
 * so the background writer and the UI controls never drift out of sync.
 *
 * The debounce matters: a burst of edits (paste a long message, react, edit)
 * would otherwise reopen and rewrite the whole file per keystroke-ish change.
 * One write a few seconds after activity settles is enough -- the source of
 * truth is IndexedDB; the file is a durable mirror that is allowed to lag briefly.
 */

export type BackupStatus = 'off' | 'idle' | 'saving' | 'saved' | 'reconnect' | 'error';

const DEBOUNCE_MS = 4000;

interface AutoBackupApi {
  /** Browser can write to a picked file at all (Chromium). */
  supported: boolean;
  /** Account is entitled to auto-backup. */
  premium: boolean;
  /** A backup file has been chosen for this account. */
  configured: boolean;
  status: BackupStatus;
  lastSavedAt: number | null;
  error: string | null;
  /** Pick the backup file (user gesture). */
  configure(): Promise<void>;
  /** Stop auto-backup and forget the file. */
  disable(): Promise<void>;
  /** Re-grant write permission after the browser dropped it (user gesture). */
  reconnect(): Promise<void>;
  /** Force a write now, ignoring the debounce. */
  backupNow(): Promise<void>;
}

const Ctx = createContext<AutoBackupApi | null>(null);

export function AutoBackupProvider({
  userId,
  username,
  premium,
  children,
}: {
  userId: string;
  username: string;
  premium: boolean;
  children: ReactNode;
}) {
  const supported = supportsFileSystemAccess();
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<BackupStatus>('off');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values for the debounced closure, so it never captures stale props.
  const live = useRef({ userId, premium, supported, configured });
  live.current = { userId, premium, supported, configured };

  const active = supported && premium && configured;

  useEffect(() => {
    let cancelled = false;
    isBackupConfigured(userId).then((yes) => {
      if (cancelled) return;
      setConfigured(yes);
      setStatus(supported && premium && yes ? 'idle' : 'off');
    });
    return () => {
      cancelled = true;
    };
  }, [userId, premium, supported]);

  const runWrite = useCallback(async () => {
    setStatus('saving');
    setError(null);
    try {
      await writeBackup(userId);
      setStatus('saved');
      setLastSavedAt(Date.now());
    } catch (err) {
      if (err instanceof AutoBackupError && err.code === 'permission') {
        // The browser dropped the grant; silent writes cannot re-prompt, so ask
        // the user to reconnect from the settings tab.
        setStatus('reconnect');
      } else if (err instanceof AutoBackupError && err.code === 'empty') {
        setStatus('idle');
      } else {
        setStatus('error');
        setError((err as Error).message);
      }
    }
  }, [userId]);

  // Debounced background writer, driven by vault-change events.
  useEffect(() => {
    const off = onVaultChange((changed) => {
      const l = live.current;
      if (changed !== l.userId || !l.supported || !l.premium || !l.configured) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(runWrite, DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runWrite]);

  const configure = useCallback(async () => {
    setError(null);
    try {
      const ok = await configureBackup(userId, username);
      if (!ok) return; // user cancelled the picker
      setConfigured(true);
      setStatus('saved');
      setLastSavedAt(Date.now());
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }, [userId, username]);

  const disable = useCallback(async () => {
    await disableBackup(userId);
    setConfigured(false);
    setStatus('off');
    setError(null);
  }, [userId]);

  const reconnect = useCallback(async () => {
    setError(null);
    try {
      const granted = await reconnectBackup(userId);
      if (granted) {
        setStatus('saved');
        setLastSavedAt(Date.now());
      } else {
        setStatus('reconnect');
      }
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }, [userId]);

  const backupNow = useCallback(async () => {
    if (!active) return;
    await runWrite();
  }, [active, runWrite]);

  const value: AutoBackupApi = {
    supported,
    premium,
    configured,
    status,
    lastSavedAt,
    error,
    configure,
    disable,
    reconnect,
    backupNow,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null when rendered outside an unlocked session (provider not mounted). */
export function useAutoBackup(): AutoBackupApi | null {
  return useContext(Ctx);
}
