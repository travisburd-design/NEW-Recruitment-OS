/**
 * 01_Utils.gs
 * Frank's European Service — Recruiting OS
 *
 * Pure, dependency-free utility layer. Every other file in the project leans
 * on these helpers for: sheet access, header-keyed reads/writes, normalization,
 * dates, JSON parsing, locking, and safe-run wrappers.
 *
 * Hard rules:
 *   - Never throw out of a helper for an expected condition (missing sheet,
 *     missing header) when the caller can choose to recover. Throw only on
 *     programmer error (bad arguments).
 *   - Header lookups are case-insensitive and whitespace-tolerant.
 *   - Per-execution sheet/header caches; cleared automatically on each run.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Per-execution caches (auto-cleared between executions; one map per run)
// ─────────────────────────────────────────────────────────────────────────────
var _SHEET_CACHE  = {};   // name -> Sheet
var _HEADER_CACHE = {};   // name -> { lcHeader: colIndex1Based }

function _clearUtilCaches_() { _SHEET_CACHE = {}; _HEADER_CACHE = {}; }

// ─────────────────────────────────────────────────────────────────────────────
// SHEET ACCESS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the Sheet by name. Throws if missing. */
function getSheet_(name) {
  if (_SHEET_CACHE[name]) return _SHEET_CACHE[name];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('getSheet_: sheet not found: "' + name + '"');
  _SHEET_CACHE[name] = sh;
  return sh;
}

/** Returns the Sheet by name OR null if missing. Never throws. */
function getSheetOrNull_(name) {
  if (_SHEET_CACHE[name]) return _SHEET_CACHE[name];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (sh) _SHEET_CACHE[name] = sh;
  return sh || null;
}

/**
 * Get sheet by name, creating it if missing. If headers provided AND the
 * sheet is empty, writes them as row 1. Never overwrites existing headers.
 * @param {string} name
 * @param {string[]=} headers
 * @return {Sheet}
 */
function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  if (headers && headers.length && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  _SHEET_CACHE[name] = sh;
  return sh;
}

/**
 * Ensure a sheet has at least the given headers; appends any missing columns
 * to the right. Never reorders existing columns. Returns the sheet.
 */
function ensureHeaders_(sheet, headers) {
  if (!sheet) throw new Error('ensureHeaders_: sheet is null');
  var have = getHeaderRow_(sheet);
  if (!have.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    _HEADER_CACHE[sheet.getName()] = null;
    return sheet;
  }
  var haveLc = have.map(function (h) { return String(h).trim().toLowerCase(); });
  var toAdd = [];
  headers.forEach(function (h) {
    if (haveLc.indexOf(String(h).trim().toLowerCase()) === -1) toAdd.push(h);
  });
  if (toAdd.length) {
    sheet.getRange(1, have.length + 1, 1, toAdd.length).setValues([toAdd]);
    sheet.getRange(1, have.length + 1, 1, toAdd.length).setFontWeight('bold');
    _HEADER_CACHE[sheet.getName()] = null;
  }
  return sheet;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER MAP HELPERS — all column lookups go through these
// ─────────────────────────────────────────────────────────────────────────────

/** Returns row 1 as array of strings (may be empty). */
function getHeaderRow_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  var row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return row.map(function (v) { return v === null || v === undefined ? '' : String(v); });
}

/**
 * Returns { lowercaseHeader: 1-based column index }.
 * Cached per sheet per execution.
 */
function getHeaderMap_(sheet) {
  var name = sheet.getName();
  if (_HEADER_CACHE[name]) return _HEADER_CACHE[name];
  var row = getHeaderRow_(sheet);
  var map = {};
  row.forEach(function (h, i) {
    var k = String(h).trim().toLowerCase();
    if (k) map[k] = i + 1;
  });
  _HEADER_CACHE[name] = map;
  return map;
}

/**
 * Returns 1-based column index for a header. Returns 0 if not found.
 * Case-insensitive, whitespace-tolerant.
 */
function getColIndex_(sheet, headerName) {
  var m = getHeaderMap_(sheet);
  return m[String(headerName).trim().toLowerCase()] || 0;
}

/** Throws if the requested header is missing. Use when absence is a bug. */
function requireColIndex_(sheet, headerName) {
  var c = getColIndex_(sheet, headerName);
  if (!c) throw new Error('Missing header "' + headerName + '" on sheet "' + sheet.getName() + '"');
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW READ / WRITE BY HEADER NAME
// ─────────────────────────────────────────────────────────────────────────────

/** Reads a given row as { headerName: value }. row is 1-based; row 1 = header. */
function readRowAsObject_(sheet, rowNum) {
  if (rowNum < 2) throw new Error('readRowAsObject_: rowNum must be >= 2');
  var headers = getHeaderRow_(sheet);
  if (!headers.length) return {};
  var values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  var obj = {};
  headers.forEach(function (h, i) {
    if (h) obj[String(h).trim()] = values[i];
  });
  return obj;
}

/**
 * Append a row using a {HeaderName: value} object. Unknown headers are
 * silently skipped (so you can pass extras safely). Returns the new row number.
 */
function appendRowByHeader_(sheet, obj) {
  var headers = getHeaderRow_(sheet);
  if (!headers.length) throw new Error('appendRowByHeader_: sheet has no headers: ' + sheet.getName());
  // Build a case-insensitive lookup of provided keys
  var lcKeys = {};
  Object.keys(obj || {}).forEach(function (k) { lcKeys[k.trim().toLowerCase()] = k; });
  // Track which provided keys actually land in a column.
  var matched = {};
  var row = headers.map(function (h) {
    var k = String(h).trim().toLowerCase();
    if (k in lcKeys) { matched[k] = true; return obj[lcKeys[k]]; }
    return '';
  });
  // F16: a dropped key usually means a header was renamed/removed and that
  // column's data is being silently lost. Warn (Logger only — this helper is on
  // the logging hot path, so it must never call logEvent_/logError_ and recurse).
  var dropped = [];
  Object.keys(lcKeys).forEach(function (k) {
    if (!matched[k]) dropped.push(lcKeys[k]);
  });
  if (dropped.length) {
    Logger.log('[WARN] appendRowByHeader_ on "' + sheet.getName() +
               '" dropped key(s) with no matching column: ' + dropped.join(', ') +
               ' — a header may have been renamed/removed.');
  }
  sheet.appendRow(row);
  return sheet.getLastRow();
}

/**
 * Update one row identified by a matching column value.
 * Returns the row number updated, or 0 if no match.
 *
 * @param {Sheet} sheet
 * @param {string} matchHeader  e.g. 'Candidate ID'
 * @param {*} matchValue
 * @param {object} updates      { 'Header Name': newValue, ... }
 */
function updateRowWhere_(sheet, matchHeader, matchValue, updates) {
  var col = requireColIndex_(sheet, matchHeader);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var colValues = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  var target = String(matchValue);
  for (var i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]) === target) {
      var rowNum = i + 2;
      batchUpdateRow_(sheet, rowNum, updates);
      return rowNum;
    }
  }
  return 0;
}

/** Returns array of { rowNum, data: {Header: value} } where colName matches. */
function findRowsByColumnValue_(sheet, headerName, value) {
  var col = getColIndex_(sheet, headerName);
  if (!col) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaderRow_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var target = String(value);
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][col - 1]) === target) {
      var obj = {};
      headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = values[i][j]; });
      out.push({ rowNum: i + 2, data: obj });
    }
  }
  return out;
}

/**
 * Apply multiple header-keyed updates to a single row in one batched call.
 * Cells whose header is missing are skipped silently (logged, not thrown).
 */
function batchUpdateRow_(sheet, rowNum, updates) {
  if (!updates) return;
  var keys = Object.keys(updates);
  if (!keys.length) return;
  var map = getHeaderMap_(sheet);
  var writes = []; // [{col, value}]
  keys.forEach(function (k) {
    var col = map[k.trim().toLowerCase()];
    if (col) writes.push({ col: col, value: updates[k] });
  });
  if (!writes.length) return;
  // Sort by col so we can batch consecutive cells if desired; simple per-cell
  // setValue is fine for the row sizes we deal with (< 100 cols).
  writes.forEach(function (w) {
    sheet.getRange(rowNum, w.col).setValue(w.value);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function normalizeEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

function normalizeName_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizePhone_(p) {
  return String(p || '').replace(/[^\d]/g, '');
}

function isEmpty_(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function truncate_(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.substring(0, n - 1) + '…';
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// IDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable, human-readable candidate ID. Same email+role always yields the same
 * ID, so duplicate intake creates the same key. Format: FES-<role3>-<hash8>.
 *
 * The role is normalized first (Valet/Porter/Driver/CX all collapse to the one
 * canonical role) so the SAME person can never be split into two IDs by role
 * wording drift (e.g. FES-VAL-... vs FES-CXV-...).
 */
function candidateIdFromEmail_(email, role) {
  var canonRole = (typeof normalizeRole_ === 'function') ? (normalizeRole_(role) || role || 'GEN') : (role || 'GEN');
  var seed = normalizeEmail_(email) + '|' + normalizeName_(canonRole).toLowerCase();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, seed);
  var hex = bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('').substring(0, 8).toUpperCase();
  var roleTag = (String(canonRole || 'GEN').replace(/[^A-Za-z]/g, '').toUpperCase() + 'XXX').substring(0, 3);
  return 'FES-' + roleTag + '-' + hex;
}

/** Random ID fallback for cases without email yet. */
function genCandidateId_() {
  return 'FES-NEW-' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// DATES & TIMES (always shop-local for display)
// ─────────────────────────────────────────────────────────────────────────────

function _tz_() { return CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles'); }

function nowISO_() { return new Date().toISOString(); }

/** "2026-05-25 19:04" in shop time. */
function shopDateTime_(d) {
  d = d || new Date();
  return Utilities.formatDate(_coerceDate_(d), _tz_(), 'yyyy-MM-dd HH:mm');
}

function shopDate_(d) {
  d = d || new Date();
  return Utilities.formatDate(_coerceDate_(d), _tz_(), 'yyyy-MM-dd');
}

function shopTimeOnly_(d) {
  d = d || new Date();
  return Utilities.formatDate(_coerceDate_(d), _tz_(), 'h:mm a');
}

function daysSince_(d) {
  if (!d) return Infinity;
  var then = _coerceDate_(d).getTime();
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

function hoursSince_(d) {
  if (!d) return Infinity;
  var then = _coerceDate_(d).getTime();
  return Math.floor((Date.now() - then) / (1000 * 60 * 60));
}

function _coerceDate_(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  var d = new Date(String(v));
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse JSON tolerantly. Strips markdown code fences (```json … ```), strips
 * any leading/trailing prose, and falls back to extracting the first {...}
 * block. Returns {ok:true,data:obj} or {ok:false,error:string,raw:original}.
 */
function safeParseJson_(text) {
  var raw = String(text == null ? '' : text);
  var s = raw.trim();
  // Strip code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Try direct parse
  try { return { ok: true, data: JSON.parse(s) }; } catch (e1) { /* fall through */ }
  // Try to extract first {...} block
  var first = s.indexOf('{');
  var last  = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    var sub = s.substring(first, last + 1);
    try { return { ok: true, data: JSON.parse(sub) }; } catch (e2) {
      return { ok: false, error: e2.message, raw: raw };
    }
  }
  return { ok: false, error: 'no JSON object found', raw: raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCKING & SAFE RUN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a function in a lock. Waits up to waitMs ms (default 30s).
 * Returns whatever fn() returns. Throws if lock cannot be acquired.
 * Use this for MANUAL / menu-triggered operations where failure matters.
 */
function withLock_(fn, waitMs, lockType) {
  waitMs = waitMs || 30000;
  var lock = (lockType === 'user')
    ? LockService.getUserLock()
    : LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) throw new Error('withLock_: could not obtain script lock within ' + waitMs + 'ms');
  try { return fn(); }
  finally { lock.releaseLock(); }
}

/**
 * Same as withLock_ but designed for time-triggered (automated) functions.
 * If the lock is already held, logs a single line and returns the skip message
 * instead of throwing — the trigger will simply fire again in the next cycle.
 *
 * Use this for every function called by a time-based or form-submit trigger
 * so that normal concurrency (e.g. a 15-min Otter poll overlapping a manual
 * flush) never creates Error Log noise or blocks execution for 30 seconds.
 */
function withLockOrSkip_(label, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    var msg = '[' + label + '] skipped — another execution holds the lock. Will retry next cycle.';
    Logger.log(msg);
    return msg;
  }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

/**
 * Run fn() with try/catch. On error, returns null and logs via Logger and
 * (if available) via logError_() in 17_Errors_Logs.gs. Never re-throws.
 */
function safeRun_(label, fn) {
  try { return fn(); }
  catch (e) {
    var msg = '[' + label + '] ' + (e && e.message ? e.message : e) + (e && e.stack ? '\n' + e.stack : '');
    Logger.log('SAFE_RUN_ERROR ' + msg);
    try { if (typeof logError_ === 'function') logError_(label, e); } catch (_) { /* logger not yet loaded */ }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toast_(msg, title, secs) {
  try {
    SpreadsheetApp.getActive().toast(String(msg), String(title || 'Recruiting OS'), Number(secs || 5));
  } catch (e) { Logger.log('toast_: ' + e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE-FIELD RENDERER — used by email templates and prompts
// Replaces {{Token}} occurrences in the template with values from the
// provided context object. Unknown tokens are left as-is so they show up
// during review (rather than being silently blanked).
// ─────────────────────────────────────────────────────────────────────────────
function renderMerge_(template, ctx) {
  if (!template) return '';
  var s = String(template);
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (full, key) {
    if (ctx && (key in ctx) && ctx[key] !== undefined && ctx[key] !== null) {
      return String(ctx[key]);
    }
    return full; // leave as placeholder
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// Creates a temporary sheet, exercises every helper, then deletes the sheet.
// Safe to run any time. Touches no candidate data.
// ─────────────────────────────────────────────────────────────────────────────
function UTILS_selfTest() {
  _clearUtilCaches_();
  var ss = SpreadsheetApp.getActive();
  var name = '__utils_selftest_' + Utilities.getUuid().substring(0, 6);
  var out = ['[UTILS] selfTest starting (' + name + ')…'];
  var sh = null;
  try {
    sh = getOrCreateSheet_(name, ['Candidate ID', 'Email', 'Score', 'Status', 'Date']);
    out.push('  ✓ getOrCreateSheet_ + headers written');

    // ensureHeaders_ should not duplicate, but should add 'Notes'
    ensureHeaders_(sh, ['Email', 'Notes']);
    var hdrs = getHeaderRow_(sh);
    if (hdrs.length === 6 && hdrs[5] === 'Notes') {
      out.push('  ✓ ensureHeaders_ added missing column without duplicating');
    } else {
      out.push('  ✗ ensureHeaders_ unexpected: ' + JSON.stringify(hdrs));
    }

    // appendRowByHeader_
    var rid = appendRowByHeader_(sh, {
      'candidate id': candidateIdFromEmail_('test@example.com', 'Technician'),
      'Email': normalizeEmail_(' TEST@Example.com '),
      'Score': 73,
      'Status': 'NEW',
      'Date': shopDateTime_(),
      'Unknown Header': 'ignored'
    });
    if (rid === 2) out.push('  ✓ appendRowByHeader_ wrote row 2 and ignored unknown headers');
    else out.push('  ✗ appendRowByHeader_ wrote row ' + rid + ' (expected 2)');

    // findRowsByColumnValue_
    var hits = findRowsByColumnValue_(sh, 'Status', 'NEW');
    out.push('  ' + (hits.length === 1 ? '✓' : '✗') + ' findRowsByColumnValue_ found ' + hits.length + ' (expected 1)');

    // updateRowWhere_
    var updated = updateRowWhere_(sh, 'Email', 'test@example.com', { 'Status': 'SCORED', 'Score': 82 });
    out.push('  ' + (updated === 2 ? '✓' : '✗') + ' updateRowWhere_ updated row ' + updated);

    // readRowAsObject_
    var obj = readRowAsObject_(sh, 2);
    out.push('  ' + (obj.Status === 'SCORED' && Number(obj.Score) === 82 ? '✓' : '✗') +
             ' readRowAsObject_ Status=' + obj.Status + ' Score=' + obj.Score);

    // Normalization
    out.push('  ✓ normalizeEmail_ "  FOO@BAR.com " → "' + normalizeEmail_('  FOO@BAR.com ') + '"');
    out.push('  ✓ normalizePhone_ "(702) 365-9100" → "' + normalizePhone_('(702) 365-9100') + '"');

    // Stable candidate ID
    var id1 = candidateIdFromEmail_('a@b.com', 'Technician');
    var id2 = candidateIdFromEmail_('A@B.COM', 'Technician');
    out.push('  ' + (id1 === id2 ? '✓' : '✗') + ' candidateIdFromEmail_ deterministic: ' + id1);

    // JSON parse with fences
    var sp = safeParseJson_('```json\n{"ok":1,"name":"x"}\n```');
    out.push('  ' + (sp.ok && sp.data.ok === 1 ? '✓' : '✗') + ' safeParseJson_ with code fence');

    var sp2 = safeParseJson_('Here is your result: {"score": 88, "note":"good"} done.');
    out.push('  ' + (sp2.ok && sp2.data.score === 88 ? '✓' : '✗') + ' safeParseJson_ with prose around JSON');

    // renderMerge_ leaves unknown tokens for review
    var rendered = renderMerge_('Hi {{CandidateFirstName}}, the {{Unknown}} field stays.', { CandidateFirstName: 'Travis' });
    var ok = rendered.indexOf('Hi Travis') === 0 && rendered.indexOf('{{Unknown}}') !== -1;
    out.push('  ' + (ok ? '✓' : '✗') + ' renderMerge_ → "' + rendered + '"');

    // Lock + safeRun_
    var lockOK = withLock_(function () { return 'locked-ok'; });
    out.push('  ' + (lockOK === 'locked-ok' ? '✓' : '✗') + ' withLock_ returned: ' + lockOK);

    var safeOK = safeRun_('UTILS_selfTest', function () { return 42; });
    out.push('  ' + (safeOK === 42 ? '✓' : '✗') + ' safeRun_ returned: ' + safeOK);

    var safeFail = safeRun_('UTILS_selfTest_intentional', function () { throw new Error('expected — ignore'); });
    out.push('  ' + (safeFail === null ? '✓' : '✗') + ' safeRun_ swallowed exception, returned: ' + safeFail);

  } catch (e) {
    out.push('  ✗ FATAL: ' + e.message + (e.stack ? '\n    ' + e.stack : ''));
  } finally {
    if (sh) {
      try { ss.deleteSheet(sh); out.push('  ✓ test sheet deleted'); }
      catch (e) { out.push('  ⚠ could not delete test sheet: ' + name + ' (delete manually): ' + e); }
    }
  }
  out.push('[UTILS] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
