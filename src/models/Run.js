import mongoose from 'mongoose';

// One combined-summary workbook (per report type), built from every seller's
// "Summary" sheet — the web equivalent of process.js.
const summaryPartSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['idle', 'generating', 'ready', 'failed'],
      default: 'idle',
    },
    storageKey: { type: String, default: null }, // B2 object key
    fileName: { type: String, default: null },
    sheetCount: { type: Number, default: 0 }, // sellers combined
    skipped: { type: Number, default: 0 }, // files with no "Summary" sheet
    error: { type: String, default: null },
    generatedAt: { type: Date, default: null },
  },
  { _id: false }
);

// The single final QBO/SaasAnt import workbook (Empire_Xola_JE_<MONTH>_Import).
const importFileSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['idle', 'generating', 'ready', 'failed'],
      default: 'idle',
    },
    storageKey: { type: String, default: null }, // B2 object key
    fileName: { type: String, default: null },
    lineCount: { type: Number, default: 0 },
    totalDebit: { type: Number, default: 0 },
    totalCredit: { type: Number, default: 0 },
    balanced: { type: Boolean, default: false },
    warnings: { type: [String], default: [] },
    error: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    // For the converted import: { EUR: 1.13, GBP: 1.34, ... } (rate to USD).
    rates: { type: Object, default: null },
  },
  { _id: false }
);

// A journal built from the downloads (XOLA / OFFICE / DEF / VIA). Same fields as
// importFileSchema, plus the checks and the blocked|ready gate.
const checkSchema = new mongoose.Schema(
  {
    id: String,
    location: String,
    name: String,
    expected: mongoose.Schema.Types.Mixed,
    actual: mongoose.Schema.Types.Mixed,
    diff: mongoose.Schema.Types.Mixed,
    pass: Boolean,
    unit: String,
    note: String,
    hardStop: Boolean,
  },
  { _id: false }
);

const journalSchema = new mongoose.Schema(
  {
    ...importFileSchema.obj,
    status: {
      type: String,
      enum: ['idle', 'generating', 'ready', 'blocked', 'failed'],
      default: 'idle',
    },
    journalNo: { type: String, default: null },
    journalDate: { type: String, default: null },
    checks: { type: [checkSchema], default: [] },
    // The built lines / per-location figures, kept so later journals and the UI
    // can use them without re-reading every file.
    lines: { type: Array, default: [] },
    locations: { type: Array, default: [] },
    figures: { type: Array, default: [] },
    // DEF only: which reading of SOP 10.5 gives the known total (deferredRules.js).
    ruleTest: { type: mongoose.Schema.Types.Mixed, default: null },
    notPosted: { type: Array, default: [] },
    rowCount: { type: Number, default: 0 },
    builtBy: { type: String, default: null },
    // Set when something it depends on changed (rates, advices, XOLA rebuilt).
    // A stale journal cannot be downloaded until it is built again.
    stale: { type: Boolean, default: false },
    staleReason: { type: String, default: null },
  },
  { _id: false }
);

// One FX rate the user entered (banked rate from the Wise deposit in QBO).
const fxRateSchema = new mongoose.Schema(
  {
    location: String,
    currency: String,
    date: String, // payout / payment date 'YYYY-MM-DD', '' = no date
    label: String,
    rate: { type: Number, default: null }, // USD per 1 unit
    sources: { type: [String], default: [] }, // xola | earnings | viator
    // 'manual' = typed by the user; 'ecb' = the suggested ECB market rate, saved unchanged.
    origin: { type: String, default: null },
    enteredBy: String,
    enteredAt: Date,
  },
  { _id: false }
);

// A failed check someone accepted by typing a reason.
const acceptedDiffSchema = new mongoose.Schema(
  {
    journal: String, // xola | deferred | viator
    checkId: String,
    location: String,
    diff: mongoose.Schema.Types.Mixed,
    unit: String,
    reason: String,
    user: String,
    at: Date,
  },
  { _id: false }
);

// A single "download the month" execution.
const runSchema = new mongoose.Schema(
  {
    month: { type: String, required: true }, // 'YYYY-MM'
    from: { type: String, required: true }, // 'YYYY-MM-DD' (first day)
    to: { type: String, required: true }, // 'YYYY-MM-DD' (last day)

    // High-level step the run is currently on.
    phase: {
      type: String,
      enum: ['created', 'fetching_delegators', 'processing', 'done'],
      default: 'created',
    },
    status: {
      type: String,
      enum: ['running', 'completed', 'completed_with_errors', 'failed'],
      default: 'running',
    },

    totalTasks: { type: Number, default: 0 },
    doneTasks: { type: Number, default: 0 },
    failedTasks: { type: Number, default: 0 },

    sellerCount: { type: Number, default: 0 },
    error: { type: String, default: null },

    // Combined "Summary" workbooks generated on demand after the run.
    summaries: {
      account: { type: summaryPartSchema, default: () => ({}) },
      payout: { type: summaryPartSchema, default: () => ({}) },
    },

    // Who started the run (signed-in email).
    createdBy: { type: String, default: null },

    // FX rates entered for this run, and failed checks accepted with a reason.
    fxRates: { type: [fxRateSchema], default: [] },
    fxScannedAt: { type: Date, default: null },
    acceptedDiffs: { type: [acceptedDiffSchema], default: [] },

    // SOP journals.
    journals: {
      xola: { type: journalSchema, default: () => ({}) },
      office: { type: journalSchema, default: () => ({}) },
      deferred: { type: journalSchema, default: () => ({}) },
      viator: { type: journalSchema, default: () => ({}) },
      checks: { type: journalSchema, default: () => ({}) }, // CHECKS-YYYY-MM.xlsx
    },

    // LEGACY (Summary-based journal + frankfurter USD variant). No longer written
    // or shown; kept so old runs still load. Remove once the SOP journals have
    // been confirmed on live data.
    importFile: { type: importFileSchema, default: () => ({}) },
    importFileUsd: { type: importFileSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default mongoose.model('Run', runSchema);
