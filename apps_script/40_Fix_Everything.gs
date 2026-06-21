/**
 * 40_Fix_Everything.gs — one-click "make the live sheet match the code" orchestrator.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Apps Script build is the source of truth, but the live spreadsheet can fall
 * behind it: missing columns (e.g. "Candidate ID" on All Candidates), missing
 * Config keys, un-seeded email templates, un-installed form/time triggers (which is
 * why some tabs "only have headers"), and candidates wrongly auto-rejected by the
 * old missing-score bug. Every individual repair already exists as its own menu
 * item; operators just never know the correct ORDER to run them in.
 *
 * FIX_runEverything() runs them all, in dependency order, each wrapped so one
 * failure never aborts the rest, with a time-budget guard for the 6-minute limit.
 * It is idempotent and safe to re-run — in fact the heavy backfill/recovery steps
 * self-cap per run, so re-running until the report shows 0 remaining is expected.
 *
 * SAFETY: honors SYSTEM_MODE. In TEST mode every candidate email is rerouted to the
 * test recipient, so running this in TEST sends nothing to real candidates.
 */

// Leave this much of the 6-minute budget as headroom before starting a heavy step.
var FIX_TIME_BUDGET_MS = 5 * 60 * 1000; // 5 min; Apps Script hard limit is ~6 min.

/**
 * THE BUTTON. Runs structural repairs (fast) then heavy backfills (capped), and
 * prints a consolidated report. Re-run until "needs another run" is empty.
 */
function FIX_runEverything() {
  var t0 = Date.now();
  var report = ['════════════════════════════════════════════════',
                ' FIX EVERYTHING — ' + (typeof shopDateTime_ === 'function' ? shopDateTime_() : new Date()),
                '════════════════════════════════════════════════'];
  var deferred = [];

  function elapsed() { return Date.now() - t0; }
  function budgetLeft() { return elapsed() < FIX_TIME_BUDGET_MS; }

  // Run a step if its function exists. `heavy` steps are skipped (deferred) when the
  // time budget is gone, so a long run never dies mid-step and loses its report.
  function step(label, fnName, opts) {
    opts = opts || {};
    var fn = (typeof this[fnName] === 'function') ? this[fnName]
           : (eval('typeof ' + fnName) === 'function' ? eval(fnName) : null);
    if (!fn) { report.push('  – ' + label + ' — SKIPPED (function ' + fnName + ' not found)'); return null; }
    if (opts.heavy && !budgetLeft()) {
      report.push('  ⏸ ' + label + ' — DEFERRED (out of time budget; re-run FIX_runEverything)');
      deferred.push(label);
      return null;
    }
    try {
      var r = fn();
      var rs = (r == null) ? 'ok' : (typeof r === 'string' ? r.split('\n')[0] : JSON.stringify(r));
      report.push('  ✓ ' + label + ' → ' + _fixTrunc_(rs, 220));
      return r;
    } catch (e) {
      report.push('  ✗ ' + label + ' FAILED: ' + (e && e.message ? e.message : e));
      if (typeof logError_ === 'function') logError_('FIX_runEverything:' + label, e, '', 'ERROR');
      return null;
    }
  }

  report.push('', '── 1. STRUCTURE (sheets, columns, config, dropdown, validations) ──');
  step('Bootstrap / Repair System', 'bootstrapSystem');           // adds Candidate ID etc. + config keys + dropdown
  step('Seed all email templates', 'seedAllTemplates');           // the 3 missing candidate-facing templates
  step('Install / refresh email templates', 'installAllEmailTemplates');
  step('Install / refresh AI prompts', 'installAllAiPrompts');

  report.push('', '── 2. WIRING (forms linked + triggers installed → empty tabs start collecting) ──');
  step('Verify Form Registry', 'verifyFormRegistry');
  step('Install all triggers', 'installAllTriggers');             // form-submit + time triggers; the empty-sheet root cause
  step('Audit triggers', 'auditTriggers');

  report.push('', '── 3. DATA REPAIR (IDs, roles, scores, grades, recommendations) ──');
  step('Full backfill repair (IDs/roles/scores/grades/recs)', 'runFullBackfillRepair', { heavy: true });
  step('Backfill missing resume grades', 'backfillResumeGrades', { heavy: true });

  report.push('', '── 4. RECOVER WRONGLY AUTO-REJECTED CANDIDATES ──');
  step('Recover wrongly auto-rejected', 'SCORING_recoverAutoRejects', { heavy: true });

  report.push('', '── 5. CLEANUP (dedup + purge test/closed shells) ──');
  step('Auto-maintenance (dedup + purge)', 'autoMaintenance', { heavy: true });

  report.push('', '── 6. VERIFY ──');
  step('Health check', 'runHealthCheck');
  step('Production readiness check', 'productionReadinessCheck');

  report.push('', '════════════════════════════════════════════════');
  report.push(' DONE in ' + Math.round(elapsed() / 1000) + 's.');
  if (deferred.length) {
    report.push(' ⏸ ' + deferred.length + ' heavy step(s) deferred — auto-resuming in ~1 min:');
    deferred.forEach(function (d) { report.push('     • ' + d); });
    // F8: auto-create a one-shot ~1-min trigger to re-invoke FIX_runEverything
    // until nothing is deferred (the resume run self-deletes its scheduler), so
    // backfills/recovery finish unattended without Travis re-clicking.
    if (typeof _fixScheduleResume_ === 'function') {
      try { _fixScheduleResume_(); report.push('     ↻ auto-resume scheduled (no action needed).'); }
      catch (e) { report.push('     ⚠ auto-resume scheduling failed: ' + e.message + ' — re-run manually.'); }
    }
  } else {
    report.push(' ✓ No steps deferred. If backfill counts above are non-zero, re-run once more.');
    if (typeof _clearFixResumeTriggers_ === 'function') _clearFixResumeTriggers_();
  }
  report.push('════════════════════════════════════════════════');

  var msg = report.join('\n');
  Logger.log(msg);
  if (typeof logEvent_ === 'function') logEvent_('FIX_RUN_EVERYTHING', '', { ms: elapsed(), deferred: deferred.length });
  _fixWriteReport_(msg);
  if (typeof toast_ === 'function') {
    toast_('Fix Everything done in ' + Math.round(elapsed() / 1000) + 's' +
      (deferred.length ? ' — RE-RUN to finish ' + deferred.length + ' deferred step(s).' : '. See "Fix Everything Log" tab.'),
      'Recruiting OS', 12);
  }
  return msg;
}

/** Write the run report to a dedicated tab so it survives the toast. */
function _fixWriteReport_(msg) {
  try {
    var ss = SpreadsheetApp.getActive();
    var name = 'Fix Everything Log';
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.insertRowsBefore(1, 1);
    sh.getRange(1, 1).setValue(msg);
    sh.getRange(1, 1).setWrap(false);
    sh.setColumnWidth(1, 900);
  } catch (e) {
    Logger.log('[_fixWriteReport_] ' + e);
  }
}

function _fixTrunc_(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
