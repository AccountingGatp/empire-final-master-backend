import mongoose from 'mongoose';

// The Viator product commission sheet (prices per adult / senior / youth / child,
// listed commission %). One document, replaced whenever a new sheet is uploaded:
// prices are not tied to a month, so every run uses the latest sheet.
const viatorPricesSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'current', unique: true },
    fileName: String,
    uploadedBy: String,
    rows: { type: Array, default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('ViatorPrices', viatorPricesSchema);
