/**
 * 48_V2_Install.gs
 * Frank's European Service — Recruiting OS
 *
 * ONE-BUTTON INSTALL + VERIFY for the V2 grading / auto-advance / console set.
 *
 * Run V2_INSTALL() once after pasting files 43–47. It is idempotent: safe to
 * re-run any number of times. It never touches candidate data — it only seeds
 * Config keys, adds columns, installs the prompt and triggers, and reports.
 *
 * Then run V2_VERIFY() to get a pass/fail readout of the whole set.
 *
 * Public functions:
 *   V2_INSTALL()   — seed config, add columns, install prompt + triggers
 *   V2_VERIFY()    — full pass/fail check of every V2 subsystem
 *   V2_GO()        — install, verify, then re-score the open roles
 */

// New Config rows. Existing values are NEVER overwritten.
var V2_CONFIG_DEFAULTS = Object.freeze({
  GRADING_V2_ENABLED:            'TRUE',
  AUTO_ADVANCE_LIVE_ENABLED:     'TRUE',
  AUTO_ADVANCE_HOLD_MINUTES:     '60',
  AUTO_ADVANCE_LIVE_MIN_SCORE:   '0',      // 0 = use the role's auto-booking bar
  AUTO_ADVANCE_LIVE_MAX_RISK:    '4',
  WEBAPP_ALLOWED_EMAILS:         '',
  ASSESSMENT_COMPOSITE_WEIGHT:   '0.10'
});

// Columns added to All Candidates so the V2 grade is visible in the sheet.
var V2_NEW_CANDIDATE_COLUMNS = Object.freeze([
  'Strengths', 'Concerns', 'Credibility Score', 'Confidence', 'Recommended Next Step'
]);

// New Role Rules column: the live-interview bar, per role.
var V2_NEW_ROLE_RULE_COLUMNS = Object.freeze(['Auto Advance Live Minimum Score']);

// ─────────────────────────────────────────────────────────────────────────────

function V2_INSTALL() {
  var steps = [];
  function step(label, fn) {
    try { var r = fn(); steps.push('✓ ' + label + (r ? ' — ' + r : '')); }
    catch (e) { steps.push('✗ ' + label + ' — ' + e.message); }
  }

  step('Seeded V2 Config keys', function () {
    var sh = getSheet_(SHEETS.CONFIG);
    var headers = getHeaderRow_(sh);
    var cKey = headers.indexOf('KEY') >= 0 ? headers.indexOf('KEY') : headers.indexOf('Key');
    var cVal = headers.indexOf('VALUE') >= 0 ? headers.indexOf('VALUE') : headers.indexOf('Value');
    if (cKey < 0 || cVal < 0) throw new Error('Config tab has no KEY/VALUE columns');
    var existing = {};
    if (sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
        existing[String(r[cKey] || '').trim()] = true;
      });
    }
    var added = 0;
    Object.keys(V2_CONFIG_DEFAULTS).forEach(function (k) {
      if (existing[k]) return;
      var row = new Array(headers.length).fill('');
      row[cKey] = k; row[cVal] = V2_CONFIG_DEFAULTS[k];
      var cNotes = headers.indexOf('NOTES') >= 0 ? headers.indexOf('NOTES') : headers.indexOf('Notes');
      var cSec = headers.indexOf('SECTION') >= 0 ? headers.indexOf('SECTION') : headers.indexOf('Section');
      if (cNotes >= 0) row[cNotes] = 'V2 grading / auto-advance / console';
      if (cSec >= 0) row[cSec] = 'V2 Automation';
      sh.appendRow(row); added++;
    });
    if (typeof CFG.reset === 'function') CFG.reset();   // force re-read of Config
    return added + ' key(s) added, ' + (Object.keys(V2_CONFIG_DEFAULTS).length - added) + ' already present';
  });

  step('Added V2 columns to All Candidates', function () {
    return V2_addColumns_(getSheet_(SHEETS.ALL_CANDIDATES), V2_NEW_CANDIDATE_COLUMNS);
  });

  step('Added live-interview bar column to Role Rules', function () {
    return V2_addColumns_(getSheet_(SHEETS.ROLE_RULES), V2_NEW_ROLE_RULE_COLUMNS);
  });

  step('Created Grade Detail tab', function () {
    getOrCreateSheet_(GRADE_DETAIL_SHEET, GRADE_DETAIL_HEADERS);
    return GRADE_DETAIL_SHEET;
  });

  step('Created Auto Advance Queue tab', function () {
    getOrCreateSheet_(AUTOADV_SHEET, AUTOADV_HEADERS);
    return AUTOADV_SHEET;
  });

  step('Installed rubric-anchored prescreen prompt', function () { return GRADE_installV2Prompt(); });

  step('Repaired Form Registry pre-screen tab pointer', function () { return PS_repairFormRegistry(); });

  step('Installed auto-advance trigger', function () { return AUTOADV_installTrigger(); });

  var report = ['════ RECRUITING OS — V2 INSTALL — ' + shopDateTime_() + ' ════']
    .concat(steps)
    .concat(['', 'Next: run V2_VERIFY(), then RESCORE_openRoles().']);
  var msg = report.join('\n');
  Logger.log(msg);
  logEvent_('V2_INSTALL', '', { steps: steps.length });
  try {
    SpreadsheetApp.getUi().alert('Recruiting OS — V2 Install', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { try { toast_('V2 install complete — see log', 'Recruiting OS', 8); } catch (e2) {} }
  return msg;
}

/** Append any missing headers to a sheet, preserving existing data. */
function V2_addColumns_(sheet, cols) {
  var headers = getHeaderRow_(sheet);
  var lower = headers.map(function (h) { return String(h || '').trim().toLowerCase(); });
  var toAdd = cols.filter(function (c) { return lower.indexOf(c.toLowerCase()) === -1; });
  if (!toAdd.length) return 'all present';
  var start = headers.length + 1;
  sheet.insertColumnsAfter(headers.length, toAdd.length);
  sheet.getRange(1, start, 1, toAdd.length).setValues([toAdd]).setFontWeight('bold');
  return 'added ' + toAdd.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────────────────────

function V2_VERIFY() {
  var out = ['════ RECRUITING OS — V2 VERIFY — ' + shopDateTime_() + ' ════'];
  var pass = 0, fail = 0, warn = 0;
  function check(label, fn) {
    try {
      var r = fn();
      if (r === true)       { out.push('✓ ' + label); pass++; }
      else if (r === false) { out.push('✗ ' + label); fail++; }
      else if (r && r.warn) { out.push('⚠ ' + label + ' — ' + r.warn); warn++; }
      else                  { out.push('✓ ' + label + ' — ' + r); pass++; }
    } catch (e) { out.push('✗ ' + label + ' — ' + e.message); fail++; }
  }

  out.push('── Pre-screen source discovery ──');
  check('Pre-screen response tab(s) discovered', function () {
    PS_clearCache_();
    var tabs = PS_discoverPreScreenTabs_();
    if (!tabs.length) return false;
    return tabs.length + ' tab(s): ' + tabs.map(function (t) { return t.name + '(' + t.rows + ')'; }).join(', ');
  });
  check('Candidates recoverable by multi-tab lookup', function () {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    if (ac.getLastRow() < 2) return { warn: 'no candidates' };
    var headers = getHeaderRow_(ac);
    var cEmail = headers.indexOf('Email');
    var data = ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues();
    // In-memory set comparison — a handful of tab reads total, never one read
    // per candidate (the per-candidate pattern caused Sheets service timeouts).
    var newSet = PS_emailSetAllTabs_();
    var oldSet = PS_emailSetLegacyTab_();
    var oldN = 0, newN = 0;
    data.forEach(function (r) {
      var em = normalizeEmail_(r[cEmail]); if (!em) return;
      if (oldSet[em]) oldN++;
      if (newSet[em]) newN++;
    });
    return 'old lookup matched ' + oldN + ', new lookup matches ' + newN + ' (+' + (newN - oldN) + ')';
  });

  out.push('── Rubric-anchored grading ──');
  check('Rubric rows load for key "prescreen"', function () {
    var rb = GRADE_buildRubricBlock_('prescreen');
    if (!rb.categories.length) return false;
    return rb.categories.length + ' categories, total weight ' + rb.totalWeight;
  });
  check('Prompt contains {{Rubric}} merge field', function () {
    var p = _loadAiPrompt_('prescreen');
    return !!(p && String(p['Prompt Body'] || '').indexOf('{{Rubric}}') !== -1);
  });
  check('Prompt contains {{RoleContext}} merge field', function () {
    var p = _loadAiPrompt_('prescreen');
    return !!(p && String(p['Prompt Body'] || '').indexOf('{{RoleContext}}') !== -1);
  });
  check('Role context is populated for open roles', function () {
    var bad = [];
    ['Technician', 'Service Advisor'].forEach(function (role) {
      var rr = _getRoleRule_(role);
      if (!rr) { bad.push(role + ' has no Role Rules row'); return; }
      var yrs = rr['Minimum Experience Years'];
      if (yrs === '' || yrs === null || yrs === undefined) bad.push(role + ' has no Minimum Experience Years');
    });
    return bad.length ? { warn: bad.join('; ') } : true;
  });
  check('Weighted-score math', function () {
    var rb = GRADE_buildRubricBlock_('prescreen');
    if (!rb.categories.length) return false;
    var all10 = rb.categories.map(function (c) { return { category: c.category, score: 10 }; });
    var all0  = rb.categories.map(function (c) { return { category: c.category, score: 0 }; });
    var hi = GRADE_computeWeightedScore_(all10, rb.categories).score;
    var lo = GRADE_computeWeightedScore_(all0, rb.categories).score;
    if (hi !== 100 || lo !== 0) return false;
    return 'all-10 → 100, all-0 → 0';
  });
  check('Gemini API key present', function () { return hasSecret_(SECRETS.GEMINI_API_KEY); });
  check('Live AI JSON contract', function () {
    if (typeof testAiJsonContractResult_ !== 'function') return { warn: 'contract test unavailable' };
    var r = testAiJsonContractResult_();
    return r.ok ? true : { warn: 'AI contract test reported problems — see AI Grading Logs' };
  });

  out.push('── Routing ──');
  check('Risk ceiling blocks a high-score/high-risk auto-book', function () {
    var rr = _getRoleRule_('Service Advisor');
    var r = ROUTE_v2_(95, 9, rr, { failed: false, reasons: [] });
    return r.action === 'MANUAL_REVIEW' ? 'score 95 / risk 9 → MANUAL_REVIEW (correct)' : false;
  });
  check('Hard gate blocks an auto-book', function () {
    var rr = _getRoleRule_('Technician');
    var r = ROUTE_v2_(95, 0, rr, { failed: true, reasons: ['1 yr < 3 yr minimum'] });
    return r.action === 'MANUAL_REVIEW' ? 'gated 95 → MANUAL_REVIEW (correct)' : false;
  });
  check('Clean high scorer still auto-books', function () {
    var rr = _getRoleRule_('Service Advisor');
    var r = ROUTE_v2_(90, 1, rr, { failed: false, reasons: [] });
    return r.action === 'AUTO_BOOK' ? '90 / risk 1 → AUTO_BOOK (correct)' : false;
  });
  check('Below-floor scorer is declined', function () {
    var rr = _getRoleRule_('Service Advisor');
    var r = ROUTE_v2_(20, 1, rr, { failed: false, reasons: [] });
    return r.action === 'HARD_REJECT' ? '20 → HARD_REJECT (correct)' : false;
  });

  out.push('── Auto-advance ──');
  check('AUTO_ADVANCE_LIVE_ENABLED', function () { return CFG.getBool('AUTO_ADVANCE_LIVE_ENABLED', true); });
  check('AUTOADV_run trigger installed', function () {
    return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'AUTOADV_run'; });
  });
  check('Auto Advance Queue tab exists', function () { return !!getSheetOrNull_(AUTOADV_SHEET); });

  out.push('── Hiring console ──');
  check('doGet is defined', function () { return typeof doGet === 'function'; });
  check('Console decision labels resolve', function () {
    var missing = [];
    Object.keys(WEBAPP_ACTIONS).forEach(function (k) {
      if (!CFG.get(WEBAPP_ACTIONS[k])) missing.push(k);
    });
    return missing.length ? { warn: 'no Config label for: ' + missing.join(', ') } : true;
  });
  check('Web app deployed', function () {
    var url = ''; try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    return url ? url : { warn: 'not deployed yet — Deploy → New deployment → Web app' };
  });
  check('At least one authorised console user', function () {
    var mgr = CFG.get('HIRING_MANAGER_EMAIL');
    return mgr ? mgr : { warn: 'HIRING_MANAGER_EMAIL is empty' };
  });

  out.push('── Send safety ──');
  check('SYSTEM_MODE', function () { return CFG.get('SYSTEM_MODE', 'TEST'); });
  check('SEND_ENABLED', function () { return CFG.getBool('SEND_ENABLED', false) ? 'TRUE' : { warn: 'FALSE — no candidate email will leave' }; });
  check('Email queue enabled', function () { return CFG.getBool('EMAIL_QUEUE_ENABLED', true); });

  out.push('');
  out.push('RESULT: ' + pass + ' passed · ' + warn + ' warning(s) · ' + fail + ' failed');
  var msg = out.join('\n');
  Logger.log(msg);
  logEvent_('V2_VERIFY', '', { pass: pass, warn: warn, fail: fail });

  var logSheet = getOrCreateSheet_('V2 Verification Log', ['Report']);
  logSheet.appendRow([msg]);
  try {
    SpreadsheetApp.getUi().alert('V2 Verify — ' + pass + ' pass / ' + warn + ' warn / ' + fail + ' fail', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
  return msg;
}

/** Install → verify → re-score the open roles. The single button. */
function V2_GO() {
  var a = V2_INSTALL();
  var b = V2_VERIFY();
  var c = RESCORE_openRoles();
  var msg = a + '\n\n' + b + '\n\n' + c;
  Logger.log(msg);
  return msg;
}