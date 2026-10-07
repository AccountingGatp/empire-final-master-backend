import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

import config from './src/config.js';
import { connectDB } from './src/db.js';

import runsRouter from './src/routes/runs.js';
import authRouter from './src/routes/auth.js';

import { requireAuth } from './src/middleware/auth.js';

// ==================================================
// MongoDB connection
// ==================================================

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

// ==================================================
// Express application
// ==================================================

export function createApp() {
  const app = express();

  // ==================================================
  // CORS
  // ==================================================
  //
  // Keep this simple.
  // This is the same approach used by the old
  // working developer version.
  //

  app.use(cors());

  // ==================================================
  // JSON BODY
  // ==================================================

  app.use(express.json({ limit: '10mb' }));

  // ==================================================
  // HEALTH CHECK
  // ==================================================

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      version: 'working-cors-1',
    });
  });

  // ==================================================
  // DATABASE
  // ==================================================
  //
  // Health endpoint above does NOT require MongoDB.
  // All routes below will wait for MongoDB.
  //

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

  // ==================================================
  // GOOGLE AUTH
  // ==================================================
  //
  // IMPORTANT:
  // This route is PUBLIC.
  // Google login does not have a JWT yet.
  //

  app.use('/api/auth', authRouter);

  // ==================================================
  // PROTECTED API
  // ==================================================
  //
  // Everything else under /api requires login.
  //

  app.use('/api', requireAuth, runsRouter);

  // ==================================================
  // ERROR HANDLER
  // ==================================================

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);

    res.status(500).json({
      error: err.message || 'internal error',
    });
  });

  return app;
}

// ==================================================
// Create Express app
// ==================================================

const app = createApp();

// Vercel/serverless uses this export
export default app;

// ==================================================
// Local development
// ==================================================

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
