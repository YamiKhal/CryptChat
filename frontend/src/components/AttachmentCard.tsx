import { useState, useEffect, useRef } from 'react';
import { Attachment } from '../lib/crypto';
import { unpackAsset, decodeImage, formatBytes, saveBlob } from '../lib/binary';
import {
  downloadAndDecrypt,
  loadRenderableImage,
  looksRenderable,
  AUTO_RENDER_MAX_BYTES,
  TransferProgress,
} from '../lib/blob';
import { useSession } from '../lib/session';

/**
 * One encrypted attachment.
 *
 * Images render inline; everything else is download-only. That split is the
 * security boundary: an image is decoded from sniffed bytes on an allowlist,
 * while an arbitrary file is forced to application/octet-stream so a blob URL
 * can never become a same-origin document.
 *
 * The inline image is the *original* file, not the envelope thumbnail -- the
 * thumbnail is canvas-flattened and would show an animated GIF as a still
 * frame. The thumbnail is used as an instant poster while the real bytes
 * arrive.
 */
export default function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const { token } = useSession();
  const isImage = looksRenderable(attachment);

  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Poster frame from inside the envelope: no network, renders immediately.
  useEffect(() => {
    if (!attachment.thumb) return;
    let release: (() => void) | null = null;
    try {
      const decoded = unpackAsset(attachment.thumb);
      const handle = decodeImage(decoded.bytes, decoded.mime);
      release = handle.release;
      setThumbUrl(handle.url);
    } catch {
      setThumbUrl(null);
    }
    return () => release?.();
  }, [attachment.thumb]);

  // Only fetch once scrolled into view. Eagerly pulling every image in a
  // channel would download and decrypt tens of MB nobody looked at.
  useEffect(() => {
    if (!isImage || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && setVisible(true),
      { rootMargin: '200px' }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isImage]);

  const autoLoad = isImage && attachment.size <= AUTO_RENDER_MAX_BYTES;
  const started = useRef(false);

  useEffect(() => {
    if (!visible || !autoLoad || !token || started.current) return;
    started.current = true;
    let cancelled = false;

    (async () => {
      try {
        const image = await loadRenderableImage(attachment, token, (p) =>
          cancelled ? undefined : setProgress(p)
        );
        if (!cancelled) setFullUrl(image.url);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          started.current = false; // allow a retry
        }
      } finally {
        if (!cancelled) setProgress(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `progress` and `fullUrl` are deliberately NOT dependencies. This effect
    // sets both, so listing them re-runs it mid-download; the cleanup then
    // flips `cancelled` and the completed download is discarded, leaving
    // progress stuck non-null and the image permanently blank. A ref guards
    // single-flight instead. The URL is cache-owned, so it is not revoked here.
  }, [visible, autoLoad, token, attachment]);

  async function handleShowLarge() {
    if (!token || progress) return;
    setError('');
    try {
      const image = await loadRenderableImage(attachment, token, setProgress);
      setFullUrl(image.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function handleDownload() {
    if (!token || progress) return;
    setError('');
    try {
      const blob = await downloadAndDecrypt(attachment, token, setProgress);
      saveBlob(blob, attachment.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  const pct = progress ? Math.round((progress.loaded / Math.max(1, progress.total)) * 100) : 0;

  /* ---------------- images: render, no download button ---------------- */
  if (isImage && !error) {
    return (
      <div ref={ref} className="mt-1">
        <div className="relative overflow-hidden rounded border border-border bg-bg/40">
          {/* Poster until the original lands, then the real thing (GIFs animate). */}
          <img
            src={fullUrl ?? thumbUrl ?? undefined}
            alt={attachment.name}
            loading="lazy"
            className={`max-h-80 w-auto max-w-full object-contain transition-[filter] duration-200 ${
              fullUrl ? '' : 'blur-[1px]'
            }`}
          />

          {!fullUrl && progress && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          {!fullUrl && !autoLoad && !progress && (
            <button
              onClick={handleShowLarge}
              className="absolute inset-0 grid place-items-center bg-bg/60 text-xs text-primary"
            >
              show image · {formatBytes(attachment.size)}
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ---------------- everything else: download only ---------------- */
  return (
    <div ref={ref} className="mt-1 overflow-hidden rounded border border-border bg-bg/40">
      {thumbUrl && !isImage && (
        <img src={thumbUrl} alt="" className="max-h-64 w-full object-cover" />
      )}

      <div className="flex items-center gap-2 p-2">
        <div className="min-w-0 flex-1">
          {/* Sanitized at receive: a filename is peer-controlled and can carry
              bidi overrides that disguise an .exe as a .pdf. */}
          <p className="truncate text-xs" title={attachment.name}>
            {attachment.name}
          </p>
          <p className="text-[10px] text-muted">
            {formatBytes(attachment.size)}
            {progress && ` · ${progress.phase} ${pct}%`}
            {error && ` · ${error}`}
          </p>
        </div>

        <button
          onClick={handleDownload}
          disabled={Boolean(progress)}
          className="btn-ghost px-2 py-1 text-[11px]"
        >
          {progress ? `${pct}%` : 'download'}
        </button>
      </div>

      {progress && (
        <div className="h-0.5 w-full bg-border">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
