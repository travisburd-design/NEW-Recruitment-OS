/**
 * 19_Health_Check.gs
 * Frank's European Service — Recruiting OS
 *
 * Two health checks:
 *   runHealthCheck()             — lenient; returns READY or list of warnings
 *   productionReadinessCheck()   — strict; gates goLive(); fails on any blocker
 *
 * Checks performed:
 *   Sheets — all 22 manifest sheets present
 *   Config — critical keys non-empty
 *   Secrets — GEMINI_API_KEY present
 *   Forms  — Form Registry verify passes
 *   Triggers — expected handler functions installed
 *   Email mode — SYSTEM_MODE + SEND_ENABLED + TEST_RECIPIENT_EMAIL consistent
 *   Calendar — INTERVIEW_CALENDAR_ID opens
 *   Gemini — single live ping returns valid JSON
 */

function runHealthCheck() {
  return _runChecks_(/*strict=*/false);
}

function productionReadinessCheck() {
  return _runChecks_(/*strict=*/true);
}

function _runChecks_(strict) {
  var out = ['[HEALTH] ' + (strict ? 'productionReadinessCheck' : 'runHealthCheck') + ' starting…'];
  var blockers = [];
  var warnings = [];
  function ok(label)            { out.push('  ✓ ' + label); }
  function warn(label, msg)     { out.push('  ⚠ ' + label + (msg ? ' — ' + msg : '')); warnings.push(label + (msg ? ': ' + msg : '')); }
  function bad(label, msg)      { out.push('  ✗ ' + label + (msg ? ' — ' + msg : '')); blockers.push(label + (msg ? ': ' + msg : '')); }

  // ── 1. SHEETS
  var missing = [];
  SHEET_MANIFEST.forEach(function (s) { if (!getSheetOrNull_(s.name)) missing.push(s.name); });
  if (missing.length === 0) ok('All ' + SHEET_MANIFEST.length + ' canonical sheets present');
  else bad('Missing sheets', missing.join(', ') + '. Run bootstrapSystem().');

  // ── 2. CONFIG critical keys
  ['SYSTEM_MODE', 'TEST_RECIPIENT_EMAIL', 'HIRING_MANAGER_EMAIL', 'GEMINI_MODEL', 'SHOP_NAME'].forEach(function (k) {
    var v = CFG.get(k);
    if (v && String(v).trim()) ok('Config key ' + k + ' = ' + truncate_(String(v), 60));
    else bad('Config key empty', k);
  });

  // ── 3. SECRETS
  if (hasSecret_(SECRETS.GEMINI_API_KEY)) ok('Script Property GEMINI_API_KEY present');
  else bad('Script Property missing', 'GEMINI_API_KEY (Project Settings → Script Properties)');

  // ── 4. FORMS
  var keys = getActiveFormKeys_();
  if (keys.length === 0) bad('Form Registry empty', 'no active forms');
  else {
    var formMissing = [];
    keys.forEach(function (k) {
      if (!getFormEditId_(k)) formMissing.push(k + ' (Edit ID blank)');
    });
    if (formMissing.length === 0) ok(keys.length + ' active forms have Edit IDs');
    else bad('Forms missing Edit IDs', formMissing.join(', '));
  }

  // ── 5. TRIGGERS — F10: assert the FULL expected trigger set is installed, so a
  // dead/missing trigger is visible rather than masked by checking only a few.
  var triggers = ScriptApp.getProjectTriggers();
  var installedFns = {};
  triggers.forEach(function (t) { installedFns[t.getHandlerFunction()] = true; });
  var expected = (typeof EXPECTED_TRIGGER_HANDLERS !== 'undefined') ? EXPECTED_TRIGGER_HANDLERS
               : ['onPipelineEdit', 'runDailyDigest', 'processRawOtterIntake', 'flushEmailQueue'];
  var trgMissing = expected.filter(function (fn) { return !installedFns[fn]; });
  if (trgMissing.length === 0) ok('All ' + expected.length + ' expected triggers installed');
  else (strict ? bad : warn)('Triggers missing', trgMissing.join(', ') + ' — run installAllTriggers()');

  // ── 6. EMAIL MODE
  var mode = String(CFG.get('SYSTEM_MODE')).toUpperCase();
  var sendOn = sendEnabled_();
  var testTo = String(CFG.get('TEST_RECIPIENT_EMAIL') || '').trim();
  if (mode === 'TEST' || mode === 'LIVE') ok('SYSTEM_MODE = ' + mode);
  else bad('SYSTEM_MODE invalid', 'must be TEST or LIVE; got ' + mode);
  if (sendOn) ok('SEND_ENABLED = TRUE');
  else warn('SEND_ENABLED = FALSE', 'all emails queue as BLOCKED — set TRUE to send');
  if (mode === 'TEST' && !testTo) bad('TEST_RECIPIENT_EMAIL blank', 'TEST mode cannot route emails');
  else if (mode === 'TEST') ok('TEST recipient = ' + testTo);

  // Pause mode: always a warning, never a blocker. Going LIVE with Hiring Pause
  // ON is a deliberate, supported "soft launch" — the full pipeline runs and
  // scores real candidates while only the "not currently hiring" reply goes out
  // (no booking emails) until Mode → Disable Hiring Pause is run. Blocking
  // go-live on it would make that workflow impossible.
  var pauseOn = CFG.getBool('HIRING_PAUSE_MODE', false);
  if (!pauseOn) ok('HIRING_PAUSE_MODE = OFF (normal routing active)');
  else warn(
    'HIRING_PAUSE_MODE is ON',
    'soft launch — new pre-screen completions get "not currently hiring" and no booking emails send; run Mode → Disable Hiring Pause to resume normal routing'
  );

  // ── 7. CALENDAR (warn-only — calendar polling is a non-critical enhancement)
  var calId = CFG.get('INTERVIEW_CALENDAR_ID');
  if (!calId) warn('INTERVIEW_CALENDAR_ID blank', 'calendar polling disabled until set');
  else {
    try {
      var cal = CalendarApp.getCalendarById(calId);
      if (cal) ok('Calendar accessible: ' + cal.getName());
      else warn('Calendar not found', calId.substring(0, 30) + '… — run CALENDAR_diagnose() to find the right ID. Core pipeline OK without this.');
    } catch (e) { warn('Calendar open failed', e.message + ' — non-blocking'); }
  }

  // ── 8. GEMINI (single ping)
  if (CFG.getBool('AI_GRADING_ENABLED', true) && hasSecret_(SECRETS.GEMINI_API_KEY)) {
    try {
      var ping = _geminiGradeJson_('healthcheck', '', 'Return JSON: {"ok": true}');
      if (ping.ok) ok('Gemini ping OK');
      else bad('Gemini ping failed', ping.error);
    } catch (e) {
      bad('Gemini ping threw', e.message);
    }
  } else {
    warn('Gemini ping skipped', 'AI_GRADING_ENABLED off or no key');
  }

  // ── 9. AI JSON CONTRACT (strict blocker — parser + live JSON round-trip)
  if (typeof testAiJsonContractResult_ === 'function') {
    try {
      var contract = testAiJsonContractResult_();
      if (contract.ok) ok('AI JSON contract passes (clean / fenced / prose / invalid-fallback + live JSON)');
      else (strict ? bad : warn)('AI JSON contract failed', 'run testAiJsonContract() — see log');
    } catch (e) { (strict ? bad : warn)('AI JSON contract threw', e.message); }
  }

  // ── 10. BACKFILL READINESS
  var acSheet = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (acSheet) {
    var acHeaders = getHeaderRow_(acSheet);
    if (acHeaders.indexOf('Candidate ID') === -1) bad('All Candidates missing Candidate ID column', 'backfill cannot run');
    else {
      ok('All Candidates has Candidate ID column');
      var blankIds = 0, last = acSheet.getLastRow();
      if (last >= 2) {
        var iCid = acHeaders.indexOf('Candidate ID'), iEmail = acHeaders.indexOf('Email');
        var rows = acSheet.getRange(2, 1, last - 1, acHeaders.length).getValues();
        rows.forEach(function (r) {
          var hasEmail = iEmail === -1 ? true : String(r[iEmail] || '').trim();
          if (hasEmail && !String(r[iCid] || '').trim()) blankIds++;
        });
      }
      if (blankIds === 0) ok('No blank Candidate IDs in All Candidates');
      else (strict ? bad : warn)('Blank Candidate IDs', blankIds + ' row(s) — run runFullBackfillRepair()');
    }
  }

  // ── 11. ROLE NORMALIZATION — no active duplicate canonical role rules
  var rr = getSheetOrNull_(SHEETS.ROLE_RULES);
  if (rr && rr.getLastRow() >= 2 && typeof normalizeRole_ === 'function') {
    var rrHeaders = getHeaderRow_(rr);
    var iRole = rrHeaders.indexOf('Role'), iActive = rrHeaders.indexOf('Active');
    if (iRole !== -1) {
      var activeByCanon = {}, dups = [];
      rr.getRange(2, 1, rr.getLastRow() - 1, rrHeaders.length).getValues().forEach(function (r) {
        var active = iActive === -1 ? true : String(r[iActive]).trim().toUpperCase() === 'TRUE';
        if (!active) return;
        var canon = normalizeRole_(r[iRole]);
        activeByCanon[canon] = (activeByCanon[canon] || 0) + 1;
        if (activeByCanon[canon] === 2) dups.push(canon);
      });
      if (dups.length === 0) ok('No active duplicate role rules');
      else (strict ? bad : warn)('Active duplicate role rules', dups.join(', ') + ' — run runRoleNormalizationRepair()');
    }
  }

  // ── 12. NEW SUBSYSTEM SHEETS + CONFIG
  [SHEETS.INTERVIEW_WORKSHEETS, SHEETS.RAW_HIRING_EMAIL_LEADS, SHEETS.BACKFILL_REVIEW].forEach(function (n) {
    if (getSheetOrNull_(n)) ok('Sheet present: ' + n);
    else bad('Sheet missing', n + ' — run bootstrapSystem()');
  });
  ['WORKSHEET_EMAIL_HOUR', 'HIRING_GMAIL_LEAD_IMPORT_ENABLED', 'INDEED_GMAIL_QUERY', 'ACT_AUTO_STAFFING_GMAIL_QUERY'].forEach(function (k) {
    if (String(CFG.get(k) || '').trim()) ok('Config key ' + k + ' set');
    else (strict ? bad : warn)('Config key empty', k);
  });
  var wsTrig = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runWorksheetDigest'; });
  if (wsTrig) ok('runWorksheetDigest trigger installed');
  else (strict ? bad : warn)('runWorksheetDigest trigger missing', 'run installAllTriggers()');

  // ── VERDICT
  // Blockers prevent go-live. Warnings do not.
  var verdict;
  if (blockers.length === 0) {
    verdict = strict ? 'PRODUCTION READY' : 'READY';
    if (warnings.length > 0) verdict += ' (with ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + ')';
  } else {
    verdict = (strict ? 'NOT READY' : 'BLOCKERS') + ' — ' + blockers.length + ' blocker(s)';
  }

  out.push('');
  out.push('[HEALTH] VERDICT: ' + verdict);
  if (blockers.length) out.push('  BLOCKERS:\n    · ' + blockers.join('\n    · '));
  if (warnings.length) out.push('  WARNINGS:\n    · ' + warnings.join('\n    · '));

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
