/**
 * 43_PreScreen_Sources.gs
 * Frank's European Service — Recruiting OS
 *
 * PRE-SCREEN RESPONSE TAB AUTO-DISCOVERY.
 *
 * WHY THIS EXISTS
 * ---------------
 * SHEETS.RAW_PRESCREEN hardcodes ONE tab name ('Form Responses 5'). When the
 * Pre-Screen Google Form is re-created or re-linked, Google creates a NEW
 * response tab and keeps writing there. The old tab goes quiet, the code keeps
 * reading the old tab, and every new applicant fails the
 * "no Pre-Screen response found" check -> MANUAL_REVIEW, no score, no email.
 * That is a silent, total pipeline stop that looks like "the AI isn't working."
 *
 * This module replaces the single hardcoded lookup with a signature-based scan
 * of EVERY tab in the workbook, so a re-linked form can never stop the pipeline
 * again. Results are cached for the run.
 *
 * A tab qualifies as a pre-screen response tab when it has:
 *   - a Timestamp-ish column, AND
 *   - at least one column whose header contains "email", AND
 *   - at least PRESCREEN_MIN_SIGNATURE_HITS of the known pre-screen question
 *     fingerprints (role selection / experience / scenario questions).
 *
 * Public functions:
 *   PS_findPreScreenRow2_(email)   -> { sheetName, rowNum, timestamp } | null
 *   PS_buildPayloadFor_(email)     -> {questionText: answer} | null
 *   PS_listPreScreenTabs()         -> menu-safe report of discovered tabs
 *   PS_selfTest()                  -> read-only diagnostic
 *   PS_repairFormRegistry()        -> points Form Registry at the live tab
 */

// Header fingerprints that identify a Frank's pre-screen response tab.
// Matching is case-insensitive substring; only a few need to hit.
var PS_SIGNATURE_FRAGMENTS = Object.freeze([
  'select the role that best matches',
  'how did you hear about this position',
  'please upload your resume',
  'direct automotive technician experience',
  'direct service advisor or customer-facing automotive experience',
  'doing the job right the first time',
  'best phone number'
]);

var PS_MIN_SIGNATURE_HITS = 2;

// Tabs that must never be treated as a response source even if they look close.
var PS_EXCLUDE_TABS = Object.freeze([
  'All Candidates', 'Interview Pipeline', 'Pipeline Archive', 'Config',
  'Role Rules', 'Email Templates', 'AI Prompt Templates', 'AI Grading Rubrics',
  'Notification Log', 'Event Log', 'Error Log', 'Email Queue',
  'Assessment Responses', 'Assessment Question Bank', 'Assessment Registry',
  'Interview Worksheets', 'Raw Hiring Email Leads', 'Booking Events'
]);

var PS_CACHE_ = null;

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan every tab and return the ones that look like pre-screen response tabs.
 * PERFORMANCE: each qualifying tab's DATA is read exactly once per execution
 * and cached in memory (`values`). Every lookup afterwards is in-memory — this
 * is what keeps bulk operations (verify, batch re-score) from hammering the
 * Sheets service with one full-tab read per candidate, which on a workbook
 * this size produces "Service Spreadsheets timed out".
 * @return {Array<{name:string, sheet:Sheet, headers:string[], values:Array[],
 *                 emailCols:number[], tsCol:number, hits:number, rows:number}>}
 */
function PS_discoverPreScreenTabs_() {
  if (PS_CACHE_) return PS_CACHE_;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];

  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (PS_EXCLUDE_TABS.indexOf(name) !== -1) return;
    if (/^archived/i.test(name)) return;
    var lastCol = sh.getLastColumn();
    var lastRow = sh.getLastRow();
    if (lastCol < 5 || lastRow < 2) return;   // header + at least one response

    var headers;
    try { headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]; }
    catch (e) { return; }

    var lower = headers.map(function (h) { return String(h || '').toLowerCase().trim(); });

    var emailCols = [];
    var tsCol = -1;
    lower.forEach(function (h, i) {
      if (h.indexOf('email') !== -1) emailCols.push(i);
      if (tsCol === -1 && (h === 'timestamp' || h.indexOf('timestamp') !== -1)) tsCol = i;
    });
    if (!emailCols.length) return;

    var hits = 0;
    PS_SIGNATURE_FRAGMENTS.forEach(function (frag) {
      for (var i = 0; i < lower.length; i++) {
        if (lower[i].indexOf(frag) !== -1) { hits++; return; }
      }
    });
    if (hits < PS_MIN_SIGNATURE_HITS) return;

    // ONE data read per tab per execution — cached for every later lookup.
    var values;
    try { values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues(); }
    catch (e) { return; }

    out.push({
      name: name, sheet: sh, headers: headers, values: values, emailCols: emailCols,
      tsCol: tsCol, hits: hits, rows: lastRow - 1
    });
  });

  // Most rows first is a decent tiebreak, but the real ordering happens
  // per-candidate by response timestamp in PS_findPreScreenRow2_.
  out.sort(function (a, b) { return b.rows - a.rows; });
  PS_CACHE_ = out;
  return out;
}

/** Clear the per-run discovery cache (call after adding/renaming tabs). */
function PS_clearCache_() { PS_CACHE_ = null; }

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the MOST RECENT pre-screen response for an email across every discovered
 * pre-screen tab. Replaces _findPreScreenRow_ (which searched one hardcoded tab
 * and returned only a row number).
 *
 * @param {string} email
 * @return {{sheetName:string, rowNum:number, timestamp:Date|null}|null}
 */
function PS_findPreScreenRow2_(email) {
  var target = normalizeEmail_(email);
  if (!target) return null;

  var tabs = PS_discoverPreScreenTabs_();
  var best = null;

  tabs.forEach(function (t) {
    var data = t.values;   // cached — no sheet read per lookup
    if (!data || !data.length) return;

    for (var i = data.length - 1; i >= 0; i--) {
      var matched = false;
      for (var j = 0; j < t.emailCols.length; j++) {
        if (normalizeEmail_(data[i][t.emailCols[j]]) === target) { matched = true; break; }
      }
      if (!matched) continue;

      var ts = null;
      if (t.tsCol >= 0) {
        var raw = data[i][t.tsCol];
        if (raw instanceof Date) ts = raw;
        else if (raw) { var p = new Date(raw); if (!isNaN(p.getTime())) ts = p; }
      }
      var cand = { sheetName: t.name, rowNum: i + 2, timestamp: ts };
      if (!best) { best = cand; }
      else if (ts && best.timestamp && ts.getTime() > best.timestamp.getTime()) { best = cand; }
      else if (ts && !best.timestamp) { best = cand; }
      break; // newest match within this tab; move to next tab
    }
  });

  return best;
}

/**
 * Build the {questionText: answer} payload for a candidate email, from whichever
 * tab holds their most recent response. Drops blanks and duplicate headers.
 * @return {object|null}
 */
function PS_buildPayloadFor_(email) {
  var loc = PS_findPreScreenRow2_(email);
  if (!loc) return null;
  // Serve from the discovery cache — no per-candidate sheet read.
  var tab = null;
  PS_discoverPreScreenTabs_().forEach(function (t) { if (t.name === loc.sheetName) tab = t; });
  if (!tab) return null;
  var headers = tab.headers;
  var values = tab.values[loc.rowNum - 2];
  if (!values) return null;
  var payload = {};
  headers.forEach(function (h, i) {
    var key = String(h || '').trim();
    if (!key) return;
    if (/^column \d+$/i.test(key)) return;          // stray Google artifacts
    if (key in payload) return;                      // first occurrence wins
    var v = String(values[i] == null ? '' : values[i]).trim();
    if (v) payload[key] = v;
  });
  payload.__source_tab = loc.sheetName;
  payload.__source_row = String(loc.rowNum);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTING / REPAIR
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable report of every discovered pre-screen tab. Menu-safe. */
function PS_listPreScreenTabs() {
  PS_clearCache_();
  var tabs = PS_discoverPreScreenTabs_();
  var out = ['[PRESCREEN_SOURCES] discovered ' + tabs.length + ' response tab(s):'];
  var configured = SHEETS.RAW_PRESCREEN;
  var configuredFound = false;

  tabs.forEach(function (t) {
    var newest = '';
    if (t.tsCol >= 0 && t.values.length) {
      try {
        var v = t.values[t.values.length - 1][t.tsCol];
        newest = v ? (' newest=' + shopDateTime_(v instanceof Date ? v : new Date(v))) : '';
      } catch (e) { newest = ''; }
    }
    if (t.name === configured) configuredFound = true;
    out.push('  • "' + t.name + '"  rows=' + t.rows + '  signatureHits=' + t.hits + newest +
             (t.name === configured ? '   <-- SHEETS.RAW_PRESCREEN points here' : ''));
  });

  if (!tabs.length) {
    out.push('  ✗ NONE FOUND — the Pre-Screen form may not be linked to this spreadsheet.');
  } else if (!configuredFound) {
    out.push('  ⚠ SHEETS.RAW_PRESCREEN = "' + configured + '" is NOT among the live response tabs.');
  }
  out.push('  (Scoring now reads ALL of these, newest response wins — a re-linked form cannot stall the pipeline.)');

  var msg = out.join('\n');
  Logger.log(msg);
  try { toast_(tabs.length + ' pre-screen response tab(s) found — see log', 'Recruiting OS', 8); } catch (e) {}
  logEvent_('PRESCREEN_SOURCES_SCAN', '', { tabs: tabs.length, configuredFound: configuredFound });
  return msg;
}

/**
 * Point the Form Registry's PRESCREEN row at the tab that is actually receiving
 * responses (the discovered tab with the newest response). Safe + idempotent.
 */
function PS_repairFormRegistry() {
  PS_clearCache_();
  var tabs = PS_discoverPreScreenTabs_();
  if (!tabs.length) return '[PRESCREEN_SOURCES] no response tabs discovered — nothing to repair';

  var newestTab = null, newestMs = -1;
  tabs.forEach(function (t) {
    if (t.tsCol < 0 || !t.values.length) return;
    try {
      var v = t.values[t.values.length - 1][t.tsCol];
      var d = (v instanceof Date) ? v : new Date(v);
      if (!isNaN(d.getTime()) && d.getTime() > newestMs) { newestMs = d.getTime(); newestTab = t.name; }
    } catch (e) {}
  });
  if (!newestTab) newestTab = tabs[0].name;

  var reg = getSheetOrNull_(SHEETS.FORM_REGISTRY || 'Form Registry');
  if (reg) {
    var hits = findRowsByColumnValue_(reg, 'Form Key', 'PRESCREEN');
    if (!hits.length) hits = findRowsByColumnValue_(reg, 'Form Key', 'prescreen');
    if (hits.length) {
      updateRowWhere_(reg, 'Form Key', hits[0].data['Form Key'], {
        'Response Tab': newestTab,
        'Notes': 'Auto-repaired ' + shopDateTime_() + ' — pointed at the tab receiving responses.'
      });
    }
  }
  logEvent_('PRESCREEN_REGISTRY_REPAIR', '', { pointedAt: newestTab });
  var msg = '[PRESCREEN_SOURCES] Form Registry PRESCREEN -> "' + newestTab + '"';
  Logger.log(msg);
  try { toast_(msg, 'Recruiting OS', 8); } catch (e) {}
  return msg;
}

/** Set of every email present in ANY discovered pre-screen tab (from cache). */
function PS_emailSetAllTabs_() {
  var set = {};
  PS_discoverPreScreenTabs_().forEach(function (t) {
    t.values.forEach(function (row) {
      t.emailCols.forEach(function (c) {
        var em = normalizeEmail_(row[c]);
        if (em) set[em] = true;
      });
    });
  });
  return set;
}

/** Set of every email in the legacy single tab (ONE read, not one per candidate). */
function PS_emailSetLegacyTab_() {
  var set = {};
  var sh = getSheetOrNull_(SHEETS.RAW_PRESCREEN);
  if (!sh || sh.getLastRow() < 2) return set;
  var headers = getHeaderRow_(sh);
  var emailCols = [];
  headers.forEach(function (h, i) {
    if (String(h || '').toLowerCase().indexOf('email') !== -1) emailCols.push(i);
  });
  if (!emailCols.length) return set;
  sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().forEach(function (row) {
    emailCols.forEach(function (c) {
      var em = normalizeEmail_(row[c]);
      if (em) set[em] = true;
    });
  });
  return set;
}

/** Read-only diagnostic: how many candidates can now be matched vs before. */
function PS_selfTest() {
  PS_clearCache_();
  var out = ['[PRESCREEN_SOURCES] selfTest…'];
  var tabs = PS_discoverPreScreenTabs_();
  out.push('  ─ discovered tabs: ' + tabs.length + ' [' + tabs.map(function (t) { return t.name + '(' + t.rows + ')'; }).join(', ') + ']');
  out.push('  ─ SHEETS.RAW_PRESCREEN (old single-tab lookup): "' + SHEETS.RAW_PRESCREEN + '"');

  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) { out.push('  ✗ All Candidates missing'); Logger.log(out.join('\n')); return out.join('\n'); }
  var last = ac.getLastRow();
  if (last < 2) { out.push('  ─ no candidates'); Logger.log(out.join('\n')); return out.join('\n'); }

  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var cEmail = headers.indexOf('Email'), cRole = headers.indexOf('Role'), cScore = headers.indexOf('AI Score');

  // In-memory sets — NEVER one sheet read per candidate (that pattern is what
  // produced "Service Spreadsheets timed out" on this workbook).
  var newSet = PS_emailSetAllTabs_();
  var oldSet = PS_emailSetLegacyTab_();

  var oldHit = 0, newHit = 0, total = 0, recovered = 0, recoveredUnscored = 0;
  data.forEach(function (r) {
    var em = normalizeEmail_(cEmail >= 0 ? r[cEmail] : '');
    if (!em) return;
    total++;
    var oldFound = !!oldSet[em];
    var newFound = !!newSet[em];
    if (oldFound) oldHit++;
    if (newFound) newHit++;
    if (newFound && !oldFound) {
      recovered++;
      var sc = cScore >= 0 ? r[cScore] : '';
      if (sc === '' || sc === null) recoveredUnscored++;
    }
  });

  out.push('  ─ candidates with an email      : ' + total);
  out.push('  ─ matched by OLD single-tab     : ' + oldHit);
  out.push('  ─ matched by NEW multi-tab      : ' + newHit);
  out.push('  ★ RECOVERED by this fix         : ' + recovered + '  (of which ' + recoveredUnscored + ' currently have NO AI score)');
  out.push('[PRESCREEN_SOURCES] selfTest done.');

  var msg = out.join('\n');
  Logger.log(msg);
  logEvent_('PRESCREEN_SOURCES_SELFTEST', '', { total: total, oldHit: oldHit, newHit: newHit, recovered: recovered });
  return msg;
}