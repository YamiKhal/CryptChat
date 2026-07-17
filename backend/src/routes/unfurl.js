import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { safeFetch } from '../lib/safeFetch.js';

const router = Router();

/**
 * Link preview metadata.
 *
 * This endpoint exists because the browser cannot do it: CORS stops a page
 * from reading arbitrary sites' HTML, so the sender's client cannot extract
 * Open Graph tags itself.
 *
 * The cost, stated plainly: the relay learns any URL it is asked to preview.
 * That is why previews are never automatic -- the user opts in per message
 * with a "!" prefix, or turns on the default in settings.
 *
 * Only the *sender* ever calls this. The resulting preview travels inside the
 * encrypted envelope, so recipients render it without making a single network
 * request. If recipients fetched previews themselves, posting a link to a
 * server you control would harvest the IP address of everyone in the channel.
 */

const unfurlLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many preview requests' },
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ENTITIES[e] ?? _)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function clean(value, max = 300) {
  if (typeof value !== 'string') return undefined;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/**
 * Pull meta tags with regex rather than a DOM parser.
 *
 * Adding cheerio/jsdom to parse hostile HTML would be a much larger attack
 * surface than reading a handful of attributes. Output is treated as untrusted
 * text and rendered by React as text, never HTML.
 */
function parseHtml(html) {
  const meta = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const key =
      /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content !== undefined && meta[key] === undefined) meta[key] = content;
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  return {
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 200),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description),
    siteName: clean(meta['og:site_name'], 80),
    image: meta['og:image'] ?? meta['twitter:image'] ?? meta['og:image:url'],
  };
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (!YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;
    if (u.hostname.toLowerCase().endsWith('youtu.be')) {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    const embed = /^\/(?:embed|shorts|v)\/([\w-]{11})/.exec(u.pathname);
    return embed ? embed[1] : null;
  } catch {
    return null;
  }
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

/**
 * Proxy the preview image as bytes.
 *
 * The client cannot fetch it directly -- a cross-origin image taints a canvas,
 * so it could not be re-encoded. Returning raw bytes same-origin lets the
 * sender run it through the existing canvas path, which strips EXIF and
 * normalises it before it goes into the envelope.
 */
async function fetchImage(rawUrl) {
  try {
    const res = await safeFetch(rawUrl, {
      maxBytes: config.unfurl.maxImageBytes,
      accept: 'image/*',
    });

    const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // The remote server picks this header, so it is untrusted. The client
    // re-decodes through createImageBitmap anyway, which rejects non-images.
    if (!IMAGE_MIME.has(mime)) return undefined;

    return { mime, data: res.body.toString('base64') };
  } catch {
    return undefined;
  }
}

// GET /unfurl?url=...
router.get('/', unfurlLimiter, requireAuth, async (req, res, next) => {
  try {
    if (!config.unfurl.enabled) return res.status(404).json({ error: 'previews disabled' });

    const target = req.query.url;
    if (typeof target !== 'string' || target.length > 2048) {
      return res.status(400).json({ error: 'invalid url' });
    }

    const videoId = youtubeId(target);

    if (videoId) {
      // oEmbed gives a title without scraping the watch page, and the
      // thumbnail URL is derivable from the id.
      let title;
      let siteName = 'YouTube';
      try {
        const oembed = await safeFetch(
          `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
            `https://www.youtube.com/watch?v=${videoId}`
          )}`,
          { maxBytes: 64 * 1024, accept: 'application/json' }
        );
        const parsed = JSON.parse(oembed.body.toString('utf8'));
        title = clean(parsed.title, 200);
        if (parsed.author_name) siteName = `YouTube · ${clean(parsed.author_name, 60)}`;
      } catch {
        // Preview still works with just a thumbnail.
      }

      const image =
        (await fetchImage(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)) ??
        (await fetchImage(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`));

      return res.json({
        url: target,
        kind: 'youtube',
        videoId,
        title: title ?? 'YouTube video',
        siteName,
        image,
      });
    }

    const page = await safeFetch(target, {
      // Direct image links need room for the whole image, not just an HTML head.
      maxBytes: Math.max(config.unfurl.maxHtmlBytes, config.unfurl.maxImageBytes),
      accept: 'text/html,image/*,*/*',
    });

    const contentType = String(page.headers['content-type'] || '').toLowerCase();
    const mime = contentType.split(';')[0].trim();

    // A link straight to an image is the image -- no Open Graph involved.
    // Returned as raw bytes so the sender can embed it whole, which is what
    // lets a GIF keep its frames instead of being flattened to a poster.
    if (IMAGE_MIME.has(mime)) {
      return res.json({
        url: page.url,
        kind: 'image',
        siteName: new URL(page.url).hostname,
        image: { mime, data: page.body.toString('base64') },
      });
    }

    if (!contentType.includes('html')) {
      return res.json({ url: page.url, kind: 'link', title: undefined });
    }

    const meta = parseHtml(page.body.toString('utf8'));

    let image;
    if (meta.image) {
      // og:image may be relative, and it is attacker-controlled -- resolve it
      // and put it back through the same SSRF checks.
      try {
        image = await fetchImage(new URL(meta.image, page.url).toString());
      } catch {
        image = undefined;
      }
    }

    res.json({
      url: page.url,
      kind: 'link',
      title: meta.title,
      description: meta.description,
      siteName: meta.siteName ?? new URL(page.url).hostname,
      image,
    });
  } catch (err) {
    // Never leak internals: "blocked: resolves to a private address" and
    // connection errors both become the same generic failure, so this cannot
    // be used as an internal port scanner.
    return res.status(422).json({ error: 'could not fetch preview' });
  }
});

export default router;
