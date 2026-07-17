/**
 * Link handling.
 *
 * Two rules, both about not leaking:
 *
 * 1. A preview is only ever built when the user asks for it -- by prefixing
 *    the link with "!", or by turning on the default in settings. Building one
 *    means the relay is told that URL, and that should never happen by
 *    accident.
 * 2. Rendering a link never touches the network. Links are plain text with an
 *    anchor; nothing is fetched, so no third party learns a reader's IP.
 */

// Deliberately conservative: http/https only. Bare "www." is not matched --
// guessing a scheme for a user is how you turn a typo into a request.
const URL_PATTERN = /(!?)(https?:\/\/[^\s<>"'`]+)/g;

// Trailing punctuation is almost always sentence grammar, not part of the URL.
const TRAILING = /[.,!?;:'"]+$/;

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Trim sentence punctuation off a URL.
 *
 * Only drops a closing bracket when it is unbalanced, so "(see
 * https://x.com/a)" loses the paren but "https://x.com/a_(b)" keeps it.
 */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');

  for (;;) {
    const last = url[url.length - 1];
    const open = CLOSERS[last];
    if (!open) break;

    const opens = url.split(open).length - 1;
    const closes = url.split(last).length - 1;
    if (closes <= opens) break;

    url = url.slice(0, -1).replace(TRAILING, '');
  }

  return url;
}

export interface FoundLink {
  /** The URL itself, without the "!" marker. */
  url: string;
  /** True when the user explicitly asked for a preview with "!". */
  marked: boolean;
}

export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[2]);
    if (isSafeUrl(url)) found.push({ url, marked: match[1] === '!' });
  }
  return found;
}

/**
 * Which URL (if any) to preview.
 *
 * A "!" always wins. Otherwise the per-user default applies to the first link.
 * At most one preview per message, so the envelope stays well under the 256KB
 * cap no matter how many links someone pastes.
 */
export function pickPreviewUrl(text: string, alwaysPreview: boolean): string | null {
  const links = findLinks(text);
  if (links.length === 0) return null;

  const marked = links.find((l) => l.marked);
  if (marked) return marked.url;

  return alwaysPreview ? links[0].url : null;
}

/**
 * Remove the "!" markers before sending, so the marker is a control character
 * for the sender and never shows up in the recipient's text.
 */
export function stripPreviewMarkers(text: string): string {
  return text.replace(URL_PATTERN, (_, _bang, url) => url);
}

export function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    // javascript:, data:, vbscript: in an href are script execution. Anchors
    // only ever get http/https.
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; url: string };

/**
 * Split a message body into text and link runs for rendering.
 *
 * Returns data, not markup: the caller renders React elements, so a message
 * body can never become HTML. No dangerouslySetInnerHTML anywhere near
 * peer-controlled text.
 */
export function segmentize(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[2];
    const url = trimUrl(raw);

    if (!isSafeUrl(url)) continue;

    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) });
    }

    segments.push({ type: 'link', value: url, url });

    // Keep any trailing punctuation that trimUrl removed.
    cursor = start + match[1].length + url.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  return segments;
}
