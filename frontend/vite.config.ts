import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

/**
 * Content-Security-Policy for the built app.
 *
 * The SPA holds the vault key in browser storage and renders peer-controlled
 * text and images, so an XSS here is a full compromise. This CSP is the
 * structural backstop: even if a rendering bug slipped through, script can only
 * load from our own origin, and there is nowhere to exfiltrate to but the API.
 *
 * Build-only (`apply: 'build'`): Vite's dev server needs inline scripts, eval,
 * and its own websocket for HMR, which a strict CSP forbids -- so this must not
 * touch dev.
 *
 * Two directives are load-bearing and easy to get wrong:
 *   - 'wasm-unsafe-eval' in script-src: libsodium is WebAssembly, and strict CSP
 *     blocks WASM compilation without it. Omit it and the whole crypto layer
 *     dies at startup.
 *   - connect-src must name the API + its websocket origin, or every request and
 *     the relay socket are blocked. Derived from VITE_API_URL at build time.
 *
 * NOTE: this cannot be verified from a headless build -- a green build does not
 * prove the running app is allowed. Smoke-test the production bundle in a real
 * browser (log in, send a message, upload an image, open a 2FA prompt) before
 * relying on it. The riskiest line is `require-trusted-types-for 'script'`: the
 * code uses no HTML/script sinks today, but an unforeseen one would throw. If a
 * violation shows up, drop that single directive.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      // Hash every inline <script> (only the theme bootstrap) so 'self' can stay
      // strict without 'unsafe-inline'.
      const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      const hashes = inline.map(
        (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
      );

      const api = process.env.VITE_API_URL || 'http://localhost:3000';
      let apiOrigin = "'self'";
      let wsOrigin = '';
      try {
        const u = new URL(api);
        apiOrigin = u.origin;
        wsOrigin = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
      } catch {
        // Malformed VITE_API_URL: fall back to 'self' only. The app will fail
        // loudly against a cross-origin API, which is the correct signal.
      }

      const csp = [
        `default-src 'none'`,
        // 'wasm-unsafe-eval' is required for libsodium; the hashes cover the
        // inline theme bootstrap. No 'unsafe-inline', no 'unsafe-eval'.
        `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
        // React writes styles via CSSOM (not blocked), but keep 'unsafe-inline'
        // for any library <style>. Style injection cannot run script.
        `style-src 'self' 'unsafe-inline'`,
        // blob: for decrypted images, data: for the theme wallpaper.
        `img-src 'self' blob: data:`,
        `font-src 'self'`,
        `connect-src 'self' ${apiOrigin} ${wsOrigin}`.trim(),
        `worker-src 'self' blob:`,
        `base-uri 'none'`,
        `object-src 'none'`,
        `frame-ancestors 'none'`,
        `form-action 'none'`,
        `require-trusted-types-for 'script'`,
      ].join('; ');

      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  resolve: {
    alias: {
      // libsodium-wrappers-sumo@0.7.16 ships a broken ESM build: it imports
      // './libsodium-sumo.mjs' as a sibling, but that file lives in the
      // separate libsodium-sumo package, so rollup cannot resolve it. Point at
      // the CJS build, which resolves its dependency normally.
      //
      // Absolute path bypasses the package's "exports" map, which would
      // otherwise block this subpath. Same workaround the non-sumo package
      // needed; the sumo build is required because crypto_pwhash (Argon2id,
      // used for the at-rest vault) is omitted from the standard build.
      'libsodium-wrappers-sumo': fileURLToPath(
        new URL(
          './node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
          import.meta.url
        )
      ),
    },
  },
  server: {
    port: 5173,
  },
});
