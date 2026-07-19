import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';

/**
 * Outbound fetch for user-supplied URLs.
 *
 * Every URL here is chosen by whoever typed the message, which makes this a
 * server-side request forgery primitive unless it is locked down. The whole
 * point of this module is that an attacker cannot aim it at the infrastructure
 * it runs on -- Postgres on the internal network, Coolify's own API, or the
 * cloud metadata endpoint at 169.254.169.254, which on many hosts hands out
 * credentials to anything that asks.
 */

/* ------------------------------------------------------------------ */
/* address filtering                                                   */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

// Everything that is not routable public internet. Loopback and link-local are
// the obvious ones; 169.254.0.0/16 is the dangerous one (cloud metadata), and
// the carrier-grade NAT / benchmark / documentation blocks are cheap to add.
const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPublicIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (ipv4ToInt(base) & mask)) return false;
  }
  return true;
}

function isPublicIpv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];

  if (addr === '::1' || addr === '::') return false;

  // IPv4-mapped (::ffff:10.0.0.1) would otherwise sail past the v6 checks and
  // land on a private v4 host.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPublicIpv4(mapped[1]);

  const head = addr.split(':')[0];
  const first = parseInt(head || '0', 16);
  if (Number.isNaN(first)) return false;

  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7  unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if (first === 0x2002) return false; // 6to4 -- can encapsulate a private v4
  if ((first & 0xff00) === 0xff00) return false; // multicast

  return true;
}

export function isPublicAddress(ip, family) {
  return Number(family) === 4 ? isPublicIpv4(ip) : isPublicIpv6(ip);
}

/**
 * DNS lookup that refuses to resolve to anything internal.
 *
 * Installed as the socket's `lookup` hook rather than checked up-front, which
 * is what closes DNS rebinding: a hostname that passes a pre-flight check can
 * return a different address on the *next* resolution, and the connection is
 * what matters. Validating inside the hook means the address actually
 * connected to is the address that was approved.
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);

    const allowed = addresses.filter((record) => isPublicAddress(record.address, record.family));
    if (allowed.length === 0) {
      return callback(Object.assign(new Error('blocked: resolves to a private address'), {
        code: 'EBLOCKED',
      }));
    }

    if (options.all) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  });
}

/* ------------------------------------------------------------------ */
/* fetch                                                               */
/* ------------------------------------------------------------------ */

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  // Scheme allowlist. Without it: file:///etc/passwd, gopher://, and the
  // various smuggling tricks.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http and https are allowed');
  }
  if (url.username || url.password) throw new Error('credentials in url are not allowed');

  // Literal IPs must be checked here, because they never reach safeLookup:
  // Node skips DNS resolution entirely when the host is already an address, so
  // the lookup hook -- the thing that blocks private ranges -- is never
  // invoked. Without this, http://169.254.169.254/ goes straight to the cloud
  // metadata service, and http://127.0.0.1:5433/ straight to Postgres.
  // URL.hostname keeps the brackets on IPv6 literals.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (family !== 0 && !isPublicAddress(host, family)) {
    throw new Error('blocked: private address');
  }

  return url;
}

function requestOnce(url, { maxBytes, timeoutMs, accept }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        headers: {
          // Identify honestly and ask for what we can parse.
          'User-Agent': 'CryptChat-LinkPreview/1.0 (+link preview bot)',
          Accept: accept,
          'Accept-Encoding': 'identity',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;

        // A Content-Length is a hint, not a promise -- enforce on the wire too.
        const declared = Number(res.headers['content-length'] || 0);
        if (declared && declared > maxBytes) {
          res.destroy();
          return reject(new Error('response too large'));
        }

        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            return reject(new Error('response too large'));
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      }
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a public URL with redirects followed manually.
 *
 * Manual redirects are the point: an allowed URL that 302s to
 * http://169.254.169.254/ must be re-validated, and letting the http client
 * chase redirects itself would skip that check entirely.
 */
export async function safeFetch(rawUrl, { maxBytes, accept = '*/*' } = {}) {
  const limit = maxBytes ?? config.unfurl.maxHtmlBytes;
  let url = validateUrl(rawUrl);

  for (let hop = 0; hop <= config.unfurl.maxRedirects; hop++) {
    const res = await requestOnce(url, {
      maxBytes: limit,
      timeoutMs: config.unfurl.timeoutMs,
      accept,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === config.unfurl.maxRedirects) throw new Error('too many redirects');
      url = validateUrl(new URL(res.headers.location, url).toString());
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`upstream returned ${res.status}`);
    }

    return { ...res, url: url.toString() };
  }

  throw new Error('too many redirects');
}
