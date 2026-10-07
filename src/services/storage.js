import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import http from 'node:http';
import https from 'node:https';
import mongoose from 'mongoose';
import config from '../config.js';

// Backblaze B2 via its S3-compatible API. All run artifacts (per-seller exports,
// combined summaries, and the final import workbook) live here instead of on the
// local (ephemeral) filesystem, so they survive across serverless invocations.

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let client;
function getClient() {
  if (!config.b2.endpoint || !config.b2.bucket) {
    throw new Error(
      'Backblaze B2 is not configured — set B2_ENDPOINT, B2_BUCKET, B2_KEY_ID and B2_APP_KEY'
    );
  }
  if (!client) {
    client = new S3Client({
      endpoint: config.b2.endpoint,
      region: config.b2.region,
      credentials: {
        accessKeyId: config.b2.keyId,
        secretAccessKey: config.b2.appKey,
      },
      // Backblaze's recommended settings for AWS SDK v3.729+: only send / check
      // the new CRC checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // The SDK's own retries (3 attempts) for throttling / 5xx.
      maxAttempts: 3,
      // No keep-alive. On Vercel the client is reused across invocations, and
      // the function is frozen in between; a pooled connection that B2 closed
      // meanwhile gets reused, the upload is cut short, and B2 answers
      // "The request body was too small". A fresh connection per request avoids it.
      requestHandler: {
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({ keepAlive: false }),
      },
    });
  }
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// B2 answers "InvalidRequest: The request body was too small" when fewer bytes
// arrive than Content-Length announced (a dropped / reused connection). It is
// transient — retrying the same upload succeeds — but the SDK does not retry a
// 400 by itself, so we do.
function isTransientUploadError(err) {
  const status = err?.$metadata?.httpStatusCode;
  const text = `${err?.name || ''} ${err?.Code || ''} ${err?.message || ''}`;
  return (
    /request body was too small|IncompleteBody|RequestTimeout|ECONNRESET|EPIPE|socket hang up|ETIMEDOUT/i.test(text) ||
    (typeof status === 'number' && status >= 500)
  );
}

// Plan B: upload through a short-lived presigned PUT link using Node's own
// fetch — a completely different HTTP stack from the SDK, same bucket and keys.
async function putViaPresignedUrl(key, buffer, contentType) {
  const url = await getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: config.b2.bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 }
  );
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buffer });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] || text.slice(0, 200) || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
}

function describe(err) {
  const m = err?.$metadata || {};
  return [err?.name, err?.message, m.httpStatusCode && `HTTP ${m.httpStatusCode}`, m.requestId && `request ${m.requestId}`]
    .filter(Boolean)
    .join(' · ');
}

// Upload a buffer and return its key.
//  1. SDK upload, retried twice on transient errors.
//  2. If B2 still rejects it, the same upload through a presigned link (plan B).
async function putToB2(key, body, contentType = XLSX_CONTENT_TYPE) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: config.b2.bucket,
          Key: key,
          Body: buffer,
          ContentLength: buffer.length,
          ContentType: contentType,
        })
      );
      return key;
    } catch (err) {
      lastErr = err;
      if (!isTransientUploadError(err)) break;
      console.warn(`[b2] upload of ${key} (${buffer.length} bytes) failed: ${describe(err)} — attempt ${i}/3`);
      await sleep(400 * i);
    }
  }

  if (isTransientUploadError(lastErr)) {
    try {
      await putViaPresignedUrl(key, buffer, contentType);
      console.warn(`[b2] upload of ${key} succeeded through the presigned link (plan B)`);
      return key;
    } catch (err) {
      console.error(`[b2] plan B upload of ${key} failed too: ${err.message}`);
      const e = new Error(
        `Could not save ${key.split('/').pop()} (${buffer.length} bytes) to Backblaze B2: ${describe(lastErr)}; ` +
          `presigned upload also failed: ${err.message}`
      );
      e.cause = lastErr;
      throw e;
    }
  }
  const e = new Error(`Could not save ${key.split('/').pop()} to Backblaze B2: ${describe(lastErr)}`);
  e.cause = lastErr;
  throw e;
}

// Download an object into memory.
async function getFromB2(key) {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: config.b2.bucket, Key: key })
  );
  return Buffer.from(await res.Body.transformToByteArray());
}

const ZIP_CONTENT_TYPE = 'application/zip';

// A short-lived presigned URL that downloads the object as `filename`.
async function b2DownloadUrl(key, filename, contentType = XLSX_CONTENT_TYPE) {
  const cmd = new GetObjectCommand({
    Bucket: config.b2.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
    ResponseContentType: contentType,
  });
  return getSignedUrl(getClient(), cmd, {
    expiresIn: config.b2.urlExpirySeconds,
  });
}

// ---- Fallback: keep the file in MongoDB when B2 refuses the upload ----------
// Some networks (antivirus / proxy / VPN inspecting HTTPS) cut uploads to B2
// short, and B2 answers "The request body was too small". Rather than block the
// close, a file B2 won't take is kept in the SAME MongoDB (collection
// `storedfiles`), and everything that reads it — downloads, the zip, later
// journals — finds it there. Only for files under 15 MB (Mongo's limit is 16 MB).
const storedFileSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    contentType: String,
    size: Number,
    data: Buffer,
    reason: String,
  },
  { timestamps: true }
);
const StoredFile = mongoose.models.StoredFile || mongoose.model('StoredFile', storedFileSchema);
const FALLBACK_MAX_BYTES = 15 * 1024 * 1024;

// "Signature validation failed" / 403 = B2 did not accept the key or region.
function isAuthError(err) {
  const text = `${err?.name || ''} ${err?.message || ''}`;
  return /Signature validation failed|SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|not entitled|Unauthorized/i.test(text) ||
    err?.$metadata?.httpStatusCode === 401 || err?.$metadata?.httpStatusCode === 403;
}
function withAuthHint(err) {
  const e = new Error(
    `Backblaze rejected the login (${err.message}). Check B2_KEY_ID, B2_APP_KEY and B2_ENDPOINT in backend/.env — ` +
      `they must be exactly the values from the Vercel backend project (region used: ${config.b2.region}).`
  );
  e.cause = err;
  return e;
}

async function putObject(key, body, contentType = XLSX_CONTENT_TYPE) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  try {
    await putToB2(key, buffer, contentType);
    // A fresh B2 copy wins over an older database copy.
    await StoredFile.deleteOne({ key }).catch(() => {});
    return key;
  } catch (err) {
    if (buffer.length > FALLBACK_MAX_BYTES) throw err;
    if (isAuthError(err)) console.error(withAuthHint(err).message);
    await StoredFile.findOneAndUpdate(
      { key },
      { key, contentType, size: buffer.length, data: buffer, reason: err.message },
      { upsert: true }
    );
    console.warn(`[b2] ${key} kept in MongoDB instead (B2 refused it: ${err.message})`);
    return key;
  }
}

async function getObjectBuffer(key) {
  const stored = await StoredFile.findOne({ key }).lean();
  if (stored?.data) return Buffer.from(stored.data.buffer ?? stored.data);
  try {
    return await getFromB2(key);
  } catch (err) {
    throw isAuthError(err) ? withAuthHint(err) : err;
  }
}

// Download link: presigned B2 URL, or — for a file kept in MongoDB — a data:
// URL the browser saves directly (these files are small).
async function getDownloadUrl(key, filename, contentType = XLSX_CONTENT_TYPE) {
  const stored = await StoredFile.findOne({ key }).lean();
  if (stored?.data) {
    const buf = Buffer.from(stored.data.buffer ?? stored.data);
    return `data:${stored.contentType || contentType};base64,${buf.toString('base64')}`;
  }
  return b2DownloadUrl(key, filename, contentType);
}

export { putObject, getObjectBuffer, getDownloadUrl, XLSX_CONTENT_TYPE, ZIP_CONTENT_TYPE };
