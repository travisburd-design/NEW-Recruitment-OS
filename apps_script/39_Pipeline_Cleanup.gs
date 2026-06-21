/**
 * 39_Pipeline_Cleanup.gs
 * Frank's European Service — Recruiting OS
 *
 * Keeps the Interview Pipeline tab CLEAN. The pipeline is the hiring manager's
 * working surface — it should only ever show:
 *   • new candidates that need the manager's decision (Manager Decision dropdown)
 *   • candidates currently being evaluated / in process
 *
 * Once a candidate is closed out — Rejected, Archived, or Put in the Drawer —
 * their row is moved OFF the Interview Pipeline and into the "Pipeline Archive"
 * tab (a holding tab that preserves the full row plus when/why it was archived).
 * Their record in "All Candidates" is never touched, so nothing is ever lost.
 *
 * Safety: a freshly Rejected / Drawered candidate has a CANCELLABLE decline /
 * hold email queued, and the manager can still "Reopen Candidate" from the
 * dropdown during that window. So by default (PIPELINE_SWEEP_RESPECT_CANCELLABLE)
 * those two statuses are left on the pipeline until their cancellable email has
 * actually gone out — then the next sweep moves them. ARCHIVED candidates are
 * terminal with no email, so they are swept immediately.
 *
 * Runs automatically inside autoMaintenance() (daily) and on demand from the menu.
 *
 * Public functions:
 *   previewPipelineSweep()              — dry run; moves nothing, logs the plan
 *   sweepInterviewPipeline(opts)        — move closed candidates to Pipeline Archive
 *   restorePipelineCandidate(cid)       — move one candidate back to the pipeline
 *   restoreSelectedArchivedCandidate()  — menu: restore the selected archive row
 *   PIPELINE_CLEANUP_selfTest()
 */

// Statuses that mean "closed out — get off the active pipeline".
// NOTE: returned from a function (not a top-level `var [STATUS.X]`) because
// Apps Script does not guarantee the initialization order of global statements
// across files — STATUS (00_Config.gs) may be undefined when this file's
// globals evaluate. Reading it lazily inside a call is always safe.
function _pipelineSweepStatuses_() {
  return [STATUS.REJECTED, STATUS.ARCHIVED, STATUS.IN_DRAWER];
}

// Extra columns the archive carries on top of the full pipeline row.
var PIPELINE_ARCHIVE_EXTRA_COLS = ['Archived At', 'Archived Status', 'Archived From'];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: PREVIEW + EXECUTE
// ─────────────────────────────────────────────────────────────────────────────

/** Dry run: show what sweepInterviewPipeline() would move. Changes nothing. */
function previewPipelineSweep() {
  return safeRun_('previewPipelineSweep', function () {
    var r = _sweepInterviewPipeline_({ dryRun: true });
    Logger.log(r.report);
    toast_('Preview: would move ' + r.moved + ' closed candidate(s) to "' +
           SHEETS.PIPELINE_ARCHIVE + '". See log.', 'Recruiting OS', 8);
    return r.report;
  });
}

/**
 * Move every closed-out candidate (Rejected / Archived / In Drawer) off the
 * Interview Pipeline and into the Pipeline Archive tab. Idempotent and safe to
 * re-run. Pass { silent:true } to suppress the toast (used by autoMaintenance).
 * Returns a one-line summary string.
 */
function sweepInterviewPipeline(opts) {
  opts = opts || {};
  return safeRun_('sweepInterviewPipeline', function () {
    var r = _sweepInterviewPipeline_({ dryRun: false });
    Logger.log(r.report);
    if (!opts.silent) {
      toast_('Pipeline cleanup — moved ' + r.moved + ' closed candidate(s) to "' +
             SHEETS.PIPELINE_ARCHIVE + '"', 'Recruiting OS', 8);
    }
    return r.summary;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────

function _sweepInterviewPipeline_(opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;

  if (!CFG.getBool('PIPELINE_SWEEP_ENABLED', true)) {
    return { moved: 0, summary: 'disabled', report: '[SWEEP] disabled (PIPELINE_SWEEP_ENABLED=FALSE)' };
  }

  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return { moved: 0, summary: 'pipeline missing', report: '[SWEEP] Interview Pipeline sheet missing' };

  var last = ip.getLastRow();
  if (last < 2) return { moved: 0, summary: '0 moved', report: '[SWEEP] pipeline empty — nothing to clean up' };

  var headers = getHeaderRow_(ip);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  if (H['Status'] === undefined || H['Candidate ID'] === undefined) {
    return { moved: 0, summary: 'bad schema', report: '[SWEEP] pipeline is missing Status / Candidate ID columns' };
  }

  var data = ip.getRange(2, 1, last - 1, headers.length).getValues();

  var sweepStatuses = _pipelineSweepStatuses_();
  var sweepSet = {}; sweepStatuses.forEach(function (s) { sweepSet[s] = true; });
  var respectCancel = CFG.getBool('PIPELINE_SWEEP_RESPECT_CANCELLABLE', true);
  var pending = respectCancel ? _candidatesWithPendingCancellableEmail_() : {};

  var targets = [], counts = {}, heldForCancel = 0;
  for (var i = 0; i < data.length; i++) {
    var status = String(data[i][H['Status']] || '').trim().toUpperCase();
    if (!sweepSet[status]) continue;
    var cid = String(data[i][H['Candidate ID']] || '').trim();

    // Leave a just-rejected / just-drawered candidate on the pipeline (so the
    // "Reopen Candidate" dropdown still reaches them) until their cancellable
    // email has gone out. ARCHIVED is terminal & emailless — always sweep.
    if (status !== STATUS.ARCHIVED && cid && pending[cid]) { heldForCancel++; continue; }

    var obj = {};
    headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = data[i][j]; });
    targets.push({ rowNum: i + 2, cid: cid, status: status, obj: obj, name: _sweepDisplayName_(obj), role: String(obj['Role'] || '') });
    counts[status] = (counts[status] || 0) + 1;
  }

  var report = [
    '[SWEEP] ' + (dryRun ? 'PREVIEW' : 'EXECUTE') + ' — Interview Pipeline cleanup',
    '  candidates to move : ' + targets.length +
      '  (' + sweepStatuses.map(function (s) { return s + '=' + (counts[s] || 0); }).join(', ') + ')',
    '  held (cancellable email still pending) : ' + heldForCancel
  ];

  if (!targets.length) {
    report.push('  ─ pipeline already clean — nothing to move.');
    return { moved: 0, summary: '0 moved (' + heldForCancel + ' held)', report: report.join('\n') };
  }

  report.push('  ─ targets:');
  targets.forEach(function (t) {
    report.push('     ' + t.status.padEnd(10, ' ') + '  ' + String(t.role).padEnd(26, ' ') + '  ' +
                (t.name || '(no name)') + '  (' + (t.cid || 'no id') + ')');
  });

  if (dryRun) {
    report.push('');
    report.push('  Dry run — nothing moved. Run sweepInterviewPipeline() to execute.');
    return { moved: targets.length, summary: targets.length + ' would move', report: report.join('\n') };
  }

  // ── Execute (locked so it never races the dedup / purge passes) ────────────
  var execMoved = withLockOrSkip_('sweepInterviewPipeline', function () {
    var archHeaders = headers.concat(PIPELINE_ARCHIVE_EXTRA_COLS.filter(function (e) {
      return headers.indexOf(e) === -1;
    }));
    var arch = getOrCreateSheet_(SHEETS.PIPELINE_ARCHIVE, archHeaders);
    ensureHeaders_(arch, archHeaders);   // keep archive schema in lock-step with the live pipeline

    var stamp = shopDateTime_();
    var moved = 0;
    targets.forEach(function (t) {
      var rec = {};
      Object.keys(t.obj).forEach(function (k) { rec[k] = t.obj[k]; });
      rec['Archived At']     = stamp;
      rec['Archived Status'] = t.status;
      rec['Archived From']   = SHEETS.INTERVIEW_PIPELINE;

      // Upsert by Candidate ID so re-archiving the same person never duplicates.
      var existing = t.cid ? findRowsByColumnValue_(arch, 'Candidate ID', t.cid) : [];
      if (existing.length) batchUpdateRow_(arch, existing[0].rowNum, rec);
      else appendRowByHeader_(arch, rec);
      moved++;
    });

    // Delete swept rows from the pipeline bottom-up so row numbers stay valid.
    targets.map(function (t) { return t.rowNum; })
           .sort(function (a, b) { return b - a; })
           .forEach(function (rn) { ip.deleteRow(rn); });

    return moved;
  });

  if (typeof execMoved === 'string') {
    // Lock was busy — withLockOrSkip_ returned its skip message. Try again next pass.
    report.push('');
    report.push('  ' + execMoved);
    return { moved: 0, summary: 'skipped (locked)', report: report.join('\n') };
  }

  logEvent_('PIPELINE_SWEEP', '', { moved: execMoved, counts: counts, heldForCancel: heldForCancel });
  report.push('');
  report.push('  ✓ moved ' + execMoved + ' candidate(s) to "' + SHEETS.PIPELINE_ARCHIVE + '"');
  return { moved: execMoved, summary: execMoved + ' moved (' + heldForCancel + ' held)', report: report.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE — move a candidate back onto the live pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull one candidate back out of the Pipeline Archive and onto the Interview
 * Pipeline as MANUAL_REVIEW (so the manager can act on them again). Cancels any
 * still-pending decline / hold email. Removes the archive row. Returns a status
 * string. Safe to call from code or a menu wrapper.
 */
function restorePipelineCandidate(candidateId) {
  candidateId = String(candidateId || '').trim();
  if (!candidateId) return 'restorePipelineCandidate: no Candidate ID given';

  return withLock_(function () {
    var arch = getSheetOrNull_(SHEETS.PIPELINE_ARCHIVE);
    if (!arch) return 'No "' + SHEETS.PIPELINE_ARCHIVE + '" tab yet — nothing to restore.';
    var hits = findRowsByColumnValue_(arch, 'Candidate ID', candidateId);
    if (!hits.length) return 'Not found in "' + SHEETS.PIPELINE_ARCHIVE + '": ' + candidateId;

    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var rec = {};
    Object.keys(hits[0].data).forEach(function (k) { rec[k] = hits[0].data[k]; });
    // Drop archive-only bookkeeping columns before writing back to the pipeline.
    PIPELINE_ARCHIVE_EXTRA_COLS.forEach(function (c) { delete rec[c]; });

    var stamp = shopDateTime_();
    rec['Status']           = STATUS.MANUAL_REVIEW;
    rec['Manager Decision'] = '';   // clear the closed-out decision so the dropdown is live again
    rec['Last Updated']     = stamp;
    rec['Notes']            = 'Restored to pipeline from archive: ' + stamp;

    var existing = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
    if (existing.length) batchUpdateRow_(ip, existing[0].rowNum, rec);
    else appendRowByHeader_(ip, rec);

    // Keep All Candidates in sync.
    var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
    if (ac) updateRowWhere_(ac, 'Candidate ID', candidateId, { 'Status': STATUS.MANUAL_REVIEW, 'Last Updated': stamp });

    // Cancel any pending decline / hold email that was queued at close-out.
    var cancelled = 0;
    if (typeof cancelQueuedEmailsForCandidate_ === 'function') {
      cancelled += cancelQueuedEmailsForCandidate_(candidateId, 'gracious_decline');
      cancelled += cancelQueuedEmailsForCandidate_(candidateId, 'hold_email');
    }

    arch.deleteRow(hits[0].rowNum);

    logEvent_('PIPELINE_RESTORE', candidateId, { cancelledEmails: cancelled });
    return 'Restored ' + candidateId + ' to the pipeline (status MANUAL_REVIEW; cancelled ' +
           cancelled + ' pending email(s)).';
  });
}

/** Menu wrapper: restore whatever row is selected on the Pipeline Archive tab. */
function restoreSelectedArchivedCandidate() {
  return safeRun_('restoreSelectedArchivedCandidate', function () {
    var ui = SpreadsheetApp.getUi();
    var sh = SpreadsheetApp.getActive().getActiveSheet();
    if (sh.getName() !== SHEETS.PIPELINE_ARCHIVE) {
      ui.alert('Pick a candidate first',
        'Open the "' + SHEETS.PIPELINE_ARCHIVE + '" tab, click anywhere in the candidate\'s row, then run this again.',
        ui.ButtonSet.OK);
      return;
    }
    var row = sh.getActiveRange().getRow();
    if (row < 2) { ui.alert('Select a candidate row (not the header row).'); return; }
    var cidCol = getColIndex_(sh, 'Candidate ID');
    if (!cidCol) { ui.alert('This tab has no Candidate ID column.'); return; }
    var cid = String(sh.getRange(row, cidCol).getValue() || '').trim();
    if (!cid) { ui.alert('That row has no Candidate ID.'); return; }

    var msg = restorePipelineCandidate(cid);
    toast_(msg, 'Recruiting OS', 8);
    ui.alert('Restore to Pipeline', msg, ui.ButtonSet.OK);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Display name for reports: prefer Full Name, else First + Last. */
function _sweepDisplayName_(obj) {
  var full = String(obj['Full Name'] || '').trim();
  if (full) return full;
  return (String(obj['First Name'] || '') + ' ' + String(obj['Last Name'] || '')).trim();
}

/**
 * Set of Candidate IDs that still have a PENDING email whose cancellable window
 * has not yet passed. Used to keep just-closed candidates on the pipeline until
 * their decline / hold email actually sends (so "Reopen" stays available).
 */
function _candidatesWithPendingCancellableEmail_() {
  var set = {};
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh) return set;
  var last = sh.getLastRow();
  if (last < 2) return set;
  var headers = getHeaderRow_(sh);
  var hCid  = headers.indexOf('Candidate ID');
  var hSta  = headers.indexOf('Status');
  var hCanc = headers.indexOf('Cancellable Until');
  if (hCid === -1 || hSta === -1) return set;

  var now = Date.now();
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][hSta] || '').trim().toUpperCase() !== 'PENDING') continue;
    var cid = String(data[i][hCid] || '').trim();
    if (!cid) continue;
    if (hCanc !== -1) {
      var cu = _coerceDate_(data[i][hCanc]);
      // No / unparseable / past cancellable date → not (or no longer) cancellable.
      if (!cu || isNaN(cu.getTime()) || cu.getTime() <= now) continue;
    }
    set[cid] = true;
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST (read-only)
// ─────────────────────────────────────────────────────────────────────────────

function PIPELINE_CLEANUP_selfTest() {
  var out = ['[SWEEP] selfTest (read-only)…'];
  out.push('  - PIPELINE_SWEEP_ENABLED             : ' + CFG.getBool('PIPELINE_SWEEP_ENABLED', true));
  out.push('  - PIPELINE_SWEEP_RESPECT_CANCELLABLE : ' + CFG.getBool('PIPELINE_SWEEP_RESPECT_CANCELLABLE', true));
  out.push('  - sweep statuses                     : ' + _pipelineSweepStatuses_().join(', '));

  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  out.push('  ' + (ip ? '✓' : '✗') + ' Interview Pipeline tab present');
  var arch = getSheetOrNull_(SHEETS.PIPELINE_ARCHIVE);
  out.push('  ' + (arch ? '✓ "' + SHEETS.PIPELINE_ARCHIVE + '" tab present (' + (arch.getLastRow() - 1) + ' archived row(s))'
                        : '○ "' + SHEETS.PIPELINE_ARCHIVE + '" tab not created yet (created on first sweep)'));

  var r = _sweepInterviewPipeline_({ dryRun: true });
  out.push('  - would move now                     : ' + r.moved);
  out.push('  Run previewPipelineSweep() for the full per-candidate plan.');

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
