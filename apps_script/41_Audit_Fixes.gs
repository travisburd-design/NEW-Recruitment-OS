/**
 * 41_Audit_Fixes.gs
 * Frank's European Service — Recruiting OS
 *
 * Remediation layer implementing the June 2026 audit (Fix Tracker F1–F24) and
 * the Trim-Down Plan's "fail-loud" + turnkey requirements. Everything here is
 * additive and self-contained: existing files call into these helpers, and the
 * two operator buttons below run the whole repair + verification end-to-end.
 *
 *   FIX_applyAllAuditFixes()   ← the one repair button. Idempotent. Safe to re-run.
 *   VERIFY_runAllSelfTests()   ← runs every subsystem self-test + writes a report.
 *
 * Individual fixes (called inline from their owning files OR from triggers):
 *   recoverBlockedQueue_()           F2  — flip recoverable BLOCKED → PENDING
 *   _triggerHeartbeat_(fn,status)    F10 — real last-fired/last-status per handler
 *   assertTriggerSet_()              F10 — assert the full expected trigger set
 *   assertAiReady_()                 F5  — fail LOUD when AI on but unkeyed
 *   ensureTranscriptSourcesSeeded_() F6  — activate one transcript source turnkey
 *   cleanupConfigDriftTabs_()        F14 — archive/hide OLD + DRIFT Config tabs
 *   queueBacklogDue_()               F18 — count PENDING rows already due
 *   systemSelfAudit_()               F24 — morning fail-loud health audit
 *   _fixScheduleResume_/_clearResume F8  — auto-resume deferred Fix Everything
 */

// ─────────────────────────────────────────────────────────────────────────────
// F10 — TRIGGER HEARTBEAT
// Each installed trigger handler calls _triggerHeartbeat_ as its first line, so
// the "Trigger Health" sheet shows a REAL last-fired time and status rather than
// a static audit. assertTriggerSet_() then proves the full set is installed.
// ─────────────────────────────────────────────────────────────────────────────

// The complete set of handler functions that installAllTriggers() installs.
// Used by assertTriggerSet_() and the health check to detect a dead/missing one.
var EXPECTED_TRIGGER_HANDLERS = Object.freeze([
  'onPipelineEdit',
  'flushEmailQueue',
  'runDailyDigest',
  'processRawOtterIntake',
  'gradePendingTranscripts',
  'importTranscriptsFromSources',
  'pollCalendarBookings',
  'updateRecommendationEngineForAll',
  'runWorksheetDigest',
  'runHiringEmailLeadImport',
  'pruneLogs',
  'autoMaintenance'
]);

/**
 * Stamp a heartbeat onto every Trigger Health row whose Function matches fnName.
 * Never throws — a heartbeat write must never break the handler it instruments.
 * @param {string} fnName   handler function name
 * @param {string=} status  'OK' (default) | 'RUNNING' | 'ERROR'
 * @param {string=} note
 */
function _triggerHeartbeat_(fnName, status, note) {
  try {
    var sh = getSheetOrNull_(SHEETS.TRIGGER_HEALTH);
    if (!sh) return;
    status = status || 'OK';
    var stamp = shopDateTime_();
    var hits = findRowsByColumnValue_(sh, 'Function', fnName);
    if (hits.length) {
      hits.forEach(function (h) {
        batchUpdateRow_(sh, h.rowNum, {
          'Last Fired':  stamp,
          'Last Status': status,
          'Notes':       note || h.data['Notes'] || ''
        });
      });
    } else {
      // Trigger fired but no audit row exists yet — record it so the heartbeat
      // is never silently lost (e.g. before the first auditTriggers run).
      appendRowByHeader_(sh, {
        'Trigger Name':   '(heartbeat)',
        'Function':       fnName,
        'Type':           'CLOCK',
        'Source':         '',
        'Last Installed': '',
        'Last Fired':     stamp,
        'Last Status':    status,
        'Notes':          note || 'auto-added by heartbeat'
      });
    }
  } catch (e) {
    try { Logger.log('_triggerHeartbeat_(' + fnName + ') failed: ' + e); } catch (_) {}
  }
}

/**
 * Assert the full expected trigger set is installed. Returns
 * { ok, missing:[], extra:[], installed:[] }. Logs CRITICAL (fail-loud) when a
 * handler is missing so a dead trigger looks DIFFERENT from a healthy one.
 */
function assertTriggerSet_() {
  var installed = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    installed[t.getHandlerFunction()] = (installed[t.getHandlerFunction()] || 0) + 1;
  });
  var missing = [];
  EXPECTED_TRIGGER_HANDLERS.forEach(function (fn) { if (!installed[fn]) missing.push(fn); });
  var out = { ok: missing.length === 0, missing: missing, installed: Object.keys(installed) };
  if (missing.length) {
    logError_('assertTriggerSet_',
      'Expected triggers NOT installed: ' + missing.join(', ') + '. Run installAllTriggers().',
      '', 'CRITICAL');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// F2 — EMAIL QUEUE RECOVERY
// Flip rows that BLOCKED only because sending was off / the recipient was blank /
// the recipient drifted back to PENDING, and recompute "To (Actual)" from
// "To (Intended)" at recovery time. _sendQueueRow_ ALSO self-heals the recipient
// at send time (see 14_Email_Queue.gs), so a recovered row sends cleanly on the
// next 15-minute flush. Never touches SENT / CANCELLED / FAILED rows.
// ─────────────────────────────────────────────────────────────────────────────

// BLOCKED reasons that are recoverable once the system is configured to send.
function _isRecoverableBlock_(errText) {
  var e = String(errText || '');
  return /SEND_ENABLED is FALSE/i.test(e) ||
         /To \(Actual\) is empty/i.test(e) ||
         /Recipient drift/i.test(e) ||
         /quiet hours/i.test(e);
}

/**
 * Recover BLOCKED email-queue rows.
 * @param {object=} opts  { dryRun:boolean }
 * @return {object} summary { scanned, recovered, recomputed, skipped }
 */
function recoverBlockedQueue_(opts) {
  opts = opts || {};
  return withLock_(function () {
    var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
    if (!sh) return { scanned: 0, recovered: 0, recomputed: 0, skipped: 0, note: 'no Email Queue' };
    var last = sh.getLastRow();
    if (last < 2) return { scanned: 0, recovered: 0, recomputed: 0, skipped: 0 };

    var headers = getHeaderRow_(sh);
    var hStatus   = headers.indexOf('Status');
    var hErr      = headers.indexOf('Error');
    var hIntended = headers.indexOf('To (Intended)');
    var hActual   = headers.indexOf('To (Actual)');
    var hSendAt   = headers.indexOf('Send At');
    if (hStatus === -1) return { scanned: 0, recovered: 0, recomputed: 0, skipped: 0, note: 'no Status column' };

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, recovered: 0, recomputed: 0, skipped: 0 };
    var now = new Date();

    for (var i = 0; i < data.length; i++) {
      if (String(data[i][hStatus]) !== 'BLOCKED') continue;
      summary.scanned++;
      if (!_isRecoverableBlock_(data[i][hErr])) { summary.skipped++; continue; }

      var rowNum = i + 2;
      var intended = hIntended !== -1 ? String(data[i][hIntended] || '').trim() : '';
      var recomputed = actualRecipient_(intended);   // '' if still cannot send

      if (opts.dryRun) { summary.recovered++; continue; }

      var updates = {
        'Status': 'PENDING',
        'Error':  '',
        'Notes':  'Recovered BLOCKED→PENDING at ' + shopDateTime_(now)
      };
      // Recompute the recipient now; _sendQueueRow_ recomputes again at send.
      if (hActual !== -1 && recomputed) { updates['To (Actual)'] = recomputed; summary.recomputed++; }
      // Past-due rows should flush on the very next run.
      if (hSendAt !== -1) {
        var sendAt = _coerceDate_(data[i][hSendAt]);
        if (sendAt > now) updates['Send At'] = shopDateTime_(now);
      }
      batchUpdateRow_(sh, rowNum, updates);
      summary.recovered++;
    }

    Logger.log('[QUEUE] recoverBlockedQueue_ — ' + JSON.stringify(summary));
    if (!opts.dryRun && summary.recovered > 0) {
      logEvent_('QUEUE_RECOVERED', '', summary);
    }
    return summary;
  });
}

/** Public menu wrapper: recover BLOCKED email and flush so it sends now. */
function recoverBlockedEmailQueue() {
  var rec = recoverBlockedQueue_();
  var msg = 'Recovered ' + (rec.recovered || 0) + ' BLOCKED email(s) → PENDING (' +
            (rec.recomputed || 0) + ' recipients recomputed). Flushing now…';
  toast_(msg, 'Recruiting OS', 8);
  if (typeof flushEmailQueue === 'function') safeRun_('recoverBlockedEmailQueue:flush', function () { flushEmailQueue(); });
  Logger.log('[QUEUE] ' + msg);
  return msg;
}

/** Count PENDING rows whose Send At is already due (the real flush backlog). F18 */
function queueBacklogDue_() {
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);
  var hStatus = headers.indexOf('Status');
  var hSendAt = headers.indexOf('Send At');
  if (hStatus === -1) return 0;
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var now = Date.now();
  var n = 0;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][hStatus]) !== 'PENDING') continue;
    if (hSendAt === -1) { n++; continue; }
    if (_coerceDate_(data[i][hSendAt]).getTime() <= now) n++;
  }
  return n;
}

/** Count BLOCKED rows currently in the queue (surfaced in the digest). F2 */
function queueBlockedCount_() {
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh) return 0;
  var hStatus = getColIndex_(sh, 'Status');
  if (!hStatus) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, hStatus, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === 'BLOCKED') n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// F5 — FAIL LOUD WHEN AI IS ON BUT UNKEYED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If AI grading is enabled but no Gemini key is present in Script Properties,
 * raise a CRITICAL (which now emails regardless of SEND_ENABLED — see F9). When
 * a key IS present, optionally confirm it actually returns JSON.
 * @param {object=} opts { ping:boolean }
 * @return {object} { enabled, keyed, ok, detail }
 */
function assertAiReady_(opts) {
  opts = opts || {};
  var enabled = CFG.getBool('AI_GRADING_ENABLED', true);
  if (!enabled) return { enabled: false, keyed: false, ok: true, detail: 'AI grading disabled in Config' };

  var keyed = hasSecret_(SECRETS.GEMINI_API_KEY);
  if (!keyed) {
    logError_('assertAiReady_',
      'AI_GRADING_ENABLED=TRUE but GEMINI_API_KEY is NOT set in Script Properties. ' +
      'AI grading will fail. Paste the key under Project Settings → Script Properties, ' +
      'or set AI_GRADING_ENABLED=FALSE to run on deterministic scoring only.',
      '', 'CRITICAL');
    return { enabled: true, keyed: false, ok: false, detail: 'GEMINI_API_KEY missing' };
  }

  if (opts.ping && typeof _geminiGradeJson_ === 'function') {
    var p = _geminiGradeJson_('assertAiReady', '', 'Return ONLY this JSON: {"ok": true}');
    if (!p.ok) {
      logError_('assertAiReady_', 'Gemini key present but live call failed: ' + (p.error || 'unknown'), '', 'CRITICAL');
      return { enabled: true, keyed: true, ok: false, detail: p.error || 'ping failed' };
    }
  }
  return { enabled: true, keyed: true, ok: true, detail: 'AI ready' };
}

// ─────────────────────────────────────────────────────────────────────────────
// F6 — ACTIVATE ONE TRANSCRIPT SOURCE (turnkey)
// If the Transcript Sources sheet has zero Active rows, seed Fathom (Gmail) and
// Otter (Gmail) source rows from the Config queries so the pull-based importer
// actually has something to do. Fathom's Gmail query default is known, so its
// row is activated; an Otter row is added (active only if OTTER_GMAIL_QUERY is
// configured — Otter's primary path is the Zapier → Raw Otter Intake importer).
// Both feed the ONE ingestion pipeline (per the transcript decision).
// ─────────────────────────────────────────────────────────────────────────────

function ensureTranscriptSourcesSeeded_() {
  var sh = getSheetOrNull_(SHEETS.TRANSCRIPT_SOURCES);
  if (!sh) return { added: 0, activated: 0, note: 'Transcript Sources sheet missing — run bootstrapSystem()' };

  var headers = getHeaderRow_(sh);
  var hName   = headers.indexOf('Source Name');
  var hActive = headers.indexOf('Active');
  if (hName === -1) return { added: 0, activated: 0, note: 'Transcript Sources missing Source Name column' };

  var last = sh.getLastRow();
  var existing = {};
  var anyActive = false;
  if (last >= 2) {
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    for (var i = 0; i < data.length; i++) {
      existing[String(data[i][hName] || '').trim().toLowerCase()] = true;
      if (hActive !== -1 && String(data[i][hActive]).trim().toUpperCase() === 'TRUE') anyActive = true;
    }
  }
  if (anyActive) return { added: 0, activated: 0, note: 'A transcript source is already Active — left untouched' };

  var fathomQ = CFG.get('FATHOM_GMAIL_QUERY', 'from:(fathom.video) newer_than:14d');
  var otterQ  = CFG.get('OTTER_GMAIL_QUERY', '');
  var seeds = [
    { name: 'Fathom (Gmail)', active: !!fathomQ, type: 'gmail', modality: CFG.get('FATHOM_MODALITY', 'online'),
      query: fathomQ, folder: CFG.get('FATHOM_TRANSCRIPT_FOLDER_ID', ''), interview: 'Live Interview',
      notes: 'Auto-seeded by audit fix F6. Online meetings (identity-gated).' },
    { name: 'Otter (Gmail)', active: !!otterQ, type: 'gmail', modality: CFG.get('OTTER_MODALITY', 'in_person'),
      query: otterQ, folder: CFG.get('OTTER_TRANSCRIPT_FOLDER_ID', ''), interview: 'Phone Screen',
      notes: 'Auto-seeded by audit fix F6. Set a Gmail Query to activate; Otter normally arrives via Zapier → Raw Otter Intake.' }
  ];

  var summary = { added: 0, activated: 0 };
  seeds.forEach(function (s) {
    if (existing[s.name.toLowerCase()]) return;
    appendRowByHeader_(sh, {
      'Source Name': s.name,
      'Active': s.active ? 'TRUE' : 'FALSE',
      'Type': s.type,
      'Modality': s.modality,
      'Gmail Query': s.query,
      'Drive Folder ID': s.folder,
      'Default Interview Type': s.interview,
      'Notes': s.notes
    });
    summary.added++;
    if (s.active) summary.activated++;
  });
  if (summary.added) logEvent_('TRANSCRIPT_SOURCES_SEEDED', '', summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// F14 — RECONCILE CONFIG DRIFT TABS
// Keep ONE Config tab as the single source of truth. Any "OLD Config" /
// "Config [WITH DRIFT…]" tab is renamed to an "Archived — …" prefix and hidden
// (not deleted, so nothing is destroyed). Only acts when the canonical Config
// tab exists and is non-empty.
// ─────────────────────────────────────────────────────────────────────────────

function cleanupConfigDriftTabs_() {
  var ss = SpreadsheetApp.getActive();
  var canonical = ss.getSheetByName(SHEETS.CONFIG);
  if (!canonical || canonical.getLastRow() < 2) {
    return { archived: 0, note: 'Canonical Config not ready — skipped (safe)' };
  }
  var driftNames = [
    'OLD Config',
    'Config [WITH DRIFT ONLY USE FOR REFERENCE]',
    'Config [WITH DRIFT - reference only]',
    'Config [WITH DRIFT — reference only]'
  ];
  var archived = 0;
  driftNames.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    try {
      var archivedName = ('Archived — ' + name).substring(0, 95);
      if (!ss.getSheetByName(archivedName)) sh.setName(archivedName);
      sh.hideSheet();
      archived++;
    } catch (e) { logError_('cleanupConfigDriftTabs_', e, '', 'WARN'); }
  });
  if (archived) logEvent_('CONFIG_DRIFT_ARCHIVED', '', { archived: archived });
  return { archived: archived };
}

// ─────────────────────────────────────────────────────────────────────────────
// F8 — AUTO-RESUME DEFERRED "FIX EVERYTHING"
// When FIX_runEverything defers heavy steps, it schedules a one-shot trigger
// (~1 min out) to re-invoke itself until nothing is deferred. The resumed run
// clears its own scheduling trigger first so they never accumulate.
// ─────────────────────────────────────────────────────────────────────────────

var FIX_RESUME_HANDLER = 'FIX_resumeRun';

function _clearFixResumeTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === FIX_RESUME_HANDLER) {
      try { ScriptApp.deleteTrigger(t); n++; } catch (_) {}
    }
  });
  return n;
}

function _fixScheduleResume_() {
  _clearFixResumeTriggers_();
  ScriptApp.newTrigger(FIX_RESUME_HANDLER).timeBased().after(60 * 1000).create();
  logEvent_('FIX_RESUME_SCHEDULED', '', { inSeconds: 60 });
}

/** One-shot trigger target: clear scheduling triggers, then resume the repair. */
function FIX_resumeRun() {
  _triggerHeartbeat_(FIX_RESUME_HANDLER, 'OK');
  _clearFixResumeTriggers_();
  return FIX_runEverything();
}

// ─────────────────────────────────────────────────────────────────────────────
// F24 — MORNING FAIL-LOUD SELF-AUDIT
// Runs from autoMaintenance (daily) and is surfaced in the digest. Collects the
// real risk surface — blocked email, dead triggers, AI failures, missing key,
// deferred jobs, unmatched/skipped transcripts — and emails a CRITICAL alert
// (un-gated from SEND_ENABLED) when anything is wrong. Returns the issue list.
// ─────────────────────────────────────────────────────────────────────────────

function systemSelfAudit_() {
  var issues = [];

  // Blocked email queue
  var blocked = queueBlockedCount_();
  if (blocked > 0) issues.push(blocked + ' email(s) BLOCKED in the queue (run "Recover Blocked Email Queue")');

  // Trigger set
  var trg = assertTriggerSet_();
  if (!trg.ok) issues.push('Triggers missing: ' + trg.missing.join(', ') + ' (run "Install All Triggers")');

  // AI readiness
  var ai = assertAiReady_();
  if (!ai.ok) issues.push('AI grading: ' + ai.detail);

  // AI grading failures parked on candidates
  var aiFails = _selfAuditCountNotePrefix_(SHEETS.ALL_CANDIDATES, 'AI scoring failed');
  if (aiFails > 0) issues.push(aiFails + ' candidate(s) with failed AI grades (run "Retry Failed AI Grades")');

  // Deferred Fix Everything steps still scheduled
  var resumePending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === FIX_RESUME_HANDLER; });
  if (resumePending) issues.push('A deferred "Fix Everything" resume is still pending');

  // Unmatched / skipped transcripts
  var unmatched = _selfAuditCountStatus_(SHEETS.RAW_OTTER_INTAKE, 'Processed Status', 'UNMATCHED');
  var skipped   = _selfAuditCountStatus_(SHEETS.RAW_OTTER_INTAKE, 'Processed Status', 'SKIPPED');
  if (unmatched > 0) issues.push(unmatched + ' transcript(s) UNMATCHED — need a candidate');
  if (skipped > 0)   issues.push(skipped + ' transcript(s) SKIPPED (short/failed) — review');

  logEvent_('SYSTEM_SELF_AUDIT', '', { issues: issues.length, detail: issues.join(' | ') });

  if (issues.length) {
    // Fail loud: one CRITICAL alert (rate-limited per hour by label), which now
    // sends regardless of SEND_ENABLED (F9).
    logError_('systemSelfAudit_',
      'Recruiting OS self-audit found ' + issues.length + ' issue(s):\n  • ' + issues.join('\n  • '),
      '', 'CRITICAL');
  }
  return { ok: issues.length === 0, issues: issues };
}

function _selfAuditCountNotePrefix_(sheetName, prefix) {
  var sh = getSheetOrNull_(sheetName);
  if (!sh) return 0;
  var col = getColIndex_(sh, 'Notes');
  if (!col) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0] || '').indexOf(prefix) === 0) n++;
  return n;
}

function _selfAuditCountStatus_(sheetName, colName, status) {
  var sh = getSheetOrNull_(sheetName);
  if (!sh) return 0;
  var col = getColIndex_(sh, colName);
  if (!col) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0] || '').trim().toUpperCase() === status) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE REPAIR BUTTON — applies every code-side audit fix, in order.
// Idempotent and safe to re-run. Spreadsheet-data items that only Travis can do
// (paste GEMINI_API_KEY, link the Culture form, flip to LIVE) are reported, not
// guessed. Honors SYSTEM_MODE — in TEST mode no candidate email leaves.
// ─────────────────────────────────────────────────────────────────────────────

function FIX_applyAllAuditFixes() {
  var t0 = Date.now();
  var report = ['════════════════════════════════════════════════',
                ' APPLY ALL AUDIT FIXES — ' + shopDateTime_(),
                '════════════════════════════════════════════════'];

  function step(label, fn) {
    try {
      var r = fn();
      var rs = (r == null) ? 'ok' : (typeof r === 'string' ? r.split('\n')[0] : JSON.stringify(r));
      report.push('  ✓ ' + label + ' → ' + truncate_(rs, 200));
    } catch (e) {
      report.push('  ✗ ' + label + ' FAILED: ' + (e && e.message ? e.message : e));
      logError_('FIX_applyAllAuditFixes:' + label, e, '', 'ERROR');
    }
  }

  report.push('', '── Structure & Config (F13/F14) ──');
  step('Bootstrap / repair sheets + seed Config (incl. new flags)', function () { return bootstrapSystem(); });
  step('Archive Config drift tabs (F14)', function () { return cleanupConfigDriftTabs_(); });

  report.push('', '── Wiring & turnkey data (F3/F6/F10) ──');
  step('Seed email templates', function () { return (typeof seedAllTemplates === 'function') ? seedAllTemplates() : 'n/a'; });
  step('Install all triggers — 15-min flush, heartbeat set (F3/F10)', function () { return installAllTriggers(); });
  step('Activate a transcript source (F6)', function () { return ensureTranscriptSourcesSeeded_(); });

  report.push('', '── Email queue recovery (F2) ──');
  step('Recover BLOCKED → PENDING + recompute recipients', function () { return recoverBlockedQueue_(); });

  report.push('', '── Fail-loud checks (F5/F9/F10/F24) ──');
  step('Assert AI readiness (loud if unkeyed)', function () { return assertAiReady_({ ping: false }); });
  step('Assert full trigger set installed', function () { return assertTriggerSet_(); });
  step('System self-audit (morning fail-loud)', function () { return systemSelfAudit_(); });

  report.push('', '── Dashboard banner (F1) ──');
  step('Rebuild dashboard with mode banner', function () { return (typeof DASHBOARD_rebuild === 'function') ? DASHBOARD_rebuild() : 'n/a'; });

  // ── Items only Travis can provide (reported, never guessed) ──
  report.push('', '── ACTION REQUIRED BY YOU (only you can do these) ──');
  if (!hasSecret_(SECRETS.GEMINI_API_KEY) && CFG.getBool('AI_GRADING_ENABLED', true)) {
    report.push('  ⚠ F5  Paste GEMINI_API_KEY in Project Settings → Script Properties (AI grading is ON).');
  }
  var cultureTab = getSheetOrNull_(SHEETS.CULTURE_FIT);
  if (!cultureTab || cultureTab.getLastRow() < 1) {
    report.push('  ⚠ F7  Link the Culture-Fit Google Form to THIS spreadsheet (Form → Responses → Link to Sheets).');
  }
  if (!isLiveMode_() || !sendEnabled_()) {
    report.push('  ⚠ F1  You are in TEST mode (no candidate email sends). Menu → Mode & Status → GO LIVE when ready.');
  }
  report.push('  ℹ  F6  Otter transcripts arrive via Zapier → "Raw Otter Intake" (no action). To also pull Otter from Gmail, set OTTER_GMAIL_QUERY in Config.');

  report.push('', ' DONE in ' + Math.round((Date.now() - t0) / 1000) + 's. See "Fix Everything Log".', '════════════════════════════════════════════════');
  var msg = report.join('\n');
  Logger.log(msg);
  if (typeof _fixWriteReport_ === 'function') _fixWriteReport_(msg);
  logEvent_('FIX_APPLY_ALL_AUDIT', '', { ms: Date.now() - t0 });
  toast_('All audit fixes applied. See "Fix Everything Log" tab for the action-required list.', 'Recruiting OS', 12);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VERIFY BUTTON — runs every subsystem self-test + key live checks and
// writes a pass/fail report to a "Verification Report" tab. This is the
// "every feature tested & verified" deliverable, runnable in one click.
// Read-only / dry-run where possible; honors TEST mode for anything that sends.
// ─────────────────────────────────────────────────────────────────────────────

function VERIFY_runAllSelfTests() {
  var t0 = Date.now();
  var lines = ['════════════════════════════════════════════════',
               ' VERIFICATION REPORT — ' + shopDateTime_(),
               ' Mode: ' + (isLiveMode_() ? 'LIVE' : 'TEST') + ' · SEND_ENABLED: ' + sendEnabled_(),
               '════════════════════════════════════════════════'];
  var pass = 0, fail = 0;

  // Each entry: [label, fnName]. We call by name so a missing module is reported
  // rather than throwing. A self-test "passes" if it runs without throwing and
  // its output contains no '✗'.
  var tests = [
    ['Utils',                 'UTILS_selfTest'],
    ['Config',                'CFG_selfTest'],
    ['Bootstrap',             'BOOTSTRAP_selfTest'],
    ['Email Queue (dry run)', 'QUEUE_selfTest'],
    ['Errors & Logs',         'ERRORS_selfTest'],
    ['Dropdown actions',      'DROPDOWN_selfTest'],
    ['Scoring',               'SCORING_selfTest'],
    ['Deterministic risk',    'DETERMINISTIC_RISK_selfTest'],
    ['Override log',          'OVERRIDE_selfTest'],
    ['Transcript sources',    'TRANSCRIPT_SOURCES_selfTest'],
    ['Assessment engine',     'ASSESSMENT_selfTest'],
    ['Job postings',          'JOBPOSTINGS_selfTest'],
    ['Dashboard',             'DASHBOARD_selfTest'],
    ['Triggers',              'TRIGGERS_selfTest'],
    ['AI JSON contract',      'testAiJsonContract']
  ];

  lines.push('', '── Subsystem self-tests ──');
  tests.forEach(function (t) {
    var label = t[0], fnName = t[1];
    var fn = _verifyResolveFn_(fnName);
    if (!fn) { lines.push('  – ' + label + ' — SKIPPED (' + fnName + ' not found)'); return; }
    try {
      var out = String(fn() || '');
      var bad = out.indexOf('✗') !== -1;
      if (bad) { fail++; lines.push('  ✗ ' + label + ' — see ' + fnName + ' output (has failures)'); }
      else     { pass++; lines.push('  ✓ ' + label); }
    } catch (e) {
      fail++; lines.push('  ✗ ' + label + ' THREW: ' + (e && e.message ? e.message : e));
    }
  });

  lines.push('', '── Wiring & data checks ──');
  function check(label, okFn) {
    try { var ok = !!okFn(); (ok ? pass++ : fail++); lines.push('  ' + (ok ? '✓' : '✗') + ' ' + label); return ok; }
    catch (e) { fail++; lines.push('  ✗ ' + label + ' THREW: ' + e.message); return false; }
  }
  check('Full trigger set installed', function () { return assertTriggerSet_().ok; });
  check('Email-queue 15-min flush trigger present', function () {
    return ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'flushEmailQueue';
    });
  });
  check('No recoverable BLOCKED email left', function () { return queueBlockedCount_() === 0; });
  check('Risk Flags sheet exists', function () { return !!getSheetOrNull_(SHEETS.RISK_FLAGS); });
  check('A transcript source is Active', function () {
    var sh = getSheetOrNull_(SHEETS.TRANSCRIPT_SOURCES);
    if (!sh) return false;
    var c = getColIndex_(sh, 'Active'); if (!c) return false;
    var last = sh.getLastRow(); if (last < 2) return false;
    var v = sh.getRange(2, c, last - 1, 1).getValues();
    return v.some(function (r) { return String(r[0]).trim().toUpperCase() === 'TRUE'; });
  });
  check('Gemini key present (or AI disabled)', function () {
    return !CFG.getBool('AI_GRADING_ENABLED', true) || hasSecret_(SECRETS.GEMINI_API_KEY);
  });

  lines.push('', '── Live health check ──');
  try { lines.push(_indent_(runHealthCheck())); } catch (e) { lines.push('  ✗ runHealthCheck threw: ' + e.message); fail++; }

  lines.push('', '════════════════════════════════════════════════');
  lines.push(' RESULT: ' + pass + ' passed, ' + fail + ' failed/needs-attention, in ' +
             Math.round((Date.now() - t0) / 1000) + 's.');
  lines.push('════════════════════════════════════════════════');

  var msg = lines.join('\n');
  Logger.log(msg);
  _verifyWriteReport_(msg);
  logEvent_('VERIFY_RUN_ALL', '', { pass: pass, fail: fail });
  toast_('Verification: ' + pass + ' passed, ' + fail + ' need attention. See "Verification Report" tab.', 'Recruiting OS', 12);
  return msg;
}

function _verifyResolveFn_(name) {
  try { return (eval('typeof ' + name) === 'function') ? eval(name) : null; }
  catch (e) { return null; }
}

function _indent_(s) {
  return String(s || '').split('\n').map(function (l) { return '    ' + l; }).join('\n');
}

function _verifyWriteReport_(msg) {
  try {
    var ss = SpreadsheetApp.getActive();
    var name = 'Verification Report';
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.insertRowsBefore(1, 1);
    sh.getRange(1, 1).setValue(msg).setWrap(false);
    sh.setColumnWidth(1, 1000);
  } catch (e) { Logger.log('[_verifyWriteReport_] ' + e); }
}
