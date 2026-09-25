/**
 * 51_Intake_Repair.gs
 * Frank's European Service — Recruiting OS
 *
 * WHY THIS EXISTS (found 9/25/26)
 * -------------------------------
 * The live Pre-Screen form was re-linked and now writes to 'Form Responses 6'.
 * Intake (05_Candidate_Intake + the 04_Forms dispatcher) only listened to the
 * hardcoded SHEETS.RAW_PRESCREEN ('Form Responses 5'), which went quiet 6/22.
 * Every submission since then logged "no handler mapped for sheet: Form
 * Responses 6" and was dropped: never became a candidate, never graded. Indeed
 * applicants who DID fill the form (with their real email) stayed stuck as
 * relay-email shells showing "Insufficient Data (0)".
 *
 * This module:
 *   1. Detects ANY pre-screen response tab by header signature (so a future
 *      re-link can't silently drop applicants again) — used by 04_Forms.
 *   2. Adopts Indeed relay "shell" rows when the real submission arrives
 *      (match by phone, then by name) — used by 05_Candidate_Intake.
 *   3. Repairs dropped submissions: processes every pre-screen row that never
 *      reached All Candidates. Rows newer than INTAKE_REPAIR_EMAIL_WINDOW_DAYS
 *      get normal emails; older rows are graded silently. Runs in batches with
 *      a self-deleting continuation trigger (Gemini time limits).
 *   4. Installs a DAILY safety-net trigger that re-runs the repair, and feeds a
 *      dropped-count check into systemSelfAudit_ (41_Audit_Fixes).
 *
 * Config keys (Config tab, all optional):
 *   INTAKE_REPAIR_EMAIL_WINDOW_DAYS  default 14
 *   INTAKE_REPAIR_BATCH_SIZE         default 8
 *   INTAKE_REPAIR_SKIP               comma list of names/emails never to process
 *                                    (people already hired outside the system)
 *
 * ONE-TIME SETUP: run INTAKE_FIX_RUN_ONCE() from the editor.
 * Public: INTAKE_FIX_RUN_ONCE, INTAKE_previewDroppedPreScreens,
 *         INTAKE_repairDroppedPreScreens, INTAKE_selfTest
 */

var INTAKE_REPAIR_HANDLER      = 'INTAKE_repairDroppedPreScreens';
var INTAKE_REPAIR_CONT_HANDLER = 'INTAKE_repairContinue_';
// Hired outside the Recruiting OS — their form rows must never trigger emails/scoring.
var INTAKE_REPAIR_SKIP_DEFAULT = 'juan manuel corona arcos, juan corona, david ellis';

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRE-SCREEN TAB DETECTION (header-only, cheap enough for every submit)
// ─────────────────────────────────────────────────────────────────────────────

function INTAKE_isPreScreenTab_(sheet) {
  if (!sheet) return false;
  var name = sheet.getName();
  if (name === SHEETS.RAW_PRESCREEN) return true;
  var excl = (typeof PS_EXCLUDE_TABS !== 'undefined') ? PS_EXCLUDE_TABS : [];
  if (excl.indexOf(name) !== -1 || /^archived/i.test(name)) return false;
  var lastCol = sheet.getLastColumn();
  if (lastCol < 5) return false;
  var lower = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h || '').toLowerCase().trim(); });
  if (!lower.some(function (h) { return h.indexOf('email') !== -1; })) return false;
  var frags = (typeof PS_SIGNATURE_FRAGMENTS !== 'undefined') ? PS_SIGNATURE_FRAGMENTS : [];
  var need  = (typeof PS_MIN_SIGNATURE_HITS !== 'undefined') ? PS_MIN_SIGNATURE_HITS : 2;
  var hits = 0;
  frags.forEach(function (f) {
    if (lower.some(function (h) { return h.indexOf(f) !== -1; })) hits++;
  });
  return hits >= need;
}

function INTAKE_preScreenTabNames_() {
  var names = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    if (INTAKE_isPreScreenTab_(sh)) names.push(sh.getName());
  });
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. INDEED RELAY SHELL MATCHING
// ─────────────────────────────────────────────────────────────────────────────

function _INTAKE_isRelayEmail_(email) {
  var e = String(email || '').trim().toLowerCase();
  return !e || /@indeedemail\.com$/.test(e) || /^conversation-/.test(e);
}

function _INTAKE_nameKey_(first, last) {
  var toks = String((first || '') + ' ' + (last || '')).toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    .filter(function (t) { return !/^(jr|sr|ii|iii|iv)$/.test(t); });
  return { full: toks.join(' '), first: toks[0] || '', last: toks[toks.length - 1] || '' };
}

/**
 * Return the Candidate ID of the single LIVE relay-email shell that matches this
 * submission (phone first, then full name, then first+last token), or ''.
 * Never matches a row that already has a real email, or a closed row.
 */
var _INTAKE_AC_CACHE_ = null;   // set only during _INTAKE_collectDropped_ (read-only scan)

function _INTAKE_readAc_() {
  if (_INTAKE_AC_CACHE_) return _INTAKE_AC_CACHE_;
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac || ac.getLastRow() < 2) return null;
  var headers = getHeaderRow_(ac);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  return { H: H, data: ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues() };
}

function INTAKE_findRelayShell_(fields) {
  var snap = _INTAKE_readAc_();
  if (!snap) return '';
  var H = snap.H, data = snap.data;
  if (H['Candidate ID'] === undefined || H['Email'] === undefined) return '';

  // Only LIVE shells (never re-open archived / rejected / hired / drawer rows).
  var LIVE = { '': 1, 'NEW': 1, 'MANUAL_REVIEW': 1, 'PRESCREEN_SENT': 1 };
  var shells = data.filter(function (r) {
    var st = H['Status'] === undefined ? '' : String(r[H['Status']] || '').trim().toUpperCase();
    return String(r[H['Candidate ID']] || '').trim() && _INTAKE_isRelayEmail_(r[H['Email']]) && LIVE[st];
  });
  if (!shells.length) return '';

  function uniq(list) {
    var ids = [];
    list.forEach(function (r) { var c = String(r[H['Candidate ID']]).trim(); if (ids.indexOf(c) === -1) ids.push(c); });
    return ids.length === 1 ? ids[0] : '';
  }

  var phone = String(fields.phone || '').replace(/\D/g, '').slice(-10);
  if (phone.length === 10 && H['Phone'] !== undefined) {
    var byPhone = shells.filter(function (r) { return String(r[H['Phone']] || '').replace(/\D/g, '').slice(-10) === phone; });
    if (byPhone.length) return uniq(byPhone);
  }

  var want = _INTAKE_nameKey_(fields.firstName, fields.lastName);
  if (!want.first || !want.last || want.full.length < 5) return '';
  var byFull = shells.filter(function (r) {
    return _INTAKE_nameKey_(r[H['First Name']], r[H['Last Name']]).full === want.full;
  });
  if (byFull.length) return uniq(byFull);
  var byEnds = shells.filter(function (r) {
    var k = _INTAKE_nameKey_(r[H['First Name']], r[H['Last Name']]);
    return k.first === want.first && k.last === want.last;
  });
  return uniq(byEnds);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DROPPED-SUBMISSION DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every pre-screen row (any tab) whose email is not in All Candidates.
 * Rows dated on/before the old tab's latest response were handled by the old
 * intake and are skipped unless they match a live Indeed shell.
 * @return {Array<{tab, rowNum, email, name, ts:Date|null}>}
 */
function _INTAKE_collectDropped_() {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var acEmails = {};
  var acHeaders = getHeaderRow_(ac);
  var eCol = acHeaders.indexOf('Email');
  if (ac.getLastRow() >= 2 && eCol !== -1) {
    ac.getRange(2, eCol + 1, ac.getLastRow() - 1, 1).getValues().forEach(function (v) {
      var e = normalizeEmail_(v[0]); if (e) acEmails[e] = true;
    });
  }

  var skip = String(CFG.get('INTAKE_REPAIR_SKIP', INTAKE_REPAIR_SKIP_DEFAULT) || '')
    .toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  // Latest timestamp on the original tab = cutoff for re-link copies.
  var primaryLatest = 0;
  var primary = getSheetOrNull_(SHEETS.RAW_PRESCREEN);
  if (primary && primary.getLastRow() >= 2) {
    primary.getRange(2, 1, primary.getLastRow() - 1, 1).getValues().forEach(function (v) {
      var t = (v[0] instanceof Date) ? v[0].getTime() : new Date(v[0]).getTime();
      if (!isNaN(t) && t > primaryLatest) primaryLatest = t;
    });
  }

  var out = [];
  _INTAKE_AC_CACHE_ = null; _INTAKE_AC_CACHE_ = _INTAKE_readAc_();
  try {
  INTAKE_preScreenTabNames_().forEach(function (tab) {
    var sh = getSheet_(tab);
    var last = sh.getLastRow();
    if (last < 2) return;
    var headers = getHeaderRow_(sh).map(function (h) { return String(h || '').toLowerCase().trim(); });
    // Identity email columns only (not questions that mention "email").
    var emailCols = [];
    headers.forEach(function (h, i) { if (h === 'email' || h === 'email address' || h === 'e-mail') emailCols.push(i); });
    var nameCol = headers.indexOf('full name'); if (nameCol === -1) nameCol = headers.indexOf('name');
    var phoneCol = -1;
    ['best phone number', 'phone number', 'phone'].forEach(function (k) { if (phoneCol === -1) phoneCol = headers.indexOf(k); });
    if (!emailCols.length) return;
    var vals = sh.getRange(2, 1, last - 1, headers.length).getValues();
    vals.forEach(function (r, i) {
      var ts = (r[0] instanceof Date) ? r[0] : (r[0] ? new Date(r[0]) : null);
      if (ts && isNaN(ts.getTime())) ts = null;
      var email = '';
      for (var j = 0; j < emailCols.length; j++) { email = normalizeEmail_(r[emailCols[j]]); if (email) break; }
      if (!email || acEmails[email]) return;
      var name = nameCol === -1 ? '' : String(r[nameCol] || '').trim();
      // Anything dated on/before the old tab's last response was already handled
      // by the old intake (or copied over at re-link time; its email may since
      // have been merged away by dedup). Count it only when it belongs to a
      // stuck LIVE Indeed shell — e.g. an applicant whose row had no email.
      if (ts && primaryLatest && ts.getTime() <= primaryLatest) {
        var parts = name.split(/\s+/);
        var shell = INTAKE_findRelayShell_({ firstName: parts.shift() || '', lastName: parts.join(' '),
          phone: phoneCol === -1 ? '' : r[phoneCol] });
        if (!shell) return;
      }
      var nk = _INTAKE_nameKey_(name, '').full;
      if (skip.indexOf(email) !== -1 || (nk && skip.indexOf(nk) !== -1)) return;
      out.push({ tab: tab, rowNum: i + 2, email: email, name: name, ts: ts });
    });
  });
  } finally { _INTAKE_AC_CACHE_ = null; }
  out.sort(function (a, b) { return (b.ts ? b.ts.getTime() : 0) - (a.ts ? a.ts.getTime() : 0); }); // newest first
  var seen = {};
  return out.filter(function (d) { if (seen[d.email]) return false; seen[d.email] = true; return true; }); // newest per person
}

function INTAKE_countDroppedPreScreens_() {
  try { return _INTAKE_collectDropped_().length; } catch (e) { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PREVIEW + REPAIR
// ─────────────────────────────────────────────────────────────────────────────

function INTAKE_previewDroppedPreScreens() {
  var days = CFG.getInt('INTAKE_REPAIR_EMAIL_WINDOW_DAYS', 14);
  var cutoff = Date.now() - days * 86400000;
  var list = _INTAKE_collectDropped_();
  var out = ['[INTAKE_REPAIR] PREVIEW — ' + list.length + ' dropped pre-screen submission(s). Emails only for the last ' + days + ' days.'];
  list.forEach(function (d) {
    var recent = d.ts && d.ts.getTime() >= cutoff;
    out.push('  ' + (recent ? 'EMAIL ' : 'SILENT') + '  ' + (d.ts ? Utilities.formatDate(d.ts, 'America/Los_Angeles', 'yyyy-MM-dd') : '????-??-??') +
             '  ' + d.tab + ' r' + d.rowNum + '  ' + d.name);
  });
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Process up to INTAKE_REPAIR_BATCH_SIZE dropped rows; schedules itself until done. */
function INTAKE_repairDroppedPreScreens() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_(INTAKE_REPAIR_HANDLER, 'OK');
  return withLockOrSkip_('INTAKE_repairDroppedPreScreens', function () {
    if (typeof PS_clearCache_ === 'function') PS_clearCache_();
    var days  = CFG.getInt('INTAKE_REPAIR_EMAIL_WINDOW_DAYS', 14);
    var batch = CFG.getInt('INTAKE_REPAIR_BATCH_SIZE', 8);
    var cutoff = Date.now() - days * 86400000;
    var started = Date.now();
    var list = _INTAKE_collectDropped_();
    var s = { found: list.length, processed: 0, emailed: 0, silent: 0, errors: 0 };

    for (var i = 0; i < list.length && s.processed + s.errors < batch; i++) {
      if (Date.now() - started > 4 * 60 * 1000) break;            // stay under the 6-min ceiling
      var d = list[i];
      var recent = !!(d.ts && d.ts.getTime() >= cutoff);
      try {
        _processPreScreenRow_(d.rowNum, false, { sheetName: d.tab, suppressEmails: !recent });
        s.processed++; if (recent) s.emailed++; else s.silent++;
      } catch (e) {
        s.errors++;
        logError_('INTAKE_repair:' + d.tab + ':r' + d.rowNum, e, '', 'WARN');
      }
    }

    var remaining = Math.max(0, list.length - s.processed - s.errors);
    _INTAKE_clearContinuation_();
    if (remaining > 0 && s.processed > 0) {
      ScriptApp.newTrigger(INTAKE_REPAIR_CONT_HANDLER).timeBased().after(60 * 1000).create();
    } else if (typeof updateRecommendationEngineForAll === 'function') {
      safeRun_('INTAKE_repair:recommend', function () { updateRecommendationEngineForAll(); });
    }

    s.remaining = remaining;
    logEvent_('INTAKE_REPAIR_RUN', '', s);
    var msg = '[INTAKE_REPAIR] ' + JSON.stringify(s);
    Logger.log(msg);
    return msg;
  });
}

function INTAKE_repairContinue_() { return INTAKE_repairDroppedPreScreens(); }

function _INTAKE_clearContinuation_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === INTAKE_REPAIR_CONT_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ONE-TIME SETUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run once from the editor after pulling these files:
 *   - installs the daily safety-net trigger (6 AM)
 *   - logs the preview
 *   - starts the repair (continues on its own until the backlog is clear)
 *   - relabels the pipeline ("Awaiting Pre-Screen" instead of "Insufficient Data (0)")
 */
function INTAKE_FIX_RUN_ONCE() {
  var out = [];
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === INTAKE_REPAIR_HANDLER; });
  if (!has) {
    ScriptApp.newTrigger(INTAKE_REPAIR_HANDLER).timeBased().everyDays(1).atHour(6).create();
    out.push('✓ daily safety-net trigger installed (6 AM)');
  } else out.push('✓ daily safety-net trigger already present');
  out.push('✓ pre-screen tabs detected: ' + INTAKE_preScreenTabNames_().join(', '));
  out.push(INTAKE_previewDroppedPreScreens());
  out.push(INTAKE_repairDroppedPreScreens());
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST (read-only)
// ─────────────────────────────────────────────────────────────────────────────
function INTAKE_selfTest() {
  var out = ['[INTAKE_REPAIR] selfTest (read-only)…'];
  out.push('  pre-screen tabs: ' + INTAKE_preScreenTabNames_().join(', '));
  out.push('  dropped submissions: ' + INTAKE_countDroppedPreScreens_());
  out.push('  relay check: ' + _INTAKE_isRelayEmail_('conversation-x-abc@indeedemail.com') + '/' + !_INTAKE_isRelayEmail_('a@gmail.com'));
  out.push('  name key: ' + _INTAKE_nameKey_('Cleon D Cooper', 'Jr.').first + ' ' + _INTAKE_nameKey_('Cleon D Cooper', 'Jr.').last);
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
