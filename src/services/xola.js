import config from '../config.js';

// Consolidated + modified from xola_account.js, xola_payout.js and final.js.
// One module that can create either report type, wait for the async export
// job to finish, and download the resulting workbook.

const { apiKey, base } = config.xola;

const apiHeaders = { 'X-API-KEY': apiKey };

// Browser-like headers used when pulling the generated file from S3.
const downloadHeaders = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exactly the list Xola's Reports › Analytics › Export Transactions sends
// (re-checked in the browser 7 Oct 2026). The separate "Earnings Report" page
// also adds dispute,stripe_paydown — the SOP / Controller use Analytics.
const ACCOUNT_TYPES =
  'purchase,refund,refund_commission,deposit,balance,purchase_affiliate,redeem,plugin_fee';

// ---------------------------------------------------------------------------
// RECOGNIZED EARNINGS EXPORT — CONFIRMED from the browser Network tab
// (Xola › Reports › Recognized Earnings › Export Transactions, 26 Sep 2026):
//   /api/transactions?type[in]=<same list as Cash Flow>&format=xlsx
//     &items.realizedAt[range]=<from>T00:00:00,<to>T23:59:59&seller=<id>
// i.e. the Cash Flow export filtered on the tour date (items.realizedAt)
// instead of the booking date (createdAt). Xola's own page adds the seller's
// time-zone offset (e.g. +02:00); like the Cash Flow export we send the plain
// dates, so both reports use the same day boundaries.
export const EARNINGS_EXPORT = {
  dateRangeParam: 'items.realizedAt[range]',
  extraParams: { 'type[in]': ACCOUNT_TYPES },
};
// ---------------------------------------------------------------------------

// Fetch the list of delegators (sellers) from the Xola API.
async function fetchDelegators(limit = config.delegatorLimit) {
  const res = await fetch(`${base}/delegators?limit=${limit}`, {
    method: 'GET',
    headers: apiHeaders,
  });
  if (!res.ok) {
    throw new Error(`fetchDelegators failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.data || [];
}

// Build the export URL for either report type.
// `from` / `to` are plain dates like '2026-05-01' and '2026-05-31'.
function buildExportUrl(type, from, to, seller) {
  const range = `${from}T00:00:00,${to}T23:59:59`;

  //   label 'account'  -> type[in]=<transaction types>  (Cash Flow: Method/Gross/Fees/Net)
  //   label 'payout'   -> context=payout_report          (settlement: Payout Txn ID/Gross)
  //   label 'earnings' -> Recognized Earnings (see EARNINGS_EXPORT above)
  if (type === 'earnings') {
    const params = new URLSearchParams({ format: 'xlsx', [EARNINGS_EXPORT.dateRangeParam]: range, seller });
    for (const [k, v] of Object.entries(EARNINGS_EXPORT.extraParams)) params.set(k, v);
    return `${base}/transactions?${params.toString()}`;
  }

  const params = new URLSearchParams({
    format: 'xlsx',
    'createdAt[range]': range,
    seller,
  });

  if (type === 'payout') {
    params.set('context', 'payout_report');
  } else {
    params.set('type[in]', ACCOUNT_TYPES);
  }

  return `${base}/transactions?${params.toString()}`;
}

// Create the async export job for a seller + report type.
async function createExport(type, from, to, seller) {
  const url = buildExportUrl(type, from, to, seller);
  const res = await fetch(url, { method: 'GET', headers: apiHeaders });
  if (!res.ok) {
    throw new Error(`export failed: ${res.status} ${res.statusText} ${await res.text()}`);
  }
  return res.json(); // { id, status, url?, ... }
}

// The export is generated asynchronously by Xola and written to a fixed S3 URL.
// The job status stays "new" the whole time, so instead we poll the file URL
// itself with cheap HEAD requests: S3 returns 403 (AccessDenied) while the
// object does not yet exist and 200 once the export has been written.
async function waitForFile(fileUrl, onTick) {
  for (let attempt = 1; attempt <= config.pollMaxAttempts; attempt++) {
    const res = await fetch(fileUrl, { method: 'HEAD', headers: downloadHeaders });
    if (onTick) onTick(attempt, res.status);

    if (res.ok) return true; // 200 -> file is ready

    // 403/404 -> not generated yet; anything else (5xx) -> transient, keep trying.
    await sleep(config.pollIntervalMs);
  }

  throw new Error(
    `export file was not ready after ${config.pollMaxAttempts} attempts ` +
      `(~${Math.round((config.pollMaxAttempts * config.pollIntervalMs) / 1000)}s)`
  );
}

// Download the generated workbook into memory and return the buffer.
async function downloadBuffer(fileUrl) {
  const res = await fetch(fileUrl, { method: 'GET', headers: downloadHeaders });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export { fetchDelegators, buildExportUrl, createExport, waitForFile, downloadBuffer };