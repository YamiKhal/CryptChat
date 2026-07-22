import { useEffect, useRef, useState } from 'react';
import { Smile, Search } from 'lucide-react';

/**
 * A small, self-contained emoji picker.
 *
 * Deliberately a hand-rolled list rather than an npm picker: the popular ones
 * pull a megabyte of sprite sheets or, worse, fetch them from a CDN at runtime.
 * A network request from inside a chat that promises the server learns nothing
 * would be a real leak -- and the artifact CSP would block it anyway. Everything
 * here is inline text.
 */

interface EmojiGroup {
  name: string;
  emoji: string[];
}

/** Curated, not exhaustive. Covers the common cases without a 4000-entry table. */
const GROUPS: EmojiGroup[] = [
  {
    name: 'Smileys',
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
      '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
      '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😔',
      '😪', '🤤', '😴', '😷', '🤒', '🤕', '🥴', '😵', '🤯', '🤠',
      '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😮', '😯', '😲',
      '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
      '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠',
    ],
  },
  {
    name: 'Gestures',
    emoji: [
      '👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈',
      '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏',
      '🙌', '🤝', '🙏', '✍️', '💪', '🦾', '🫶', '👐', '🤲', '🫡',
    ],
  },
  {
    name: 'Hearts',
    emoji: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
    ],
  },
  {
    name: 'Objects',
    emoji: [
      '🔥', '✨', '⭐', '🌟', '💫', '💥', '💯', '🎉', '🎊', '🎈',
      '🎁', '🏆', '🥇', '👀', '💀', '☠️', '👻', '👽', '🤖', '💩',
      '🚀', '⚡', '💡', '🔒', '🔑', '⏰', '📌', '📎', '✅', '❌',
      '⚠️', '❓', '❗', '💬', '👋', '🍀', '🌈', '☀️', '🌙', '⛄',
    ],
  },
  {
    name: 'Food',
    emoji: [
      '🍕', '🍔', '🍟', '🌭', '🍿', '🧂', '🥓', '🥚', '🍳', '🧇',
      '🥞', '🧈', '🍞', '🥐', '🥨', '🧀', '🥗', '🌮', '🌯', '🍣',
      '🍜', '🍝', '🍤', '🍰', '🎂', '🍪', '🍫', '🍬', '🍭', '🍩',
      '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🥂', '🍷', '🥃', '🧊',
    ],
  },
  {
    name: 'Animals',
    emoji: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧',
      '🐦', '🦆', '🦉', '🦄', '🐝', '🦋', '🐙', '🦀', '🐳', '🐬',
    ],
  },
];

/** Keywords for search. Only the ones people actually reach for. */
const KEYWORDS: Record<string, string> = {
  '😂': 'laugh cry joy lol',
  '🤣': 'rofl laugh rolling',
  '👍': 'thumbs up yes ok good like',
  '👎': 'thumbs down no bad dislike',
  '❤️': 'heart love red',
  '🔥': 'fire lit hot flame',
  '🎉': 'party tada celebrate congrats',
  '😍': 'love eyes heart',
  '🙏': 'pray thanks please',
  '👀': 'eyes look watching',
  '💯': 'hundred perfect score',
  '✅': 'check done tick yes',
  '❌': 'cross no wrong',
  '🚀': 'rocket launch ship',
  '💀': 'skull dead dying',
  '😭': 'sob cry sad',
  '🤔': 'think thinking hmm',
  '🥳': 'party celebrate birthday',
  '😎': 'cool sunglasses',
  '⚠️': 'warning caution',
};

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Anchored above the composer, or at a point for reactions. */
  anchor?: { x: number; y: number };
}

export default function EmojiPicker({ onPick, onClose, anchor }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(0);

  useEffect(() => {
    const onPointerDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? GROUPS.flatMap((g) => g.emoji).filter((e) => (KEYWORDS[e] ?? '').includes(trimmed))
    : GROUPS[group].emoji;

  const style = anchor
    ? { left: Math.min(anchor.x, window.innerWidth - 296), top: anchor.y }
    : undefined;

  return (
    <div
      ref={ref}
      className={`menu-panel ${anchor ? 'fixed' : 'absolute bottom-full right-0 mb-2 origin-bottom'} z-50 w-72 p-2`}
      style={style}
    >
      <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 transition-colors focus-within:border-primary">
        <Search size={12} className="flex-none text-muted" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search"
          className="w-full bg-transparent t-base outline-none placeholder:text-muted"
        />
      </div>

      {!trimmed && (
        <div className="mb-2 flex gap-1 overflow-x-auto">
          {GROUPS.map((g, i) => (
            <button
              key={g.name}
              onClick={() => setGroup(i)}
              className={`whitespace-nowrap rounded-full px-2.5 py-1 t-small font-medium transition-colors
                ${i === group ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface hover:text-foreground'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto">
        {results.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onPick(emoji)}
            className="rounded-lg p-1 t-h2 leading-none transition-[background-color,transform] duration-100 hover:scale-110 hover:bg-primary-soft"
            title={KEYWORDS[emoji] ?? ''}
          >
            {emoji}
          </button>
        ))}
      </div>

      {results.length === 0 && (
        <p className="py-4 text-center t-base text-muted">nothing matches “{query}”</p>
      )}
    </div>
  );
}

export { Smile as EmojiIcon };
