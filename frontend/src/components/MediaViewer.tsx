import { useState, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Wraps an inline chat image or GIF so a click opens it full size in a modal.
 *
 * The thumbnail keeps whatever markup the caller passed as children; this only
 * adds the click target and the overlay. The overlay renders through a portal on
 * document.body so a message bubble's `overflow-hidden` cannot clip it, sits on a
 * darkened, padded backdrop (so it reads as an overlay on the chat, not a new
 * page), and closes on a backdrop click, the ✕, or Escape.
 *
 * No network is involved: `src` is already the decoded object URL the bubble is
 * showing, so opening the viewer never fetches anything.
 */
export default function MediaViewer({
  src,
  alt,
  children,
}: {
  src: string;
  alt?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Stop the click from reaching the bubble (spoiler cover, context row).
          e.stopPropagation();
          setOpen(true);
        }}
        className="block w-full cursor-zoom-in"
        aria-label="View image full size"
      >
        {children}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black p-4 sm:p-8
                       animate-fade-in motion-reduce:animate-none"
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
          >
            <img
              src={src}
              alt={alt ?? ''}
              className="max-h-full max-w-full rounded object-contain shadow-2xl"
              // Clicking the image itself must not close it -- only the backdrop.
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full
                         bg-zinc-800 text-white transition-colors hover:bg-zinc-700"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
