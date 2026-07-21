import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * libsodium-wrappers-sumo's ESM build is broken: dist/modules-sumo-esm/
 * ships libsodium-wrappers.mjs but not the libsodium-sumo.mjs it imports.
 * Vite's browser pipeline hides this by pre-bundling the CJS build, but Vitest
 * resolves the package entry directly and dies on the missing file.
 *
 * Pointing the alias at the CJS build is what the browser effectively gets
 * anyway, so the tests exercise the same code that ships.
 */
// Built from node_modules directly. The package's "exports" map exposes only
// ".", so require.resolve refuses both the deep path and ./package.json --
// there is no supported way to ask Node where this file is.
const sodiumCjs = fileURLToPath(
  new URL(
    './node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
    import.meta.url
  )
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Keep in sync with tsconfig `paths` and vite.config.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'libsodium-wrappers-sumo': sodiumCjs,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    // Argon2id in WASM is genuinely slow, by design. The default 5s fails these
    // on a cold cache, which looks like a bug and is not.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
