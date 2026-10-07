// Backblaze login + upload test. Standalone: it only reads backend/.env.
// Run from the backend folder:   node scripts/b2-test.js
// Paste the output. It never prints your secret key.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '.env');
dotenv.config({ path: envFile });

const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const endpoint = clean(process.env.B2_ENDPOINT).replace(/\/+$/, '');
const bucket = clean(process.env.B2_BUCKET);
const keyId = clean(process.env.B2_KEY_ID);
const appKey = clean(process.env.B2_APP_KEY);
const region = endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1] || clean(process.env.B2_REGION) || 'us-east-005';

console.log('.env file :', envFile);
console.log('node      :', process.version, '·', os.platform());
console.log('endpoint  :', endpoint || '(missing)', '· region', region);
console.log('bucket    :', bucket || '(missing)');
console.log('key id    :', keyId ? `${keyId.slice(0, 6)}… (${keyId.length} chars)` : '(missing)');
console.log('app key   :', appKey ? `${appKey.slice(0, 3)}… (${appKey.length} chars)` : '(missing)');

// Common mix-up: the account ID pasted as the secret key.
if (keyId && appKey && keyId.includes(appKey.slice(0, 10))) {
  console.log('\n!! B2_APP_KEY looks like part of B2_KEY_ID (your account ID), not the secret application key.');
  console.log('   The secret is a separate ~31-character value, usually starting with "K00".\n');
}
if (!endpoint || !bucket || !keyId || !appKey) {
  console.log('\nSome B2_ values are missing in .env — fill them in and run again.');
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId: keyId, secretAccessKey: appKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 1,
});

const key = 'diagnostics/b2-test.txt';
const body = Buffer.from(`Empire B2 test ${new Date().toISOString()}\n`);
try {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length }));
  console.log('upload    : OK');
} catch (err) {
  console.log('upload    : FAIL —', err.name, '·', err.message, `(HTTP ${err.$metadata?.httpStatusCode})`);
}
try {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await res.Body.transformToByteArray();
  console.log('download  : OK');
} catch (err) {
  console.log('download  : FAIL —', err.name, '·', err.message, `(HTTP ${err.$metadata?.httpStatusCode})`);
}
