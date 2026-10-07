import Run from '../models/Run.js';
import FileTask from '../models/FileTask.js';
import * as storage from './storage.js';
import * as xola from './xola.js';
import { OPTIONS, nameFor } from '../accounting/settings.js';
import { readWorkbook, parseTransactions, parseSummaryTotals, checkReportDetails } from '../accounting/workbook.js';
import { buildXolaJournal, neededRates } from '../accounting/xolaJournal.js';
import { buildDeferredJournal } from '../accounting/deferredJournal.js';
import { testDeferredRules } from '../accounting/deferredRules.js';
import { buildViatorJournal, neededViatorRates, parseAdvice, homeCurrency } from '../accounting/viator.js';
import { mergeRateTable, rateKey, rateProblem } from '../accounting/fx.js';
import { journalStatus } from '../accounting/checks.js';
import { previousMonth } from '../accounting/money.js';
import { writeJournalXlsx, writeOfficeXlsx, writeChecksXlsx } from '../accounting/output.js';

// Every function here is ONE short request (Vercel-safe): read the run's files
// from B2, compute, write the result to B2 + Mongo, return.

export class UserError extends Error {
  constructor(message, status = 409, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const JOURNAL_KEYS = ['xola', 'deferred', 'viator'];
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

async function getRun(runId) {
  const run = await Run.findById(runId);
  if (!run) throw new UserError('run not found', 404);
  return run;
}

const plainTasks = (runId) => FileTask.find({ run: runId }).lean();

// Read a downloaded export. Normally from Backblaze; if Backblaze refuses (for
// example wrong keys on this computer), fetch the same export again from the
// Xola link it was downloaded from, so the month-end work isn't blocked.
async function readTaskFile(t) {
  try {
    return await storage.getObjectBuffer(t.storageKey);
  } catch (err) {
    if (!t.downloadUrl) throw err;
    try {
      const buf = await xola.downloadBuffer(t.downloadUrl);
      console.warn(`[files] ${t.sellerName} ${t.type}: read from Xola instead (Backblaze: ${err.message.slice(0, 120)})`);
      return buf;
    } catch (xerr) {
      throw new Error(`${err.message} — and the Xola link no longer works either (${xerr.message})`);
    }
  }
}

// Read + parse every done file of a type, a few at a time.
async function parseFiles(tasks, { withSummary = false } = {}) {
  const out = [];
  const queue = [...tasks];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const wb = readWorkbook(await readTaskFile(t));
        let rows;
        try {
          rows = parseTransactions(wb);
        } catch (err) {
          // No Transactions table but a Summary of all zeros = no sales this month.
          const s = (() => {
            try {
              return parseSummaryTotals(wb);
            } catch {
              return null;
            }
          })();
          if (!s || ![s.gross, s.processingFee, s.serviceFee, s.net].every((v) => !v)) throw err;
          rows = [];
        }
        let summary = null;
        if (withSummary) {
          try {
            summary = parseSummaryTotals(wb);
          } catch (err) {
            summary = { error: err.message }; // checks 1–4 fail with this message
          }
        }
        out.push({ sellerName: t.sellerName, rows, summary });
      } catch (err) {
        out.push({ sellerName: t.sellerName, rows: [], summary: null, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

// Files downloaded before the Report Details check existed have no reportCheck,
// and files that failed an earlier version of the check (it misread Xola's
// "8/1/26" dates) may be fine. Check both now, from storage, with the current
// rules — so checks 7 and 14 reflect the real files.
// A file that can't be READ (e.g. a Backblaze login problem) is left exactly as
// it was: that is a storage problem, not a wrong file.
async function verifyUncheckedFiles(run, tasks) {
  const todo = tasks.filter(
    (t) =>
      ['account', 'payout', 'earnings'].includes(t.type) &&
      t.storageKey &&
      ((t.status === 'done' && !t.reportCheck) ||
        (t.status === 'failed' && /^File check failed/.test(t.error || '')))
  );
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      let buf;
      try {
        buf = await readTaskFile(t);
      } catch (err) {
        if (t.status === 'failed' && /could not read the file/.test(t.error || '')) {
          // Undo an earlier version that wrongly failed files it couldn't read.
          Object.assign(t, { status: 'done', error: null, reportCheck: null });
          await FileTask.updateOne({ _id: t._id }, { $set: { status: 'done', error: null, reportCheck: null } });
        }
        continue;
      }
      const check = checkReportDetails(buf, t.type, run.from, run.to, {
        enforceMarker: t.type !== 'earnings' || OPTIONS.enforceEarningsMarker,
        company: t.sellerName,
      });
      const update = check.pass
        ? { reportCheck: check, status: 'done', error: null }
        : { reportCheck: check, status: 'failed', error: `File check failed: ${check.message}` };
      Object.assign(t, update);
      await FileTask.updateOne({ _id: t._id }, { $set: update });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (todo.length) {
    const counts = await Promise.all([
      FileTask.countDocuments({ run: run._id, status: 'done' }),
      FileTask.countDocuments({ run: run._id, status: 'failed' }),
    ]);
    await Run.updateOne({ _id: run._id }, { $set: { doneTasks: counts[0], failedTasks: counts[1] } });
  }
  return todo.length;
}

const doneTasks = (tasks, type) => tasks.filter((t) => t.type === type && t.status === 'done' && t.storageKey);

function advicesFrom(tasks) {
  return tasks
    .filter((t) => t.type === 'viator' && t.status === 'done' && t.parsed)
    .map((t) => ({
      id: String(t._id),
      location: t.sellerName,
      fileName: t.fileName,
      paymentDate: t.parsed.paymentDate || '',
      rows: t.parsed.rows || [],
    }));
}

// ---- FX rate table ------------------------------------------------------------

// Work out which rates the current files need (Xola, earnings, Viator) and merge
// them into run.fxRates, keeping anything already entered.
export async function scanFxRates(runId) {
  const run = await getRun(runId);
  const tasks = await plainTasks(runId);
  const account = await parseFiles(doneTasks(tasks, 'account'));
  const earnings = await parseFiles(doneTasks(tasks, 'earnings'));
  const needed = [
    ...neededRates(account, 'xola'),
    ...neededRates(earnings, 'earnings'),
    ...neededViatorRates(advicesFrom(tasks)),
  ];
  run.fxRates = mergeRateTable(run.fxRates.map((r) => r.toObject?.() || r), needed);
  run.fxScannedAt = new Date();
  await run.save();
  return run;
}

// Add rate rows the files need but the table doesn't have yet (keeps every
// existing row and entered rate). Returns how many were added.
function addMissingRates(run, needed) {
  const have = new Map(run.fxRates.map((r) => [rateKey(r.location, r.currency, r.date), r]));
  let added = 0;
  for (const n of needed) {
    const k = rateKey(n.location, n.currency, n.date);
    const row = have.get(k);
    if (row) {
      if (n.source && !row.sources.includes(n.source)) row.sources.push(n.source);
      continue;
    }
    const fresh = { location: n.location, currency: String(n.currency).toUpperCase(), date: n.date || '', label: n.label || '', rate: null, sources: n.source ? [n.source] : [] };
    run.fxRates.push(fresh);
    have.set(k, fresh);
    added++;
  }
  if (added) {
    run.fxRates.sort((a, b) => a.location.localeCompare(b.location) || a.currency.localeCompare(b.currency) || String(a.date).localeCompare(String(b.date)));
    run.fxScannedAt = new Date();
  }
  run.markModified('fxRates');
  return added;
}

// Save rates typed into the UI. entries = [{ location, currency, date, rate }].
// Out-of-limit rates are rejected with a message per row.
export async function saveFxRates(runId, entries, user) {
  const run = await getRun(runId);
  const problems = [];
  const changedSources = new Set();
  const byKey = new Map((entries || []).map((e) => [rateKey(e.location, e.currency, e.date), e]));
  for (const r of run.fxRates) {
    const e = byKey.get(rateKey(r.location, r.currency, r.date));
    if (!e) continue;
    const blank = e.rate === '' || e.rate === null || e.rate === undefined;
    if (blank) {
      if (r.rate !== null) r.sources.forEach((x) => changedSources.add(x));
      r.rate = null;
      continue;
    }
    const p = rateProblem(r.currency, e.rate);
    if (p) {
      problems.push(`${r.location} · ${r.currency} · ${r.date || 'no date'}: ${p}`);
      continue;
    }
    const origin = e.origin === 'ecb' ? 'ecb' : 'manual';
    if (Number(e.rate) !== r.rate || (r.origin || 'manual') !== origin) {
      r.rate = Number(e.rate);
      r.origin = origin;
      r.enteredBy = user;
      r.enteredAt = new Date();
      r.sources.forEach((x) => changedSources.add(x));
    }
  }
  // Only the journals that use a changed rate go out of date. The deferred
  // journal also depends on XOLA's figures, so an XOLA rate affects it too.
  const affected = new Set();
  if (changedSources.has('xola')) ['xola', 'deferred'].forEach((k) => affected.add(k));
  if (changedSources.has('earnings')) affected.add('deferred');
  if (changedSources.has('viator')) affected.add('viator');
  if (affected.size) markStale(run, [...affected], 'FX rates changed since this was built');
  await run.save();
  if (problems.length) throw new UserError(`Some rates were not saved:\n${problems.join('\n')}`, 422, problems);
  return run;
}

// ---- Journals -------------------------------------------------------------------

// Something a built journal depends on changed: it must be built again before
// it can be downloaded.
function markStale(run, keys, reason) {
  for (const k of keys) {
    const j = run.journals[k];
    if (j && ['ready', 'blocked'].includes(j.status)) {
      j.stale = true;
      j.staleReason = reason;
    }
  }
}

function applyStatus(run, key) {
  const j = run.journals[key];
  if (!j || !['ready', 'blocked'].includes(j.status)) return;
  j.status = journalStatus(j.checks, key, run.acceptedDiffs);
}

async function failJournal(run, key, err) {
  run.journals[key].status = 'failed';
  run.journals[key].error = err.message;
  run.journals[key].generatedAt = new Date();
  await run.save();
  const status = err.code === 'FX_RATES_MISSING' ? 422 : err.code === 'UNKNOWN_SOURCE' ? 422 : 409;
  throw new UserError(err.message, status, err.details);
}

function journalRecord(built, { fileName, storageKey, user, checks, extra = {} }) {
  const lines = built.lines;
  const totalDebit = sum(lines, (l) => l.debit);
  const totalCredit = sum(lines, (l) => l.credit);
  return {
    status: 'ready',
    journalNo: built.journalNo,
    journalDate: built.journalDate,
    fileName,
    storageKey,
    lineCount: lines.length,
    stale: false,
    staleReason: null,
    totalDebit: totalDebit / 100,
    totalCredit: totalCredit / 100,
    balanced: totalDebit === totalCredit,
    warnings: [],
    error: null,
    generatedAt: new Date(),
    checks,
    lines,
    builtBy: user,
    ...extra,
  };
}

// Mark a journal failed straight in the database (works even if the in-memory
// run document is in a bad state), so the page never stays on "Working".
async function markFailed(runId, key, message) {
  await Run.updateOne(
    { _id: runId },
    {
      $set: {
        [`journals.${key}.status`]: 'failed',
        [`journals.${key}.error`]: message,
        [`journals.${key}.generatedAt`]: new Date(),
      },
    }
  ).catch((e) => console.error('[journals] could not record failure', e));
}

// Step 4: XOLA journal + OFFICE list.
// Every stage is named, so an error tells you exactly where it happened.
export async function buildXola(runId, user) {
  const run = await getRun(runId);
  const tasks = await plainTasks(runId);
  await verifyUncheckedFiles(run, tasks);
  const accountTasks = doneTasks(tasks, 'account');
  if (!accountTasks.length) {
    const failed = tasks.filter((t) => t.type === 'account' && t.status === 'failed');
    throw new UserError(
      failed.length
        ? `none of the Cash Flow files can be used — ${failed.length} failed their check (e.g. ${failed[0].sellerName}: ${failed[0].error}). Fix or retry them in step 2.`
        : 'no Cash Flow files yet — wait for the downloads to finish'
    );
  }

  run.journals.xola.status = 'generating';
  run.journals.xola.error = null;
  await run.save();

  let stage = 'reading the Cash Flow files from Backblaze';
  try {
    const sellers = await parseFiles(accountTasks, { withSummary: true });

    // Make sure step 3's rate table lists every rate these files need (it may
    // have been scanned while the files couldn't be read).
    const added = addMissingRates(run, neededRates(sellers, 'xola'));
    if (added) await run.save();

    stage = 'building the journal';
    let built;
    try {
      built = buildXolaJournal({
        month: run.month,
        sellers,
        rates: run.fxRates.map((r) => r.toObject()),
        files: tasks,
        options: OPTIONS,
      });
    } catch (err) {
      return await failJournal(run, 'xola', err); // unknown Source / missing FX rate
    }

    const month = run.month;
    const xolaName = `${nameFor('xola', month)}.xlsx`;
    const officeName = `${nameFor('office', month)}.xlsx`;
    const xolaKey = `runs/${runId}/journals/${xolaName}`;
    const officeKey = `runs/${runId}/journals/${officeName}`;

    stage = 'writing the XOLA / OFFICE workbooks';
    const xolaBuf = await writeJournalXlsx(built.lines);
    const officeBuf = await writeOfficeXlsx(built.office, built.review);

    stage = `saving ${xolaName} to Backblaze`;
    await storage.putObject(xolaKey, xolaBuf);
    stage = `saving ${officeName} to Backblaze`;
    await storage.putObject(officeKey, officeBuf);

    stage = 'saving the result to the database';
    run.journals.xola = journalRecord(built, {
      fileName: xolaName,
      storageKey: xolaKey,
      user,
      checks: built.checks,
      extra: {
        locations: built.locations,
        notPosted: [
          ...built.notPosted,
          ...Object.entries(
            built.review.reduce((m, r) => {
              const k = `${r.location}|${r.source || '(blank)'}`;
              m[k] = m[k] || { n: 0, net: 0 };
              m[k].n++;
              m[k].net += r.net;
              return m;
            }, {})
          ).map(([k, v]) => {
            const [loc, src] = k.split('|');
            return { sellerName: loc, reason: `${v.n} booking(s) with Source "${src}" (Net ${(v.net / 100).toFixed(2)}) left out for review — see the OFFICE file, sheet "Source review"` };
          }),
        ],
        warnings: built.notPosted.map((n) => `${n.sellerName}: ${n.reason}`),
      },
    });
    applyStatus(run, 'xola');
    markStale(run, ['deferred', 'viator'], 'the XOLA journal was rebuilt after this');

    run.journals.office = {
      status: 'ready',
      journalNo: nameFor('office', month),
      fileName: officeName,
      storageKey: officeKey,
      rowCount: built.office.length,
      lineCount: built.office.length,
      generatedAt: new Date(),
      builtBy: user,
      // Office rows are small; keep a preview for the UI.
      lines: built.office.slice(0, 500),
    };
    await run.save();
    return run;
  } catch (err) {
    if (err instanceof UserError) throw err;
    const message = `Failed while ${stage}: ${err.message}`;
    console.error('[xola build]', message, err);
    await markFailed(runId, 'xola', message);
    throw new UserError(message, 500);
  }
}

// Step 5: DEF journal.
export async function buildDeferred(runId, user) {
  const run = await getRun(runId);
  const x = run.journals.xola;
  if (!x || !['ready', 'blocked'].includes(x.status)) throw new UserError('build the XOLA journal first');
  const tasks = await plainTasks(runId);
  await verifyUncheckedFiles(run, tasks);
  const earningTasks = doneTasks(tasks, 'earnings');
  if (!earningTasks.length) throw new UserError('no verified Recognized Earnings files yet');

  run.journals.deferred.status = 'generating';
  await run.save();

  let built;
  let ruleTest = null;
  try {
    const earnings = await parseFiles(earningTasks, { withSummary: true });
    // Months with a known Deferred total (SOP 10.5): try every reading of the
    // rule and report which one gives that total. Never blocks the build.
    try {
      const cashFlow = await parseFiles(doneTasks(tasks, 'account'));
      ruleTest = testDeferredRules({
        month: run.month,
        cashFlow,
        earnings,
        rates: run.fxRates.map((r) => r.toObject()),
        options: OPTIONS,
      });
    } catch (err) {
      console.warn('[deferred] rule test skipped:', err.message);
    }
    built = buildDeferredJournal({
      month: run.month,
      xola: { status: x.status, lines: x.lines, locations: x.locations },
      earnings,
      rates: run.fxRates.map((r) => r.toObject()),
      files: tasks,
      options: OPTIONS,
    });
  } catch (err) {
    return failJournal(run, 'deferred', err);
  }

  const fileName = `${nameFor('deferred', run.month)}.xlsx`;
  const key = `runs/${runId}/journals/${fileName}`;
  try {
    await storage.putObject(key, await writeJournalXlsx(built.lines));
  } catch (err) {
    return failJournal(run, 'deferred', err);
  }
  run.journals.deferred = journalRecord(built, {
    fileName,
    storageKey: key,
    user,
    checks: built.checks,
    extra: { figures: built.figures, rowCount: built.figures.length, ruleTest },
  });
  applyStatus(run, 'deferred');
  await run.save();
  return run;
}

// Step 6: VIA journal.
export async function buildViator(runId, user) {
  const run = await getRun(runId);
  const tasks = await plainTasks(runId);
  const advices = advicesFrom(tasks);
  if (!advices.length) throw new UserError('upload at least one Viator payment advice first');

  // Last month's advices, for "every entity that had an advice last month has one".
  const prevMonth = previousMonth(run.month);
  const prevRuns = await Run.find({ month: prevMonth }).select('_id').lean();
  const prevAdvices = prevRuns.length
    ? await FileTask.find({ run: { $in: prevRuns.map((r) => r._id) }, type: 'viator', status: 'done' }).lean()
    : [];
  const previous = {
    hadRun: prevAdvices.length > 0,
    locations: [...new Set(prevAdvices.map((t) => t.sellerName))],
  };

  run.journals.viator.status = 'generating';
  await run.save();

  let built;
  try {
    const x = run.journals.xola;
    built = buildViatorJournal({
      month: run.month,
      advices,
      rates: run.fxRates.map((r) => r.toObject()),
      xola: x && ['ready', 'blocked'].includes(x.status) ? { locations: x.locations } : null,
      previous,
      options: OPTIONS,
    });
  } catch (err) {
    return failJournal(run, 'viator', err);
  }

  const fileName = `${nameFor('viator', run.month)}.xlsx`;
  const key = `runs/${runId}/journals/${fileName}`;
  try {
    await storage.putObject(key, await writeJournalXlsx(built.lines));
  } catch (err) {
    return failJournal(run, 'viator', err);
  }
  run.journals.viator = journalRecord(built, {
    fileName,
    storageKey: key,
    user,
    checks: built.checks,
    extra: { figures: built.figures, rowCount: advices.reduce((s, a) => s + a.rows.length, 0) },
  });
  applyStatus(run, 'viator');
  await run.save();
  return run;
}

// Accept one failed check by typing a reason.
export async function acceptCheck(runId, { journal, checkId, location, reason }, user) {
  if (!JOURNAL_KEYS.includes(journal)) throw new UserError('unknown journal', 400);
  if (!String(reason || '').trim() || String(reason).trim().length < 5) {
    throw new UserError('type a reason (at least 5 characters) to accept a failed check', 400);
  }
  const run = await getRun(runId);
  const check = (run.journals[journal]?.checks || []).find((c) => c.id === checkId && c.location === location);
  if (!check) throw new UserError('check not found — rebuild the journal and try again', 404);
  if (check.pass) throw new UserError('this check already passes', 409);
  if (check.hardStop) throw new UserError(`this is a hard stop and cannot be accepted: ${check.note || check.name}`, 409);

  run.acceptedDiffs.push({
    journal,
    checkId,
    location,
    diff: check.diff,
    unit: check.unit,
    reason: String(reason).trim(),
    user,
    at: new Date(),
  });
  applyStatus(run, journal);
  await run.save();
  return run;
}

// Step 7: CHECKS-YYYY-MM.xlsx with every check, the run date, the user and the FX rates.
export async function buildChecksFile(runId, user) {
  const run = await getRun(runId);
  const built = JOURNAL_KEYS.filter((k) => ['ready', 'blocked'].includes(run.journals[k]?.status));
  if (!built.length) throw new UserError('build at least one journal first');

  const buffer = await writeChecksXlsx({
    month: run.month,
    runDate: run.createdAt,
    user,
    journals: Object.fromEntries(JOURNAL_KEYS.map((k) => [k, run.journals[k]?.status === 'idle' ? null : run.journals[k]])),
    fxRates: run.fxRates.map((r) => r.toObject()),
    acceptedDiffs: run.acceptedDiffs.map((a) => a.toObject()),
  });
  const fileName = `${nameFor('checks', run.month)}.xlsx`;
  const key = `runs/${runId}/journals/${fileName}`;
  await storage.putObject(key, buffer);
  run.journals.checks = {
    status: 'ready',
    journalNo: nameFor('checks', run.month),
    fileName,
    storageKey: key,
    generatedAt: new Date(),
    builtBy: user,
  };
  await run.save();
  return run;
}

// ---- Viator uploads ----------------------------------------------------------------

const safe = (s) => String(s || 'file').replace(/[\\/?*[\]:<>|"]/g, '_').replace(/\s+/g, '_').slice(0, 120);

export async function uploadViatorAdvice(runId, { location, fileName, buffer }, user) {
  const run = await getRun(runId);
  if (!location) throw new UserError('pick the location this advice belongs to', 400);
  if (!buffer?.length) throw new UserError('the uploaded file is empty', 400);

  let parsed;
  try {
    parsed = parseAdvice(buffer, fileName, { defaultCurrency: homeCurrency(location), defaultEntity: location });
  } catch (err) {
    throw new UserError(`Could not read ${fileName}: ${err.message}`, 422);
  }

  const key = `runs/${run._id}/viator/${safe(location)}/${Date.now()}_${safe(fileName)}`;
  const type = /\.csv$/i.test(fileName) ? 'text/csv' : storage.XLSX_CONTENT_TYPE;
  await storage.putObject(key, buffer, type);

  const currencies = [...new Set(parsed.rows.map((r) => r.currency))];
  const task = await FileTask.create({
    run: run._id,
    sellerId: `viator:${location}`,
    sellerName: location,
    type: 'viator',
    status: 'done',
    fileName,
    storageKey: key,
    sizeBytes: buffer.length,
    attempts: 1,
    parsed: {
      parser: parsed.parser,
      paymentDate: parsed.paymentDate,
      rowCount: parsed.rows.length,
      currency: currencies.join('/'),
      totalCents: sum(parsed.rows, (r) => r.netCents),
      warnings: parsed.warnings,
      uploadedBy: user,
      rows: parsed.rows,
    },
  });
  // Uploading changes what the Viator journal would contain.
  markStale(run, ['viator'], 'advices changed since this was built');
  await run.save();
  return task;
}

export async function deleteViatorAdvice(runId, taskId) {
  const task = await FileTask.findOne({ _id: taskId, run: runId, type: 'viator' });
  if (!task) throw new UserError('advice not found', 404);
  await task.deleteOne();
  const run = await getRun(runId);
  markStale(run, ['viator'], 'advices changed since this was built');
  await run.save();
}
