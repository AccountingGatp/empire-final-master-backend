import mongoose from 'mongoose';

// One workbook to export + download: (seller x report-type).
const fileTaskSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },

    sellerId: { type: String, required: true },
    sellerName: { type: String, required: true },

    // 'account'  -> Cash Flow (transactions export)
    // 'payout'   -> payout_report export
    // 'earnings' -> Recognized Earnings export
    // 'viator'   -> an uploaded Viator payment advice (sellerName = location)
    type: { type: String, enum: ['account', 'payout', 'earnings', 'viator'], required: true },

    // Step-by-step lifecycle of a single file.
    status: {
      type: String,
      enum: [
        'pending', // queued
        'exporting', // creating the export job on Xola
        'polling', // waiting for Xola to generate the file
        'downloading', // pulling the xlsx down
        'done', // saved locally
        'failed', // any step failed (retryable)
      ],
      default: 'pending',
    },

    xolaJobId: { type: String, default: null },
    downloadUrl: { type: String, default: null },

    fileName: { type: String, default: null },
    storageKey: { type: String, default: null }, // B2 object key
    sizeBytes: { type: Number, default: 0 },

    // Result of reading the workbook's "Report Details" sheet after download.
    reportCheck: {
      type: new mongoose.Schema(
        { pass: Boolean, found: String, message: String },
        { _id: false }
      ),
      default: null,
    },

    // Viator advices: what the parser found ({ parser, paymentDate, rowCount,
    // currency, totalCents, warnings, uploadedBy }).
    parsed: { type: Object, default: null },

    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('FileTask', fileTaskSchema);
