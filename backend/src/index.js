import express from 'express';
import http from 'http';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import channelRoutes from './routes/channels.js';
import { attachRelay, startQueueReaper } from './ws/relay.js';
import { securityHeaders, corsOptions } from './middleware/security.js';
import { initDb } from './initDb.js';

const app = express();

app.disable('x-powered-by');
// Rate limiters key on req.ip. Behind a proxy every request looks like it comes
// from the proxy, which collapses all users into one bucket.
if (config.isProd) app.set('trust proxy', 1);

app.use(securityHeaders());
app.use(cors(corsOptions()));
app.use(express.json({ limit: config.limits.maxJsonBytes }));

app.use('/auth', authRoutes);
app.use('/channel', channelRoutes);

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
  .then(() => {
    startQueueReaper();
    server.listen(config.port, () => console.log(`CryptChat backend on :${config.port}`));
  })
  .catch((err) => {
    console.error('failed to init db:', err.message);
    process.exit(1);
  });
