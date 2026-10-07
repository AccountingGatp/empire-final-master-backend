import express from 'express';
import Run from '../models/Run.js';
import FileTask from '../models/FileTask.js';
import * as processor from '../services/processor.js';
import * as summary from '../services/summary.js';
import * as journals from '../services/journals.js';
import { suggestRates } from '../services/fxRates.js';
import * as zipFiles from '../services/zipFiles.js';
import * as storage from '../services/storage.js';
import {
  expectedCompanies,
  lookupCompany,
  normName,
  COMPANIES,
  FX_LIMITS,
  OPTIONS,
  NAMES,
} from '../accounting/settings.js';
import { AUTO_FETCH_AVAILABLE } from '../accounting/viator.js';

const router = express.Router();

// Compute first/last calendar day for a 'YYYY-MM' month.
function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]); // 1-12
  if (mon < 1 || mon > 12) return null;
  const lastDay = new Date(year, mon, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(mon)}-01`,
    to: `${year}-${pad(mon)}-${pad(lastDay)}`,
  };
}

// Shape a run + its tasks for the frontend.
async function serializeRun(run) {
  const tasks = await FileTask.find({ run: run._id }).sort({ sellerName: 1, type: 1 }).lean();
  const shape = (t) => ({
    id: String(t._id),
    sellerId: t.sellerId,
    sellerName: t.sellerName,
    type: t.type,
    status: t.status,
    fileName: t.fileName,
    sizeBytes: t.sizeBytes,
    attempts: t.attempts,
    error: t.error,
    reportCheck: t.reportCheck || null,
    parsed: t.parsed ? { ...t.parsed, rows: undefined } : null,
    updatedAt: t.updatedAt,
  });
  const shapeSummary = (s) => ({
    status: s?.status || 'idle',
    fileName: s?.fileName || null,
    sheetCount: s?.sheetCount || 0,
    skipped: s?.skipped || 0,
    error: s?.error || null,
    generatedAt: s?.generatedAt || null,
  });

  return {
    id: String(run._id),
    month: run.month,
    from: run.from,
    to: run.to,
    phase: run.phase,
    status: run.status,
    totalTasks: run.totalTasks,
    doneTasks: run.doneTasks,
    failedTasks: run.failedTasks,
    sellerCount: run.sellerCount,
    error: run.error,
    createdAt: run.createdAt,
    createdBy: run.createdBy || null,
    account: tasks.filter((t) => t.type === 'account').map(shape),
    payout: tasks.filter((t) => t.type === 'payout').map(shape),
    earnings: tasks.filter((t) => t.type === 'earnings').map(shape),
    viator: tasks.filter((t) => t.type === 'viator').map(shape),
    companies: companyReport(run, tasks),
    summaries: {
      account: shapeSummary(run.summaries?.account),
      payout: shapeSummary(run.summaries?.payout),
    },
    fxRates: (run.fxRates || []).map((r) => ({
      location: r.location,
      currency: r.currency,
      date: r.date || '',
      label: r.label || '',
      rate: r.rate ?? null,
      origin: r.origin || null,
      sources: r.sources || [],
      enteredBy: r.enteredBy || null,
      enteredAt: r.enteredAt || null,
    })),
    fxScannedAt: run.fxScannedAt || null,
    acceptedDiffs: (run.acceptedDiffs || []).map((a) => ({
      journal: a.journal,
      checkId: a.checkId,
      location: a.location,
      diff: a.diff,
      unit: a.unit,
      reason: a.reason,
      user: a.user,
      at: a.at,
    })),
    journals: {
      xola: shapeJournal(run.journals?.xola),
      office: shapeJournal(run.journals?.office),
      deferred: shapeJournal(run.journals?.deferred),
      viator: shapeJournal(run.journals?.viator),
      checks: shapeJournal(run.journals?.checks),
    },
  };
}

// Expected companies with no file in this run, and sellers not in the SOP.
function companyReport(run, tasks) {
  if (run.phase === 'created' || run.phase === 'fetching_delegators') {
    return { missing: [], notPosted: [] };
  }
  const sellers = [...new Set(tasks.filter((t) => t.type !== 'viator').map((t) => t.sellerName))];
  const have = new Set(sellers.map(normName));
  const missing = expectedCompanies()
    .filter((c) => !have.has(c.key))
    .map((c) => c.name);
  const notPosted = sellers
    .map((name) => ({ name, ...lookupCompany(name, OPTIONS) }))
    .filter((x) => x.status !== 'post')
    .map((x) => ({ name: x.name, reason: x.reason }));
  return { missing, notPosted };
}

function shapeJournal(j) {
  const plain = j?.toObject ? j.toObject() : j || {};
  return {
    status: plain.status || 'idle',
    journalNo: plain.journalNo || null,
    journalDate: plain.journalDate || null,
    fileName: plain.fileName || null,
    lineCount: plain.lineCount || 0,
    rowCount: plain.rowCount || 0,
    totalDebit: plain.totalDebit || 0,
    totalCredit: plain.totalCredit || 0,
    balanced: !!plain.balanced,
    warnings: plain.warnings || [],
    error: plain.error || null,
    generatedAt: plain.generatedAt || null,
    builtBy: plain.builtBy || null,
    stale: !!plain.stale,
    staleReason: plain.staleReason || null,
    checks: plain.checks || [],
    lines: plain.lines || [],
    locations: plain.locations || [],
    figures: plain.figures || [],
    ruleTest: plain.ruleTest || null,
    notPosted: plain.notPosted || [],
  };
}

// Send a stored file: JSON { url, fileName } for the app (it carries the
// Bearer token), or a redirect for a plain link.
async function sendFile(req, res, key, fileName, contentType) {
  const url = await storage.getDownloadUrl(key, fileName, contentType);
  const wantJson =
    req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  if (wantJson) return res.json({ url, fileName });
  res.redirect(url);
}

// Wrap an async handler so UserError -> its status + message.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof journals.UserError) {
      return res.status(err.status).json({ error: err.message, details: err.details || null });
    }
    console.error('[runs]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
};

const userOf = (req) => req.user?.email || 'unknown';

// POST /api/runs  { month: 'YYYY-MM' }  -> start a new download run.
router.post('/runs', async (req, res) => {
  const { month } = req.body || {};
  const range = monthRange(month);
  if (!range) {
    return res.status(400).json({ error: "Invalid 'month'. Expected 'YYYY-MM'." });
  }

  const run = await Run.create({ month, from: range.from, to: range.to, createdBy: userOf(req) });

  // Kick off processing in the background; the client polls for progress.
  processor.processRun(run._id).catch((err) => console.error('[run] fatal', err));

  res.status(201).json(await serializeRun(run));
});

// GET /api/runs -> recent runs (summary only).
router.get('/runs', async (_req, res) => {
  const runs = await Run.find().sort({ createdAt: -1 }).limit(20).lean();
  res.json(
    runs.map((r) => ({
      id: String(r._id),
      month: r.month,
      from: r.from,
      to: r.to,
      phase: r.phase,
      status: r.status,
      totalTasks: r.totalTasks,
      doneTasks: r.doneTasks,
      failedTasks: r.failedTasks,
      createdAt: r.createdAt,
    }))
  );
});

// GET /api/runs/latest?month=YYYY-MM -> the most recent run for that month
// (full, with tasks), or { run: null } if none. Lets the UI show an existing
// month's files instead of regenerating them.
router.get('/runs/latest', async (req, res) => {
  const month = req.query.month;
  const base = month ? { month } : {};
  // Prefer the most recent FINISHED run (it actually has the files) over a
  // newer run that is still processing or got stuck mid-run.
  let run = await Run.findOne({
    ...base,
    status: { $in: ['completed', 'completed_with_errors'] },
  }).sort({ createdAt: -1 });
  if (!run) run = await Run.findOne(base).sort({ createdAt: -1 });
  if (!run) return res.json({ run: null });
  res.json({ run: await serializeRun(run) });
});

// GET /api/runs/:id -> run + tasks (frontend polls this).
router.get('/runs/:id', async (req, res) => {
  const run = await Run.findById(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(await serializeRun(run));
});

// POST /api/runs/:id/add-report { type: 'earnings' } -> download one missing
// report type for every seller of an existing run (keeps rates, acceptances…).
router.post('/runs/:id/add-report', async (req, res) => {
  try {
    const type = String(req.body?.type || 'earnings');
    const result = await processor.addReportType(req.params.id, type);
    res.status(202).json({ ...result, run: await serializeRun(await Run.findById(req.params.id)) });
  } catch (err) {
    res.status(/not found|unknown/.test(err.message) ? 400 : 500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/retry -> redownload a single file.
router.post('/tasks/:id/retry', async (req, res) => {
  try {
    const task = await processor.retryTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json({
      id: String(task._id),
      status: task.status,
      error: task.error,
      attempts: task.attempts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/runs/:id/summary -> combine every seller's "Summary" sheet into
// summary_account.xlsx + summary_payout.xlsx (runs in the background).
router.post('/runs/:id/summary', async (req, res) => {
  const run = await Run.findById(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const doneCount = await FileTask.countDocuments({ run: run._id, status: 'done' });
  if (doneCount === 0) {
    return res.status(409).json({ error: 'no downloaded files to summarize yet' });
  }

  summary
    .generateRunSummaries(run._id)
    .catch((err) => console.error('[summary] fatal', err));

  res.status(202).json(await serializeRun(await Run.findById(run._id)));
});

// GET /api/runs/:id/summary/:type/file -> download a generated summary workbook.
router.get('/runs/:id/summary/:type/file', async (req, res) => {
  const { id, type } = req.params;
  if (!['account', 'payout'].includes(type)) {
    return res.status(400).json({ error: 'type must be account or payout' });
  }
  const run = await Run.findById(id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const part = run.summaries?.[type];
  if (!part || part.status !== 'ready' || !part.storageKey) {
    return res.status(409).json({ error: 'summary not ready' });
  }
  await sendFile(req, res, part.storageKey, part.fileName || `summary_${type}.xlsx`);
});

// GET /api/tasks/:id/file -> redirect to a presigned B2 URL for the workbook.
router.get('/tasks/:id/file', async (req, res) => {
  const task = await FileTask.findById(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status !== 'done' || !task.storageKey) {
    return res.status(409).json({ error: 'file not ready' });
  }
  const type = task.type === 'viator' && /\.csv$/i.test(task.fileName || '') ? 'text/csv' : undefined;
  await sendFile(req, res, task.storageKey, task.fileName || 'export.xlsx', type);
});

// GET /api/runs/:id/files/zip -> zip every ready file for the run's month.
// Prefer ?json=1 or Accept: application/json for a { url } response (loading UI);
// otherwise redirect to the presigned download.
router.get('/runs/:id/files/zip', async (req, res) => {
  const run = await Run.findById(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  try {
    const { storageKey, fileName } = await zipFiles.buildRunZip(run._id);
    const url = await storage.getDownloadUrl(storageKey, fileName, storage.ZIP_CONTENT_TYPE);
    const wantJson =
      req.query.json === '1' ||
      (req.headers.accept || '').includes('application/json');
    if (wantJson) return res.json({ url, fileName });
    res.redirect(url);
  } catch (err) {
    const status = /no downloaded|run not found/.test(err.message) ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ---- SOP journals (each call is short: Vercel-safe) ---------------------------

// GET /api/settings -> the parts of accounting/settings.js the UI shows.
router.get('/settings', (_req, res) => {
  res.json({
    companies: COMPANIES.map((c) => ({ name: c.name, class: c.class, currency: c.currency, optional: c.optional || null })),
    fxLimits: FX_LIMITS,
    options: OPTIONS,
    names: NAMES,
    viatorAutoFetch: AUTO_FETCH_AVAILABLE,
  });
});

// POST /api/runs/:id/fx/scan -> work out which FX rates the files need.
router.post(
  '/runs/:id/fx/scan',
  handle(async (req, res) => {
    const run = await journals.scanFxRates(req.params.id);
    res.json(await serializeRun(run));
  })
);

// POST /api/runs/:id/fx/suggest -> ECB market rates for every row (NOT saved).
router.post(
  '/runs/:id/fx/suggest',
  handle(async (req, res) => {
    const run = await Run.findById(req.params.id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(await suggestRates(run));
  })
);

// PUT /api/runs/:id/fx  { rates: [{ location, currency, date, rate, origin }] }
router.put(
  '/runs/:id/fx',
  handle(async (req, res) => {
    const run = await journals.saveFxRates(req.params.id, req.body?.rates || [], userOf(req));
    res.json(await serializeRun(run));
  })
);

const BUILDERS = {
  xola: journals.buildXola,
  deferred: journals.buildDeferred,
  viator: journals.buildViator,
};

// POST /api/runs/:id/journals/:key/build   (key = xola | deferred | viator)
router.post(
  '/runs/:id/journals/:key/build',
  handle(async (req, res) => {
    const build = BUILDERS[req.params.key];
    if (!build) return res.status(400).json({ error: 'journal must be xola, deferred or viator' });
    const run = await build(req.params.id, userOf(req));
    res.json(await serializeRun(run));
  })
);

// POST /api/runs/:id/journals/:key/accept  { checkId, location, reason }
router.post(
  '/runs/:id/journals/:key/accept',
  handle(async (req, res) => {
    const { checkId, location, reason } = req.body || {};
    const run = await journals.acceptCheck(
      req.params.id,
      { journal: req.params.key, checkId, location, reason },
      userOf(req)
    );
    res.json(await serializeRun(run));
  })
);

// POST /api/runs/:id/checks-file -> CHECKS-YYYY-MM.xlsx
router.post(
  '/runs/:id/checks-file',
  handle(async (req, res) => {
    const run = await journals.buildChecksFile(req.params.id, userOf(req));
    res.json(await serializeRun(run));
  })
);

// GET /api/runs/:id/journals/:key/file   (xola | office | deferred | viator | checks)
// A journal downloads only when it is ready (every check passed or accepted)
// and not out of date.
router.get(
  '/runs/:id/journals/:key/file',
  handle(async (req, res) => {
    const { id, key } = req.params;
    if (!['xola', 'office', 'deferred', 'viator', 'checks'].includes(key)) {
      return res.status(400).json({ error: 'unknown journal' });
    }
    const run = await Run.findById(id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    const j = run.journals?.[key];
    if (!j?.storageKey) return res.status(409).json({ error: 'not built yet' });
    if (j.status === 'blocked') {
      return res.status(409).json({ error: 'blocked — a check failed; accept it with a reason or fix the data' });
    }
    if (j.status !== 'ready') return res.status(409).json({ error: `not ready (${j.status})` });
    if (j.stale) return res.status(409).json({ error: `out of date — ${j.staleReason}; build it again` });
    await sendFile(req, res, j.storageKey, j.fileName);
  })
);

// POST /api/runs/:id/viator?location=<company>&fileName=<name>
// Body: the raw advice file (Content-Type: application/octet-stream).
router.post(
  '/runs/:id/viator',
  express.raw({ type: () => true, limit: '4mb' }),
  handle(async (req, res) => {
    const location = String(req.query.location || '');
    const fileName = String(req.query.fileName || 'advice.csv');
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await journals.uploadViatorAdvice(req.params.id, { location, fileName, buffer }, userOf(req));
    res.status(201).json(await serializeRun(await Run.findById(req.params.id)));
  })
);

// DELETE /api/runs/:id/viator/:taskId -> remove an uploaded advice.
router.delete(
  '/runs/:id/viator/:taskId',
  handle(async (req, res) => {
    await journals.deleteViatorAdvice(req.params.id, req.params.taskId);
    res.json(await serializeRun(await Run.findById(req.params.id)));
  })
);

export default router;
