/**
 * 36_Manager_Console.gs
 * Frank's European Service — Recruiting OS
 *
 * Makes the OS obvious. Most of the system already runs on timers (18_Triggers),
 * so the manager rarely needs to "run" anything — but when they want to be sure
 * everything is current and see what's on their plate, this is the one button.
 *
 * Public functions:
 *   catchMeUp()                   — re-sync everything now + show "your day" popup
 *   processSelectedCandidateRow() — force the selected candidate through every step
 *   auditSystemData()             — audit Config keys + every tab (empty/missing)
 *   MYDAY_summaryText_()          — shared "what you need today" text (popup + …)
 */

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ CATCH ME UP — the one button to press anytime you feel behind
// ─────────────────────────────────────────────────────────────────────────────
function catchMeUp() {
  return safeRun_('catchMeUp', function () {
    var steps = [];
    function run(label, fn) {
      try { fn(); steps.push('✓ ' + label); }
      catch (e) { steps.push('✗ ' + label + ' — ' + e.message); }
    }

    toast_('Catching up… syncing calendar, transcripts, scores…', 'Recruiting OS', 8);
    run('Checked calendar for new bookings',        function () { if (typeof pollCalendarBookings === 'function') pollCalendarBookings(); });
    run('Imported new Otter transcripts',           function () { if (typeof processRawOtterIntake === 'function') processRawOtterIntake(); });
    run('Graded pending interview transcripts',     function () { if (typeof gradePendingTranscripts === 'function') gradePendingTranscripts(); });
    run('Recomputed recommendations',               function () { if (typeof updateRecommendationEngineForAll === 'function') updateRecommendationEngineForAll(); });
    run("Generated & sent today's worksheets",      function () { if (typeof generateAndSendWorksheetsForToday === 'function') generateAndSendWorksheetsForToday(); });

    logEvent_('CATCH_ME_UP', '', { steps: steps.length });

    var body = MYDAY_summaryText_() +
      '\n\n────────────  just synced  ────────────\n' + steps.join('\n');
    try {
      SpreadsheetApp.getUi().alert('☀️  Your Day — ' + shopDate_(), body, SpreadsheetApp.getUi().ButtonSet.OK);
    } catch (e) {
      // No UI context (e.g. run from editor) — fall back to log/toast.
      Logger.log(body);
      toast_('Caught up — see execution log for your day summary', 'Recruiting OS', 8);
    }
    return body;
  });
}

/**
 * Shared "what you need today" summary. Reused by the catch-up popup and safe to
 * surface elsewhere. Reads the same data the digest uses.
 */
function MYDAY_summaryText_() {
  var lines = [];

  var iv   = (typeof _digestTodaysInterviews_ === 'function') ? _digestTodaysInterviews_() : [];
  var kpis = (typeof _digestKpis_ === 'function') ? _digestKpis_() : [];
  function kpi(label) {
    for (var i = 0; i < kpis.length; i++) { if (kpis[i].label === label) return kpis[i].value; }
    return '—';
  }

  lines.push('📅  INTERVIEWS TODAY: ' + iv.length);
  iv.slice(0, 12).forEach(function (x) {
    var sent = String(x.emailStatus || '').toUpperCase().indexOf('SENT') !== -1;
    lines.push('     • ' + (x.time ? x.time + ' — ' : '') + (x.name || '?') +
      '  (' + (x.role || '') + (x.type ? ' · ' + x.type : '') + ')' +
      (sent ? '' : '   ⚠ worksheet not yet sent'));
  });
  if (iv.length === 0) lines.push('     (none scheduled)');

  lines.push('');
  lines.push('📝  NEED YOUR DECISION: ' + kpi('Pending decisions') + '   →  set a "Manager Decision" on the Interview Pipeline tab');
  lines.push('🆕  NEW APPLICANTS TODAY: ' + kpi('New today'));
  lines.push('⏳  STUCK (no update >' + CFG.getInt('STUCK_CANDIDATE_DAYS', 5) + 'd): ' + kpi('Stuck candidates'));
  lines.push('');
  lines.push('Everything else (scoring, transcript grading, booking detection) runs automatically.');
  lines.push('Your full breakdown is in the twice-daily digest email.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS ONE CANDIDATE NOW — force the selected row through every step
// ─────────────────────────────────────────────────────────────────────────────
function processSelectedCandidateRow() {
  return safeRun_('processSelectedCandidateRow', function () {
    var ui = SpreadsheetApp.getUi();
    var sh = SpreadsheetApp.getActive().getActiveSheet();
    var name = sh.getName();
    if (name !== SHEETS.INTERVIEW_PIPELINE && name !== SHEETS.ALL_CANDIDATES) {
      ui.alert('Pick a candidate first',
        'Click any cell in the candidate\'s row on the "' + SHEETS.INTERVIEW_PIPELINE +
        '" or "' + SHEETS.ALL_CANDIDATES + '" tab, then run this again.', ui.ButtonSet.OK);
      return;
    }
    var row = sh.getActiveRange().getRow();
    if (row < 2) { ui.alert('Select a candidate row (not the header row).'); return; }

    var headers = getHeaderRow_(sh);
    var cidCol = headers.indexOf('Candidate ID');
    if (cidCol === -1) { ui.alert('This tab has no Candidate ID column.'); return; }
    var cid = String(sh.getRange(row, cidCol + 1).getValue() || '').trim();
    if (!cid) { ui.alert('That row has no Candidate ID yet — run Bootstrap / Backfill first.'); return; }

    var steps = [];
    function run(label, fn) {
      try { fn(); steps.push('✓ ' + label); }
      catch (e) { steps.push('✗ ' + label + ' — ' + e.message); }
    }

    run('Re-scored pre-screen + routed',              function () { if (typeof rescoreCandidate === 'function') rescoreCandidate(cid); });
    run('Ensured candidate is in Interview Pipeline',  function () { if (typeof _ensureInterviewPipelineRow_ === 'function') _ensureInterviewPipelineRow_(cid, { via: 'manual' }); });
    run('Graded any pending transcripts',             function () { if (typeof gradePendingTranscripts === 'function') gradePendingTranscripts(); });
    run('Recomputed recommendation',                  function () { if (typeof computeFinalRecommendation_ === 'function') computeFinalRecommendation_(cid); });

    logEvent_('PROCESS_SELECTED_CANDIDATE', cid, { steps: steps.length });
    ui.alert('Processed ' + cid, steps.join('\n') + '\n\nRe-select the row to see the refreshed scores/status.', ui.ButtonSet.OK);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM AUDIT — Config keys + every tab (which are empty, which shouldn't be)
// ─────────────────────────────────────────────────────────────────────────────

// Tabs that are SUPPOSED to hold reference data. Empty here = a real problem
// (seed/setup wasn't run). Every other manifest tab is a log / queue / response /
// archive that is legitimately empty until activity flows through it.
function _AUDIT_dataExpectedTabs_() {
  return [
    SHEETS.CONFIG, SHEETS.ROLE_RULES, SHEETS.HIRING_MANAGERS, SHEETS.FORM_REGISTRY,
    SHEETS.JOB_POSTINGS, SHEETS.EMAIL_TEMPLATES, SHEETS.AI_PROMPTS, SHEETS.AI_RUBRICS,
    SHEETS.ASSESSMENT_REGISTRY, SHEETS.ASSESSMENT_QUESTION_BANK, SHEETS.ASSESSMENT_RUBRICS
  ];
}

function auditSystemData() {
  return safeRun_('auditSystemData', function () {
    var report = ['[AUDIT] System data audit — ' + shopDateTime_(), ''];
    var problems = [];

    // ── 1. CONFIG: read the Config tab directly (not CFG.get, which masks blanks)
    report.push('═══ CONFIG ═══');
    var cfgSheet = getSheetOrNull_(SHEETS.CONFIG);
    if (!cfgSheet || cfgSheet.getLastRow() < 2) {
      problems.push('Config tab is missing or empty — run Bootstrap / Seed All Templates.');
      report.push('  ✗ Config tab missing/empty');
    } else {
      var ch = getHeaderRow_(cfgSheet);
      var kCol = ch.indexOf('KEY'), vCol = ch.indexOf('VALUE');
      var present = {};
      if (kCol !== -1) {
        cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, ch.length).getValues().forEach(function (r) {
          var k = String(r[kCol] || '').trim();
          if (k) present[k] = String(vCol !== -1 ? (r[vCol] == null ? '' : r[vCol]) : '').trim();
        });
      }
      var defKeys = Object.keys(CFG_DEFAULTS);
      var missing = [], blank = [];
      defKeys.forEach(function (k) {
        if (!(k in present)) { missing.push(k); return; }
        if (present[k] === '' && String(CFG_DEFAULTS[k]) !== '') blank.push(k);
      });
      report.push('  ─ ' + defKeys.length + ' expected keys; ' + Object.keys(present).length + ' present in Config tab');
      if (missing.length) { report.push('  ⚠ ' + missing.length + ' default key(s) not in Config tab (CFG.get still uses code defaults): ' + missing.slice(0, 30).join(', ')); }
      if (blank.length)   { report.push('  ⚠ ' + blank.length + ' key(s) blank in Config tab but expected non-blank: ' + blank.join(', '));
                            problems.push(blank.length + ' Config value(s) blank: ' + blank.slice(0, 12).join(', ')); }
      if (!missing.length && !blank.length) report.push('  ✓ All default keys present and populated');
    }

    // ── 2. TABS: row counts; flag empties that SHOULDN'T be empty
    report.push('', '═══ TABS ═══');
    var dataExpected = {};
    _AUDIT_dataExpectedTabs_().forEach(function (n) { dataExpected[n] = true; });

    var emptyConcern = [], emptyOk = [], missingTabs = [];
    (typeof SHEET_MANIFEST !== 'undefined' ? SHEET_MANIFEST : []).forEach(function (spec) {
      var nm = spec.name;
      var sh = getSheetOrNull_(nm);
      if (!sh) { missingTabs.push(nm); report.push('  ✗ MISSING: ' + nm); return; }
      var rows = Math.max(0, sh.getLastRow() - 1);
      var tag;
      if (rows > 0) tag = '  ✓ ' + rows + ' row(s)  — ' + nm;
      else if (dataExpected[nm]) { tag = '  ⚠ EMPTY (needs data): ' + nm; emptyConcern.push(nm); }
      else { tag = '  · empty (normal — fills with activity): ' + nm; emptyOk.push(nm); }
      report.push(tag);
    });
    if (missingTabs.length) problems.push(missingTabs.length + ' tab(s) MISSING: ' + missingTabs.join(', ') + ' — run Bootstrap.');
    if (emptyConcern.length) problems.push(emptyConcern.length + ' reference tab(s) EMPTY: ' + emptyConcern.join(', ') + ' — run Seed All Templates / fill manually.');

    // ── 3. VERDICT
    report.push('', '═══ SUMMARY ═══');
    report.push('  Empty-but-OK (logs/queues/responses): ' + emptyOk.length + '  ·  these are normal until activity flows.');
    var verdict = problems.length ? ('⚠ ' + problems.length + ' issue(s) need attention') : '✓ All reference data present; no problems found';
    report.push('  VERDICT: ' + verdict);

    var full = report.join('\n');
    Logger.log(full);
    logEvent_('SYSTEM_AUDIT', '', { problems: problems.length, missingTabs: missingTabs.length, emptyConcern: emptyConcern.length });

    // Dialog: lead with problems (or all-clear), point to the log for the full table.
    var dialog = problems.length
      ? '⚠ Issues to fix:\n\n• ' + problems.join('\n• ') +
        '\n\n(Empty log/queue tabs are normal and not listed.)\n\nFull per-tab breakdown is in the Apps Script execution log.'
      : '✓ All clear.\n\nEvery reference tab has data, all Config keys are populated, and no tabs are missing. Empty log/queue/response tabs are normal until activity flows.\n\nFull per-tab breakdown is in the execution log.';
    try { SpreadsheetApp.getUi().alert('🔎  System Data Audit', dialog, SpreadsheetApp.getUi().ButtonSet.OK); }
    catch (e) { toast_('Audit done — see execution log', 'Recruiting OS', 8); }
    return full;
  });
}
