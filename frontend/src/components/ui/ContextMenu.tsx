import { useEffect, useRef, useState, useCallback, ReactNode } from 'react';

/**
 * A context menu that works on both pointers and touch.
 *
 * Desktop opens it with right-click. Touch has no right-click, so it opens on a
 * long press -- which is the one interaction that has to be built carefully,
 * because the browser's own defaults fight it: a long press on text starts a
 * selection, and on iOS it opens the native callout. Both are suppressed only
 * while the press is being tracked, so ordinary text selection still works.
 */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Rendered in red. For destructive things only. */
  danger?: boolean;
  disabled?: boolean;
  /** Explains a disabled item -- a greyed row with no reason is a dead end. */
  hint?: string;
}

interface Position {
  x: number;
  y: number;
}

/** How long a touch must be held. 500ms matches the platform convention. */
const LONG_PRESS_MS = 500;

/** Finger drift that cancels the press -- past this it is a scroll, not a hold. */
const MOVE_TOLERANCE_PX = 10;

interface ContextMenuProps {
  items: MenuItem[];
  position: Position;
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<Position>(position);

  // Flip the menu back inside the viewport. Opened near the right or bottom
  // edge -- which is most of a chat screen -- a naively placed menu renders
  // half off-screen with its items unreachable.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const pad = 8;
    let { x, y } = position;

    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;

    setAdjusted({ x: Math.max(pad, x), y: Math.max(pad, y) });
  }, [position]);

  // Close on anything that means "I'm done": click elsewhere, Escape, scroll,
  // resize. Listening in the capture phase matters -- a click on another
  // message should close this menu, not open that message's.
  useEffect(() => {
    const onPointerDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    // Not passive:false -- we only observe. Closing on scroll avoids a menu
    // floating detached from the message it belongs to.
    window.addEventListener('scroll', onClose, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="menu-panel fixed z-50 min-w-48"
      style={{ left: adjusted.x, top: adjusted.y }}
      // The menu is itself right-clickable territory; don't open the browser's.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={item.disabled}
          title={item.hint}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
          className={`menu-item ${item.danger && !item.disabled ? 'menu-item-danger' : ''}`}
        >
          {item.icon && <span className="flex-none">{item.icon}</span>}
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Wires long-press and right-click to one open handler.
 *
 * Returns props to spread onto the target element plus the menu state. Pointer
 * events rather than separate mouse/touch handlers: they unify the two, and
 * `pointerType` still distinguishes them where it matters.
 */
export function useContextMenu() {
  const [position, setPosition] = useState<Position | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<Position | null>(null);
  const longPressFired = useRef(false);

  const close = useCallback(() => setPosition(null), []);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const handlers = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
    },

    onPointerDown: (e: React.PointerEvent) => {
      // Mouse right-click is already handled by onContextMenu; a second path
      // would open the menu twice.
      if (e.pointerType === 'mouse') return;

      longPressFired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };

      timer.current = setTimeout(() => {
        longPressFired.current = true;
        setPosition({ x: origin.current!.x, y: origin.current!.y });
        // Haptic confirmation, where supported. Without it a long press feels
        // like nothing happened until the menu paints.
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    },

    onPointerMove: (e: React.PointerEvent) => {
      if (!origin.current || !timer.current) return;
      const dx = Math.abs(e.clientX - origin.current.x);
      const dy = Math.abs(e.clientY - origin.current.y);
      // Past the tolerance the user is scrolling the transcript. Opening a menu
      // mid-scroll would make the list unusable on touch.
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) cancel();
    },

    onPointerUp: cancel,
    onPointerCancel: cancel,

    // Suppress the native callout/selection *only* while a press is pending, so
    // normal text selection is untouched the rest of the time.
    onContextMenuCapture: (e: React.MouseEvent) => {
      if (longPressFired.current) e.preventDefault();
    },

    style: { WebkitTouchCallout: 'none' as const },
  };

  return { position, handlers, close, isOpen: position !== null };
}
