import JSZip from 'jszip';
import Run from '../models/Run.js';
import FileTask from '../models/FileTask.js';
import * as storage from './storage.js';

// Add a buffer into the zip under `folder/name`, uniquifying colliding names.
function addUnique(zip, folder, fileName, buffer, used) {
  const base = fileName || 'file.xlsx';
  let name = base;
  if (used.has(`${folder}/${name}`)) {
    let i = 2;
    const dot = base.lastIndexOf('.');
    const stem = dot >= 0 ? base.slice(0, dot) : base;
    const ext = dot >= 0 ? base.slice(dot) : '';
    do {
      name = `${stem}_${i}${ext}`;
      i++;
    } while (used.has(`${folder}/${name}`));
  }
  used.add(`${folder}/${name}`);
  zip.folder(folder).file(name, buffer);
}

async function tryAddFromKey(zip, folder, fileName, storageKey, used) {
  if (!storageKey) return false;
  try {
    const buf = await storage.getObjectBuffer(storageKey);
    addUnique(zip, folder, fileName, buf, used);
    return true;
  } catch (err) {
    console.warn(`[zip] skip ${folder}/${fileName}:`, err.message);
    return false;
  }
}

// Zip every ready artifact for a run: seller sheets, summaries and the SOP
// journals. Layout:
//   account/<seller>.xlsx        (Cash Flow)
//   payout/<seller>.xlsx
//   earnings/<seller>.xlsx       (Recognized Earnings)
//   viator/<location>/<advice>
//   summaries/summary_account.xlsx, summary_payout.xlsx
//   journals/XOLA-…, OFFICE-…, DEF-…, VIA-…, CHECKS-…   (only ready, up-to-date ones)
async function buildRunZip(runId) {
  const run = await Run.findById(runId);
  if (!run) throw new Error('run not found');

  const tasks = await FileTask.find({
    run: run._id,
    status: 'done',
    storageKey: { $ne: null },
  })
    .sort({ type: 1, sellerName: 1 })
    .lean();

  const zip = new JSZip();
  const used = new Set();
  let fileCount = 0;

  for (const t of tasks) {
    const folder = t.type === 'viator' ? `viator/${t.sellerName}` : t.type;
    const name = t.fileName || `${t.sellerName}.xlsx`;
    if (await tryAddFromKey(zip, folder, name, t.storageKey, used)) fileCount++;
  }

  for (const type of ['account', 'payout']) {
    const part = run.summaries?.[type];
    if (part?.status === 'ready' && part.storageKey) {
      const name = part.fileName || `summary_${type}.xlsx`;
      if (await tryAddFromKey(zip, 'summaries', name, part.storageKey, used)) fileCount++;
    }
  }

  for (const key of ['xola', 'office', 'deferred', 'viator', 'checks']) {
    const j = run.journals?.[key];
    if (j?.status === 'ready' && !j.stale && j.storageKey) {
      if (await tryAddFromKey(zip, 'journals', j.fileName, j.storageKey, used)) fileCount++;
    }
  }

  if (fileCount === 0) {
    throw new Error('no downloaded files to zip for this month');
  }

  const fileName = `empire_${run.month || runId}.zip`;
  const key = `runs/${runId}/${fileName}`;
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await storage.putObject(key, buffer, storage.ZIP_CONTENT_TYPE);

  return { storageKey: key, fileName, fileCount };
}

export { buildRunZip };
