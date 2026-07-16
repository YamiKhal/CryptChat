import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
