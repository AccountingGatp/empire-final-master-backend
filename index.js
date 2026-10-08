import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import config from './src/config.js';
import { connectDB } from './src/db.js';
import runsRouter from './src/routes/runs.js';
import authRouter from './src/routes/auth.js';
import { requireAuth } from './src/middleware/auth.js';

// Connect to Mongo once, cached across warm serverless invocations. Clear the
// cache on failure so the next request can retry (don't poison it).
let dbPromise;
function connectOnce() {
  if (!dbPromise) {
    dbPromise = connectDB().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// Build the Express app.
export function createApp() {
  const app = express();
  app.use(cors()); // allow all origins
  app.use(express.json());

  // Liveness check — no DB required.
  // `version` lets you confirm which code Vercel is actually running.
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: 'sop-1.3 · 2026-10-06' }));

  // Ensure the DB is connected before handling data routes (serverless-friendly).
  app.use(async (_req, res, next) => {
    try {
      await connectOnce();
      next();
    } catch (err) {
      console.error('[db] not ready:', err);
      res.status(500).json({ error: 'Backend not ready', detail: err.message });
    }
  });

  app.use('/api/auth', authRouter);
  // Every run / file / journal endpoint needs a signed-in user.
  app.use('/api', requireAuth, runsRouter);

  // Fallback error handler.
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}

const app = createApp();

// Default export = the Express app instance (a valid serverless handler/server).
export default app;

// Only listen when run directly (`node index.js` / `npm start`); serverless
// platforms import the default export and manage the port themselves.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  connectOnce()
    .then(() => {
      app.listen(config.port, () => {
        console.log(`[server] listening on http://localhost:${config.port}`);
      });
    })
    .catch((err) => {
      console.error('[server] failed to start', err);
      process.exit(1);
    });
}
