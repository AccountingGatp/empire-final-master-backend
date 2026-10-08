// SOP-ACCT-SALES-001 v1.3 — every account name, class, limit and open-question
// switch used by the journals lives in THIS file. Change a QBO name here and
// every journal, check and download picks it up.
//
// Sub-account names follow QBO's import format:
//   <child number> <parent name>:<child name>

// ---- QBO accounts ------------------------------------------------------------
export const ACCOUNTS = {
  // Xola sales journal (SOP Part A)
  clearing: {
    xola: '10031 Sales Clearing Account:XOlA Sales', // spelled exactly as in QBO ("XOlA")
    gyg: '10032.3 Sales Clearing Account:GYG Sales',
    airbnb: '10032.1 Sales Clearing Account:Airbnb Sales',
    groupon: '10032.2 Sales Clearing Account:Groupon Sales',
    viator: '10032 Sales Clearing Account:Viator Sales', // used when OPTIONS.viatorInXola = true
  },
  processing: '40002.2 Processing Fees - Xola', // open question 6: confirm exact QBO name
  service: '40001.2 Service Fees', // NOT 40001.1 (that is Deferred Revenue)
  gross: '40001 Sales Revenue - Xola', // open question 6: confirm exact QBO name

  // Deferred revenue journal (SOP 10.5)
  deferredDebit: '40001.1 Sales Revenue - Deferred', // open question 6
  deferredCredit: '22001 Deferred Revenue', // open question 6

  // Viator journal (SOP Part B)
  viatorClearing: '10032 Sales Clearing Account:Viator Sales',
  viatorRevenue: '40000.1 Sales:Sales Revenue - Viator',
};

// ---- Source classification (Transactions sheet "Source" column) --------------
// Lower-cased + trimmed Source value -> what to do with the row.
//   group   : the clearing account key above (ACCOUNTS.clearing[group])
//   exclude : 'viator' | 'office' (office only when Payout Date is blank)
export const SOURCES = {
  checkout: { group: 'xola' },
  refund: { group: 'xola' },
  office: { group: 'xola', excludeWhenNoPayoutDate: true },
  'get your guide': { group: 'gyg' },
  airbnb: { group: 'airbnb' },
  groupon: { group: 'groupon' },
  viator: { exclude: 'viator' },

  // ---- Not in the SOP table — decided here (change if the Controller decides otherwise) ----
  // 'review' = left out of the journal and listed on the OFFICE file's "Source review"
  // sheet for the Controller. To post instead, change to e.g. { group: 'xola' }.
  tiqets: { exclude: 'review' },
  '': { exclude: 'review' }, // blank Source
};

// Human labels for the clearing groups (journal descriptions + UI).
export const GROUP_LABELS = {
  xola: 'Xola',
  gyg: 'GetYourGuide',
  airbnb: 'Airbnb',
  groupon: 'Groupon',
  viator: 'Viator',
};

// ---- Companies / classes -----------------------------------------------------
// Matched on the Xola seller name normalised to lower-case letters + digits.
// `currency` is the location's home currency (informational: the row's own
// Currency column decides whether conversion is needed — open question 4).
// `post: false` means "download + verify, but do not post to QBO".
export const COMPANIES = [
  { name: 'Chicago River Boat Architecture Tours', class: 'Empire Tours:Chicago:Chicago Boats', currency: 'USD' },
  { name: 'Chicago Private Boat Tours', class: 'Empire Tours:Chicago', currency: 'USD' },
  { name: 'Chicago Private Tours', class: 'Empire Tours:Chicago', currency: 'USD' },
  { name: 'Chicago Gangsters and Ghosts Tours', class: 'Empire Tours:Chicago', currency: 'USD' },
  { name: 'Chicago Discount Tours', class: 'Empire Tours:Chicago:Chicago Discount', currency: 'USD', optional: 'includeChicagoDiscount' },
  { name: 'See It All Chicago Tours LLC', class: 'Empire Tours:SIA', currency: 'USD' },
  { name: 'Washington DC Sightseeing Tours', class: 'Empire Tours:Washington DC', currency: 'USD' },
  { name: 'London Sightseeing Tours', class: 'Empire Tours:London', currency: 'GBP' },
  { name: 'Amsterdam Tours', class: 'Empire Tours:Amsterdam', currency: 'EUR' },
  { name: 'Paris Tours', class: 'Empire Tours:Paris', currency: 'EUR' },
  { name: 'Italy Tours', class: 'Empire Tours:Milan', currency: 'EUR', aliases: ['Milan Tours'] }, // Xola renamed it
  { name: 'Tours of NYC', class: 'NYC', currency: 'USD' }, // also matches "ToursOfNYC"
  { name: 'NYC Discount Tours', class: 'NYC', currency: 'USD' },
  { name: 'NYC Gangsters and Ghosts Tours', class: 'NYC', currency: 'USD' },
  { name: 'Charleston Tour Company', class: 'Empire Tours:Charleston', currency: 'USD' },
];

// Sellers Xola returns that are NOT in the SOP: never posted, reported as
// "no class – not posted" (open question 2).
export const NO_CLASS_COMPANIES = ['Austin Tours', 'Ohio Cabins', 'Wisconsin Lodges'];

// ---- Open questions (brief §4) — each one is a switch ----------------------
export const OPTIONS = {
  // Q1 Chicago Discount Tours: SOP says leave its entries "exactly as they are".
  //    false = exclude from the journals and report it; true = post with its class.
  includeChicagoDiscount: false,

  // Q2 Austin / Ohio / Wisconsin have no class: never posted (no switch needed,
  //    see NO_CLASS_COMPANIES).

  // Q3 Deferred reversal: SOP 10.5 says never reverse; checklist 10.6 #10 says
  //    "flag to reverse". 'never' = no reversing entry is ever produced.
  deferredReversal: 'never',

  // Q4 Transactions currency: read the row's Currency column; USD rows are not
  //    converted. (Behaviour, not a switch.)

  // Q5 Rows with no Payout Date: no default rate — the user must enter one.
  requireRateForBlankPayoutDate: true,

  // Recognized Earnings Report Details marker (confirmed: "Recognized Earnings Report").
  enforceEarningsMarker: true,

  // The Recognized Earnings report has no Payout Date, so "office booking with a
  // blank Payout Date" can't be seen there. 'byMethod' = office rows paid by card
  // (Method "Electronic") count, others (Method "Other") are left out like unpaid
  // office bookings; or 'include' / 'exclude' every office row. Check against the
  // known Deferred totals (D5) and change if the Controller decides otherwise.
  // Viator (Controller decision, Oct 2026): post Xola's Source = viator rows in
  // the XOLA journal like Groupon / GYG / Airbnb — Dr 10032 Viator Sales clearing
  // (net), fees and gross with the rest. The Viator advice (step 6) is then used
  // to CHECK the clearing, not posted again (no VIA lines, so no double count).
  // false = SOP Part B: leave Viator out of XOLA and post it from the advice.
  viatorInXola: true,

  // FX (Controller decision, Oct 2026): fill every empty rate automatically with
  // the ECB rate for that payout date (frankfurter.dev). Anyone can still open
  // step 3 and type a different rate (e.g. the banked Wise rate or an average).
  autoEcbRates: true,

  recognizedOfficeRule: 'include', // set by the user for Aug 2026 (closest to the known total)
};

// ---- Journal / file names (open question 7) ---------------------------------
// {YYYY} and {MM} are replaced with the run's year and month.
export const NAMES = {
  xola: 'XOLA-{YYYY}-{MM}',
  office: 'OFFICE-{YYYY}-{MM}',
  deferred: 'DEF-{YYYY}-{MM}',
  viator: 'VIA-{YYYY}-{MM}',
  checks: 'CHECKS-{YYYY}-{MM}',
};

// ---- FX (SOP: banked rate from the Wise GBP 10033 / EUR 10036 deposits) -----
// USD per 1 unit of the currency. A rate outside these limits is rejected.
export const FX_LIMITS = {
  GBP: { min: 1.25, max: 1.45, bankAccount: '10033 Wise GBP' },
  EUR: { min: 1.05, max: 1.25, bankAccount: '10036 Wise EUR' },
};

// ---- Report Details markers (file verification) -----------------------------
// Every string listed must appear on the workbook's "Report Details" sheet.
// `forbidden` strings must NOT appear (catches a Payout file saved as Cash Flow).
export const REPORT_MARKERS = {
  account: { label: 'Cash Flow', required: ['Date is between'], forbidden: ['Payout Lag', 'Recognized Earnings'] },
  payout: { label: 'Payout', required: ['From Date', 'To Date', 'Payout Lag'], forbidden: ['Date is between'] },
  // Confirmed from a real export: Report Name "Recognized Earnings Report",
  // filter "Realized Date is between 8/1/26, 8/31/26".
  earnings: { label: 'Recognized Earnings', required: ['Recognized Earnings Report', 'Realized Date is between'], forbidden: ['Payout Lag'] },
};

// ---- Transactions sheet ------------------------------------------------------
export const TRANSACTION_HEADERS = {
  transactionDate: 'Transaction Date',
  arrivalDate: 'Arrival Date',
  customerName: 'Customer Name',
  item: 'Item',
  currency: 'Currency',
  gross: 'Gross',
  processingFee: 'Processing Fee',
  serviceFee: 'Service Fee',
  guestFee: 'Guest Fee',
  net: 'Net',
  source: 'Source',
  method: 'Method',
  payoutDate: 'Payout Date',
  confirmationCode: 'Confirmation Code',
};

// ---- Viator checks (SOP Part B) -----------------------------------------------
export const VIATOR = {
  // Xola Viator-sourced Net vs the advice total: pass within this fraction.
  tolerance: 0.05,
  // An old error grossed Viator up by 35%. If Xola/advice lands in this band,
  // the build hard-stops (cannot be accepted with a reason).
  commissionErrorBand: { min: 0.3, max: 0.4 },
};

// ---- Known answers (used as an extra check on the deferred journal) ----------
// Monthly Deferred total in USD cents.
export const KNOWN_DEFERRED_TOTALS = {
  '2026-01': 8526931, // 85,269.31
  '2026-08': 788666, // 7,886.66
};

// ---- Helpers -------------------------------------------------------------------
export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Current and former names (aliases) both find the company.
const COMPANY_BY_NORM = new Map(
  COMPANIES.flatMap((c) => [c.name, ...(c.aliases || [])].map((n) => [normName(n), c]))
);

// Every name a company is known by in Xola (current + former), normalised.
export function companyNames(sellerName) {
  const c = COMPANY_BY_NORM.get(normName(sellerName));
  return new Set(c ? [c.name, ...(c.aliases || [])].map(normName) : [normName(sellerName)]);
}
const NO_CLASS_NORM = new Set(NO_CLASS_COMPANIES.map(normName));

// Look up a Xola seller name. Returns one of:
//   { status: 'post',     company }            – posted with company.class
//   { status: 'excluded', company, reason }    – known, switched off (Chicago Discount)
//   { status: 'noClass',  reason }             – Austin / Ohio / Wisconsin
//   { status: 'unknown',  reason }             – not in the SOP at all
export function lookupCompany(sellerName, options = OPTIONS) {
  const key = normName(sellerName);
  const company = COMPANY_BY_NORM.get(key);
  if (company) {
    if (company.optional && !options[company.optional]) {
      return {
        status: 'excluded',
        company,
        reason: `${company.name} is excluded from the journals (setting ${company.optional} = false)`,
      };
    }
    return { status: 'post', company };
  }
  if (NO_CLASS_NORM.has(key)) {
    return { status: 'noClass', reason: 'no class – not posted' };
  }
  return { status: 'unknown', reason: 'not in the SOP class table – not posted' };
}

// Distinct expected companies (normalised names), for the missing-company warning.
// `keys` holds the current AND former names (aliases), so a renamed seller
// (Italy Tours -> "Milan Tours" in Xola) is not reported missing.
export function expectedCompanies() {
  return COMPANIES.map((c) => ({
    name: c.name,
    key: normName(c.name),
    keys: new Set([c.name, ...(c.aliases || [])].map(normName)),
  }));
}

// Replace {YYYY}/{MM} in a NAMES pattern.
export function nameFor(kind, month) {
  const [y, m] = String(month).split('-');
  return NAMES[kind].replace('{YYYY}', y).replace('{MM}', m);
}
