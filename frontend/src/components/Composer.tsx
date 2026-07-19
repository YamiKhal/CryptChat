import { useRef, useEffect, useLayoutEffect, useState, KeyboardEvent } from 'react';
import { Paperclip, Send, Smile, Lock, Timer, EyeOff, SlidersHorizontal } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import { Limits, countChars } from '../lib/limits';

/**
 * The message composer.
 *
 * Auto-growing textarea rather than an <input>: an input scrolls a long message
 * horizontally out of view, so you cannot see what you wrote. This wraps, grows
 * downward to a ceiling, and only then scrolls internally.
 */

/** Ceiling before the textarea scrolls instead of growing. ~6 lines. */
const MAX_HEIGHT_PX = 140;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onAttach: () => void;
  disabled?: boolean;
  sending?: boolean;
  uploading?: boolean;
  canSend: boolean;
  limits: Limits;
  placeholder?: string;
  /** Whether the password-lock control is offered (premium). */
  canLock?: boolean;
  /** Whether the next message will be sent locked. */
  lockArmed?: boolean;
  onToggleLock?: () => void;
  /** Whether the disappearing-message control is offered (premium). */
  canBurn?: boolean;
  /** Whether the next message will disappear after being read. */
  burnArmed?: boolean;
  onToggleBurn?: () => void;
  /** Whether the next message will be sent covered as a spoiler. */
  spoilerArmed?: boolean;
  onToggleSpoiler?: () => void;
}

export default function Composer({
  value,
  onChange,
  onSend,
  onAttach,
  disabled,
  sending,
  uploading,
  canSend,
  limits,
  placeholder,
  canLock,
  lockArmed,
  onToggleLock,
  canBurn,
  burnArmed,
  onToggleBurn,
  spoilerArmed,
  onToggleSpoiler,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showTools, setShowTools] = useState(false);

  // The lock / spoiler / burn controls live together behind one button so the
  // bar stays uncluttered. Only rendered when at least one is available.
  const hasTools = canLock || canBurn || Boolean(onToggleSpoiler);
  const toolsArmed = lockArmed || burnArmed || spoilerArmed;

  const attachTitle = limits.canUpload
    ? `Attach a file (max ${Math.floor(limits.maxFileBytes / 1024 / 1024)}MB)`
    : (limits.uploadDenialReason ?? 'Uploads are unavailable');

  const used = countChars(value);
  const over = used > limits.maxChars;
  // Only surface the counter when it starts to matter. A permanent "0/1000"
  // turns a chat box into a form field.
  const showCounter = used > limits.maxChars * 0.8;

  /**
   * Grow to fit, then stop.
   *
   * Height must be reset to 'auto' before reading scrollHeight, or the textarea
   * only ever grows -- scrollHeight never reports less than the current height,
   * so deleting text would leave it stuck tall.
   *
   * useLayoutEffect, not useEffect: this runs before paint, so the box does not
   * visibly jump between the old and new height on every keystroke.
   */
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;

    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
    // Scroll internally only once it has hit the ceiling; below that an
    // always-scrollable box shows a scrollbar over two lines of text.
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [value]);

  useEffect(() => {
    if (!disabled) textarea.current?.focus();
  }, [disabled]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter newlines. IME composition must be ignored --
    // pressing Enter to accept a Japanese or Chinese candidate would otherwise
    // fire the message mid-word.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend && !over) onSend();
    }
  }

  function insertEmoji(emoji: string) {
    const el = textarea.current;
    if (!el) {
      onChange(value + emoji);
      return;
    }
    // Insert at the caret, not the end -- appending would be wrong whenever the
    // user has clicked back into the middle of what they wrote.
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);

    requestAnimationFrame(() => {
      el.focus();
      const caret = start + emoji.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    // min-h-16 matches the channel column's account bar so the two footers line
    // up across the split. flex-col + justify-center keeps the single-line bar
    // vertically centred in that height, then grows past it when needed.
    <div className="relative flex min-h-16 flex-col justify-center border-t border-border bg-surface px-3 py-2">
      {showEmoji && (
        <EmojiPicker
          onPick={(emoji) => {
            insertEmoji(emoji);
            setShowEmoji(false);
          }}
          onClose={() => setShowEmoji(false)}
        />
      )}

      <div className="flex items-end gap-2">
        {/* Mobile: the attach control lives outside the bar as its own button so
            the bar keeps room for the text on a narrow screen. */}
        <button
          onClick={onAttach}
          disabled={disabled || uploading || !limits.canUpload}
          className="icon-btn flex-none sm:hidden"
          title={attachTitle}
          aria-label="Attach a file"
        >
          <Paperclip size={18} />
        </button>

        {/* The Discord-style bar: one rounded, solid container holding every
            in-line control. bg-surface-raised keeps it opaque -- video
            wallpapers must never bleed through. focus-within lights the border
            while typing; over-limit turns it red. */}
        <div
          className={`flex min-h-11 min-w-0 flex-1 items-center gap-0.5 rounded-2xl border bg-surface-raised px-1.5
                      transition-colors ${
                        over
                          ? 'border-error'
                          : 'border-border focus-within:border-primary'
                      }`}
        >
          {/* Desktop: attach sits inside the bar, on the left. */}
          <button
            onClick={onAttach}
            disabled={disabled || uploading || !limits.canUpload}
            className="icon-btn hidden flex-none sm:flex"
            title={attachTitle}
            aria-label="Attach a file"
          >
            <Paperclip size={18} />
          </button>

          <textarea
            ref={textarea}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            // resize-none: the height is ours to manage. wrap-break-word stops a
            // single long token (a URL) from forcing horizontal overflow.
            // Transparent + borderless: the bar owns the frame, not the textarea.
            className="max-h-[140px] min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent px-1.5
                       py-2.5 t-h4 leading-snug outline-none wrap-break-word placeholder:text-muted"
          />

          {hasTools && (
          <div className="relative flex-none">
            {showTools && (
              <>
                {/* Click-away backdrop, below the popover. */}
                <div className="fixed inset-0 z-40" onClick={() => setShowTools(false)} />
                <div
                  className="absolute bottom-full right-0 z-50 mb-2 w-52 space-y-1 rounded-lg
                             border border-border bg-surface-raised p-1.5 shadow-xl animate-fade-in"
                >
                  {canLock && (
                    <button
                      onClick={() => {
                        onToggleLock?.();
                        setShowTools(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 t-base
                                  transition-colors hover:bg-primary-soft ${
                                    lockArmed ? 'text-primary' : 'text-foreground'
                                  }`}
                    >
                      <Lock size={15} className="flex-none" />
                      Password-protect
                    </button>
                  )}
                  {onToggleSpoiler && (
                    <button
                      onClick={() => {
                        onToggleSpoiler();
                        setShowTools(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 t-base
                                  transition-colors hover:bg-primary-soft ${
                                    spoilerArmed ? 'text-primary' : 'text-foreground'
                                  }`}
                    >
                      <EyeOff size={15} className="flex-none" />
                      Mark as spoiler
                    </button>
                  )}
                  {canBurn && (
                    <button
                      onClick={() => {
                        onToggleBurn?.();
                        setShowTools(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 t-base
                                  transition-colors hover:bg-primary-soft ${
                                    burnArmed ? 'text-primary' : 'text-foreground'
                                  }`}
                    >
                      <Timer size={15} className="flex-none" />
                      Disappearing message
                    </button>
                  )}
                </div>
              </>
            )}
            <button
              onClick={() => setShowTools((s) => !s)}
              disabled={disabled}
              className={`icon-btn ${toolsArmed ? 'text-primary' : ''}`}
              title="Message tools"
              aria-label="Message tools"
              aria-pressed={toolsArmed}
            >
              <SlidersHorizontal size={18} />
            </button>
          </div>
          )}

          <button
            onClick={() => setShowEmoji((s) => !s)}
            disabled={disabled}
            className="icon-btn flex-none"
            title="Emoji"
            aria-label="Insert emoji"
          >
            <Smile size={18} />
          </button>
        </div>

        {/* Send stays separate from the bar, as requested. */}
        <button
          onClick={onSend}
          disabled={disabled || sending || !canSend || over}
          className="btn-primary h-11 flex-none self-end px-3.5"
          title={over ? 'Message is too long' : 'Send'}
          aria-label="Send message"
        >
          {sending ? '…' : <Send size={18} />}
        </button>
      </div>

      {showCounter && (
        <p
          className={`mt-1 text-right t-small tabular-nums ${over ? 'text-error' : 'text-muted'}`}
        >
          <span data-testid="char-count">
            {`${used.toLocaleString()} / ${limits.maxChars.toLocaleString()}`}
          </span>
          {over && !limits.premium && (
            <span className="ml-1">— supporters get {(4000).toLocaleString()}</span>
          )}
        </p>
      )}
    </div>
  );
}
