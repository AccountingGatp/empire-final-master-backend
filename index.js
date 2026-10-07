import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

import config from './src/config.js';
import { connectDB } from './src/db.js';

import runsRouter from './src/routes/runs.js';
import authRouter from './src/routes/auth.js';

import { requireAuth } from './src/middleware/auth.js';

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

export function createApp() {
  const app = express();

  // CORS
  app.use(cors());

  // JSON body
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      version: 'express-zero-config-1',
    });
  });

  // Database connection
  app.use(async (_req, res, next) => {
    try {
      await connectOnce();
      next();
    } catch (err) {
      console.error('[db] not ready:', err);

      res.status(500).json({
        error: 'Backend not ready',
        detail: err.message,
      });
    }
  });

  // PUBLIC Google authentication
  app.use('/api/auth', authRouter);

  // PROTECTED application routes
  app.use('/api', requireAuth, runsRouter);

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);

    res.status(500).json({
      error: err.message || 'internal error',
    });
  });

  return app;
}

const app = createApp();

export default app;

// Local development only
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  connectOnce()
    .then(() => {
      app.listen(config.port, () => {
        console.log(
          `[server] listening on http://localhost:${config.port}`
        );
      });
    })
    .catch((err) => {
      console.error('[server] failed to start', err);
      process.exit(1);
    });
}
