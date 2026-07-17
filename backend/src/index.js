import express from 'express';
import http from 'http';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import recoveryRoutes from './routes/recovery.js';
import billingRoutes from './routes/billing.js';
import channelRoutes from './routes/channels.js';
import blobRoutes, { startBlobReaper } from './routes/blobs.js';
import unfurlRoutes from './routes/unfurl.js';
import { attachRelay, startQueueReaper } from './ws/relay.js';
import { securityHeaders, corsOptions } from './middleware/security.js';
import { blobStore } from './blobStore.js';
import { initDb } from './initDb.js';

const app = express();

app.disable('x-powered-by');
// Rate limiters key on req.ip. Behind a proxy every request looks like it comes
// from the proxy, which collapses all users into one bucket.
if (config.isProd) app.set('trust proxy', 1);

app.use(securityHeaders());
app.use(cors(corsOptions()));

// The Stripe webhook verifies a signature over the exact bytes Stripe sent, so
// it must reach its handler unparsed -- express.json would reparse and
// reserialize the body and every signature would fail. The route mounts its own
// express.raw; this skip is what lets it see the original bytes.
app.use((req, res, next) => {
  if (req.path === '/billing/webhook') return next();
  express.json({ limit: config.limits.maxJsonBytes })(req, res, next);
});

app.use('/auth', authRoutes);
app.use('/account', accountRoutes);
app.use('/recovery', recoveryRoutes);
app.use('/billing', billingRoutes);
app.use('/channel', channelRoutes);
// Chunk uploads arrive as application/octet-stream and are parsed by
// express.raw inside the router. express.json above ignores them -- it only
// touches application/json -- so opaque ciphertext never reaches a body parser.
app.use('/blob', blobRoutes);
app.use('/unfurl', unfurlRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Error text can carry SQL fragments, driver internals, and file paths. Log the
// detail, return a generic message.
app.use((err, req, res, _next) => {
  if (err?.message === 'origin not allowed') {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  console.error(`${req.method} ${req.path} failed:`, err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
attachRelay(server);

initDb()
  .then(() => blobStore.init())
  .then(() => {
    startQueueReaper();
    startBlobReaper();
    server.listen(config.port, () => console.log(`CryptChat backend on :${config.port}`));
  })
  .catch((err) => {
    console.error('failed to init db:', err.message);
    process.exit(1);
  });
