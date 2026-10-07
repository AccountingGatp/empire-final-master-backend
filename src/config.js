import 'dotenv/config';

// Every secret / connection value comes from the environment (.env locally,
// Project Settings › Environment Variables on Vercel). Nothing is hard-coded:
// if a required value is missing the server refuses to start.
const REQUIRED = [
  'MONGODB_URI',
  'XOLA_API_KEY',
  'GOOGLE_CLIENT_ID',
  'JWT_SECRET',
  'B2_ENDPOINT',
  'B2_BUCKET',
  'B2_KEY_ID',
  'B2_APP_KEY',
];

const missing = REQUIRED.filter((name) => !String(process.env[name] || '').trim());
if (missing.length) {
  throw new Error(
    `[config] missing required environment variable(s): ${missing.join(', ')}. ` +
      'Copy backend/.env.example to backend/.env (or set them on Vercel) and fill them in.'
  );
}

// Trim stray spaces / quotes / line breaks that sneak in when pasting keys.
const clean = (name) => String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim();
const B2_ENDPOINT = clean('B2_ENDPOINT').replace(/\/+$/, '');
const regionInEndpoint = B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1];
if (regionInEndpoint && clean('B2_REGION') && clean('B2_REGION') !== regionInEndpoint) {
  console.warn(`[config] B2_REGION "${clean('B2_REGION')}" does not match the endpoint (${regionInEndpoint}) — using ${regionInEndpoint}`);
}

const config = {
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI,

  xola: {
    apiKey: process.env.XOLA_API_KEY,
    base: process.env.XOLA_BASE || 'https://xola.com/api',
  },

  // How many delegators (sellers) to pull from Xola.
  delegatorLimit: Number(process.env.DELEGATOR_LIMIT) || 500,
  // How many sellers to process at once.
  concurrency: Number(process.env.CONCURRENCY) || 4,
  // Job polling.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 3000,
  pollMaxAttempts: Number(process.env.POLL_MAX_ATTEMPTS) || 40,

  // Delay between a seller's export creations. Xola names the S3 file
  // <sellerEmail>_<timestamp-to-second> with NO report-type marker, so two
  // exports created in the same second collide. Each seller now has three
  // exports (account, payout, earnings), so the stagger is 3 s.
  exportStaggerMs: Number(process.env.EXPORT_STAGGER_MS) || 3000,

  // Free ECB market rates, used ONLY to suggest FX rates in step 3 (the user
  // confirms each one against the banked Wise rate before saving).
  frankfurterBase: process.env.FRANKFURTER_BASE || 'https://api.frankfurter.dev/v1',

  // Google sign-in + session auth.
  auth: {
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    jwtSecret: process.env.JWT_SECRET,
    // Only accounts on this domain may sign in.
    allowedDomain: process.env.ALLOWED_EMAIL_DOMAIN || 'gatpsolutions.com',
    sessionTtl: process.env.SESSION_TTL || '7d',
  },

  // Backblaze B2 (S3-compatible) object storage — where workbooks are kept.
  b2: {
    endpoint: B2_ENDPOINT, // e.g. https://s3.us-east-005.backblazeb2.com
    // The region is part of every B2 signature and MUST match the endpoint.
    // It is taken from the endpoint; B2_REGION is only used when the endpoint
    // doesn't name one. (A wrong B2_REGION gives "Signature validation failed".)
    region: B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1] || clean('B2_REGION') || 'us-east-005',
    bucket: clean('B2_BUCKET'),
    keyId: clean('B2_KEY_ID'),
    appKey: clean('B2_APP_KEY'),
    // How long presigned download links stay valid.
    urlExpirySeconds: Number(process.env.B2_URL_EXPIRY) || 600,
  },
};

export default config;
