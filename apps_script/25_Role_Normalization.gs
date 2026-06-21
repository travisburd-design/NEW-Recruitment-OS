/**
 * 25_Role_Normalization.gs
 * Frank's European Service — Recruiting OS
 *
 * Unifies CX, Valet, Porter, and Driver into one canonical role and rewrites
 * every Role value across the system to a canonical Role Rules name. The
 * canonical mapping lives in normalizeRole_() (05_Candidate_Intake.gs); this
 * file is the bulk repair that applies it to existing data and merges
 * duplicate Role Rules rows.
 *
 * Canonical unified role: ROLE_CANONICAL_CX_VALET ('CX / Valet Porter Driver').
 *
 * Public functions:
 *   runRoleNormalizationRepair()  — rewrite roles everywhere + merge rules
 *   ROLE_NORM_selfTest()          — read-only mapping demonstration
 */

// Sheets that carry a free-standing 'Role' column and are safe to rewrite.
var ROLE_NORMALIZE_SHEETS = [
  'ALL_CANDIDATES', 'INTERVIEW_PIPELINE', 'TRANSCRIPT_ARCHIVE',
  'RAW_PRESCREEN', 'ASSESSMENT_REGISTRY'
];

function runRoleNormalizationRepair() {
  return withLock_(function () {
    var report = ['[ROLE_NORM] runRoleNormalizationRepair — ' + shopDateTime_()];
    var totals = { sheetsTouched: 0, cellsChanged: 0, ruleRowsMerged: 0 };

    ROLE_NORMALIZE_SHEETS.forEach(function (key) {
      var name = SHEETS[key];
      if (!name) return;
      var r = _normalizeRolesInSheet_(name);
      if (r.changed > 0) totals.sheetsTouched++;
      totals.cellsChanged += r.changed;
      report.push('  ─ ' + name.padEnd(28, ' ') + ' scanned=' + r.scanned + ' changed=' + r.changed +
                  (r.note ? ' (' + r.note + ')' : ''));
    });

    var merge = _mergeRoleRules_();
    totals.ruleRowsMerged = merge.deactivated;
    report.push('  ─ Role Rules: canonicalized=' + merge.renamed + ' deactivatedDuplicates=' + merge.deactivated +
                ' activeCanonical=' + merge.activeCanonical);

    report.push('  ── canonical CX role: ' + ROLE_CANONICAL_CX_VALET);
    var msg = report.join('\n');
    Logger.log(msg);
    logEvent_('ROLE_NORMALIZATION_REPAIR', '', totals);
    toast_('Role normalization complete — ' + totals.cellsChanged + ' cells updated', 'Recruiting OS', 6);
    return msg;
  });
}

/** Rewrite every 'Role' cell in a sheet through normalizeRole_. Batched write. */
function _normalizeRolesInSheet_(sheetName) {
  var sh = getSheetOrNull_(sheetName);
  if (!sh) return { scanned: 0, changed: 0, note: 'sheet missing' };
  var last = sh.getLastRow();
  if (last < 2) return { scanned: 0, changed: 0, note: 'empty' };
  var headers = getHeaderRow_(sh);
  var roleCol = headers.indexOf('Role');
  if (roleCol === -1) return { scanned: 0, changed: 0, note: 'no Role column' };

  var range = sh.getRange(2, roleCol + 1, last - 1, 1);
  var values = range.getValues();
  var changed = 0;
  for (var i = 0; i < values.length; i++) {
    var cur = String(values[i][0] || '').trim();
    if (!cur) continue;
    var canon = normalizeRole_(cur);
    if (canon && canon !== cur) { values[i][0] = canon; changed++; }
  }
  if (changed > 0) range.setValues(values);
  return { scanned: values.length, changed: changed, note: '' };
}

/**
 * Canonicalize the 'Role' value of every Role Rules row and merge duplicates:
 * the first active row per canonical role stays active; any further active
 * rows mapping to the same canonical role are set Active=FALSE.
 */
function _mergeRoleRules_() {
  var sh = getSheetOrNull_(SHEETS.ROLE_RULES);
  if (!sh) return { renamed: 0, deactivated: 0, activeCanonical: false };
  var last = sh.getLastRow();
  if (last < 2) return { renamed: 0, deactivated: 0, activeCanonical: false };

  var headers = getHeaderRow_(sh);
  var roleCol   = headers.indexOf('Role');
  var activeCol = headers.indexOf('Active');
  if (roleCol === -1) return { renamed: 0, deactivated: 0, activeCanonical: false };

  var range = sh.getRange(2, 1, last - 1, headers.length);
  var data = range.getValues();
  var keptActive = {}; // canonical role -> true once an active row is kept
  var renamed = 0, deactivated = 0, activeCanonical = false;

  for (var i = 0; i < data.length; i++) {
    var cur = String(data[i][roleCol] || '').trim();
    if (!cur) continue;
    var canon = normalizeRole_(cur);
    if (canon && canon !== cur) { data[i][roleCol] = canon; renamed++; }

    var isActive = activeCol === -1 ? true :
      String(data[i][activeCol]).trim().toUpperCase() === 'TRUE';
    if (!isActive) continue;

    if (keptActive[canon]) {
      if (activeCol !== -1) { data[i][activeCol] = 'FALSE'; deactivated++; }
    } else {
      keptActive[canon] = true;
      if (canon === ROLE_CANONICAL_CX_VALET) activeCanonical = true;
    }
  }
  range.setValues(data);
  return { renamed: renamed, deactivated: deactivated, activeCanonical: activeCanonical };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only
// ─────────────────────────────────────────────────────────────────────────────
function ROLE_NORM_selfTest() {
  var out = ['[ROLE_NORM] selfTest (read-only)…', '  canonical CX role: ' + ROLE_CANONICAL_CX_VALET];
  var cases = ['CX', 'Customer Experience', 'CX / Customer Experience', 'Valet', 'Porter',
               'Valet / Porter', 'Driver', 'Valet Porter', 'Valet Porter Driver', 'CX Dept',
               'CX Department', 'Technician', 'Service Advisor', 'Lube Tech', 'Parts', 'Admin'];
  cases.forEach(function (c) { out.push('   "' + c + '" → "' + normalizeRole_(c) + '"'); });
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
