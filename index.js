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

  // --------------------------------------------------
  // CORS
  // --------------------------------------------------

  const allowedOrigins = [
    'http://localhost:3000',
    'https://empire-final-master-frontend.vercel.app',
  ];

  app.use(
    cors({
      origin: function (origin, callback) {
        // Allow requests without an Origin header
        // (curl, Postman, server-to-server, etc.)
        if (!origin) {
          return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        console.log('[cors] blocked origin:', origin);

        return callback(
          new Error(`CORS blocked for origin: ${origin}`)
        );
      },

      credentials: true,

      methods: [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'OPTIONS',
      ],

      allowedHeaders: [
        'Content-Type',
        'Authorization',
      ],
    })
  );

  // Handle preflight requests
  app.options('*', cors());

  // --------------------------------------------------
  // BODY PARSER
  // --------------------------------------------------

  app.use(express.json({ limit: '10mb' }));

  // --------------------------------------------------
  // HEALTH CHECK
  // --------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      version: 'cors-debug-1',
      authRoute: '/api/auth/google',
    });
  });

  // --------------------------------------------------
  // TEMPORARY DEBUG ROUTE
  // --------------------------------------------------
  // This confirms that Vercel is actually running
  // this version of index.js.

  app.post('/api/debug-google', (req, res) => {
    console.log('[debug-google] request received');
    console.log('[debug-google] body:', req.body);

    res.json({
      ok: true,
      message: 'This is the index.js currently running on Vercel',
      bodyReceived: req.body,
    });
  });

  // --------------------------------------------------
  // DATABASE CONNECTION
  // --------------------------------------------------

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

  // --------------------------------------------------
  // GOOGLE AUTH
  // --------------------------------------------------
  // IMPORTANT:
  // This route is PUBLIC.
  // Do NOT put requireAuth before this router.

  app.use('/api/auth', authRouter);

  // --------------------------------------------------
  // PROTECTED API ROUTES
  // --------------------------------------------------

  app.use('/api', requireAuth, runsRouter);

  // --------------------------------------------------
  // ERROR HANDLER
  // --------------------------------------------------

  app.use((err, _req, res, _next) => {
    console.error('[error]', err);

    res.status(500).json({
      error: err.message || 'internal error',
    });
  });

  return app;
}

// --------------------------------------------------
// CREATE APP
// --------------------------------------------------

const app = createApp();

export default app;

// --------------------------------------------------
// LOCAL DEVELOPMENT SERVER
// --------------------------------------------------

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
