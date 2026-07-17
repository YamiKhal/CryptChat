import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// test/helpers -> test -> backend. Not the repo root: resolving one level
// further and re-appending 'backend' double-counts it.
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Boots a real backend for the suite and tears it down afterwards.
 *
 * A real process, not an in-process app instance: the WebSocket handshake, the
 * body-parser ordering for the Stripe webhook, and the boot-time config guards
 * only exist in a real process. Testing around them would test a different
 * program than the one that ships.
 *
 * Requires Postgres to be up (`docker compose up -d` from the repo root). If it
 * is not, the boot fails loudly here rather than as twenty confusing test
 * failures.
 */

export const LOG_PATH = path.join(backendDir, 'test-server.log');

let child = null;

export async function startServer({ port = 3000, env = {} } = {}) {
  if (child) throw new Error('server already started');

  // Fresh log per run: the mail-link readers scan for the *last* match, and a
  // stale log would hand a previous run's token to this one.
  fs.writeFileSync(LOG_PATH, '');
  const log = fs.openSync(LOG_PATH, 'a');

  child = spawn('node', ['src/index.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      // No MAIL_API_KEY: the dev mailer prints links to stdout, which is how the
      // tests read verification and reset tokens.
      MAIL_API_KEY: '',
      // The suite registers dozens of accounts in seconds, which is exactly what
      // the registration limiter exists to stop. Safe here: config.js refuses to
      // boot production with this set.
      DISABLE_RATE_LIMITS: 'true',

      /**
       * Billing off unless a test asks for it.
       *
       * These are explicit empty strings, not omissions, and both halves matter.
       * The suite inherits process.env so it can reach Postgres, which means it
       * also inherits whatever the developer happens to have in backend/.env --
       * so the moment someone adds real Stripe keys for local work, a test
       * asserting "checkout 404s when billing is unconfigured" starts failing on
       * their machine and passing in CI. A test must not depend on who is
       * running it.
       *
       * Empty string rather than `delete`: dotenv only fills keys that are
       * absent from process.env, so an empty value is what actually stops
       * backend/.env from reapplying them.
       */
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PRICE_ID: '',
      STRIPE_PORTAL_URL: '',

      ...env,
    },
    stdio: ['ignore', log, log],
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const tail = fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-15).join('\n');
      console.error(`backend exited with ${code}:\n${tail}`);
    }
  });

  await waitForHealth(`http://localhost:${port}/health`);
  return child;
}

async function waitForHealth(url, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const tail = fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-20).join('\n');
  throw new Error(
    `backend did not become healthy within ${timeout}ms.\n` +
      `Is Postgres running? Try: docker compose up -d\n\nLast log lines:\n${tail}`
  );
}

export async function stopServer() {
  if (!child) return;
  const dying = child;
  child = null;

  await new Promise((resolve) => {
    dying.once('exit', resolve);
    dying.kill('SIGTERM');
    // SIGTERM is ignored if the process is wedged; do not hang the suite on it.
    setTimeout(() => {
      dying.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

export function readLog() {
  return fs.readFileSync(LOG_PATH, 'utf8');
}

/** Current end of the log, to scan forward from. */
export function logCursor() {
  return readLog().length;
}

/**
 * Run `action`, then wait for the mail link it causes.
 *
 * The cursor is the whole point. Routes deliberately do NOT await the mail send
 * (awaiting the provider inside /recovery/request would leak timing and turn the
 * endpoint into an account-enumeration oracle), so the link lands in the log
 * slightly *after* the HTTP response returns.
 *
 * Scanning the whole log for the last match therefore races: it finds the
 * PREVIOUS test's token, returns it immediately, and the test fails with a
 * confusing "invalid or expired link". Taking the cursor before the action and
 * scanning only forward from it makes each test read its own mail.
 */
export async function captureMailLink(kind, action, { timeout = 5000 } = {}) {
  const from = logCursor();
  const result = await action();
  const token = await waitForMailLink(kind, { from, timeout });
  return { token, result };
}

export async function waitForMailLink(kind, { timeout = 5000, from = 0 } = {}) {
  const deadline = Date.now() + timeout;
  const pattern = new RegExp(`${kind}\\?token=([A-Za-z0-9_-]+)`, 'g');

  while (Date.now() < deadline) {
    const matches = [...readLog().slice(from).matchAll(pattern)];
    if (matches.length) return matches[matches.length - 1][1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${kind} link appeared in the server log within ${timeout}ms`);
}
