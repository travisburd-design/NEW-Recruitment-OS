/**
 * 05_Candidate_Intake.gs
 * Frank's European Service — Recruiting OS
 *
 * Entry point of the pipeline. Handles Google Form pre-screen submissions.
 *
 *   Form submit on PRESCREEN → onPreScreenSubmit(e)
 *     → _processPreScreenRow_(rowNum)
 *         → extract canonical fields (name, email, role, etc.)
 *         → generate stable Candidate ID (email+role hash → idempotent)
 *         → upsert row in All Candidates (dedupe by Candidate ID)
 *         → queue application_confirmation email (if enabled)
 *         → call scorePreScreen_(candidateId) in 06_Scoring_Risk.gs
 *
 * Hard rules:
 *   - All field extraction is case-insensitive and tolerant of column drift.
 *   - The form has two "Email Address" columns (auto-collected + asked); we
 *     take whichever is non-empty.
 *   - Role values are normalized to canonical Role Rules names; unknown roles
 *     pass through as-is so manual review can fix them.
 *
 * Public functions:
 *   onPreScreenSubmit(e)        — form trigger handler (registered by 04_Forms)
 *   processPreScreenRow(rowNum) — manual / repair: process one specific row
 *   reprocessAllPreScreens()    — bulk repair: re-process every Pre-Screen row
 *   INTAKE_selfTest()           — synthetic test row, asserts upsert/dedupe
 */

// ─────────────────────────────────────────────────────────────────────────────
// FORM SUBMIT HANDLER (registered by 04_Forms.installAllFormTriggers)
// ─────────────────────────────────────────────────────────────────────────────

function onPreScreenSubmit(e) {
  return safeRun_('onPreScreenSubmit', function () {
    if (!e || !e.range) {
      logError_('onPreScreenSubmit', 'event missing .range', '', 'WARN');
      return null;
    }
    var rowNum = e.range.getRow();
    return _processPreScreenRow_(rowNum, /*fromTrigger=*/true);
  });
}

/** Manually re-process a Pre-Screen response row. Safe to run anytime. */
function processPreScreenRow(rowNum) {
  return withLock_(function () {
    return _processPreScreenRow_(rowNum, /*fromTrigger=*/false);
  });
}

/** Bulk repair: re-process every Pre-Screen row. Dedupe ensures idempotency. */
function reprocessAllPreScreens() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_PRESCREEN);
    var last = sh.getLastRow();
    if (last < 2) return '[INTAKE] no Pre-Screen rows to reprocess';
    var processed = 0, skipped = 0, errors = 0;
    for (var r = 2; r <= last; r++) {
      try {
        var cid = _processPreScreenRow_(r, false);
        if (cid) processed++; else skipped++;
      } catch (e) {
        errors++;
        logError_('reprocessAllPreScreens:row' + r, e, '', 'ERROR');
      }
    }
    var msg = '[INTAKE] reprocessAllPreScreens — processed=' + processed +
              ' skipped=' + skipped + ' errors=' + errors;
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: process one Pre-Screen response row → upsert candidate → score
// ─────────────────────────────────────────────────────────────────────────────

function _processPreScreenRow_(rowNum, fromTrigger) {
  var sh = getSheet_(SHEETS.RAW_PRESCREEN);
  if (rowNum < 2 || rowNum > sh.getLastRow()) {
    throw new Error('_processPreScreenRow_: invalid row ' + rowNum);
  }

  var fields = _extractPreScreenFields_(rowNum);
  if (!fields.email) {
    logError_('intake:noEmail', 'Pre-Screen row ' + rowNum + ' has no email', '', 'WARN');
    return null;
  }
  if (!fields.role) {
    logError_('intake:noRole', 'Pre-Screen row ' + rowNum + ' has no role', '', 'WARN');
    return null;
  }

  var candidateId = candidateIdFromEmail_(fields.email, fields.role);
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var existing = findRowsByColumnValue_(ac, 'Candidate ID', candidateId);

  if (existing.length) {
    // Update existing — only refresh Form Completed timestamp + Status
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Form Completed': shopDateTime_(),
      'Status':         STATUS.PRESCREEN_RECEIVED,
      'Last Updated':   shopDateTime_()
    });
    logEvent_('CANDIDATE_RESUBMIT', candidateId, { formRow: rowNum, role: fields.role });
  } else {
    // Create new
    var hm = _getActiveHiringManager_();
    appendRowByHeader_(ac, {
      'Date Received':    shopDateTime_(),
      'Role':             fields.role,
      'First Name':       fields.firstName,
      'Last Name':        fields.lastName,
      'Email':            fields.email,
      'Phone':            fields.phone,
      'Source':           fields.source,
      'Resume Link':      fields.resume,
      'Form Sent':        shopDateTime_(),  // assume sent at the moment they submit
      'Form Completed':   shopDateTime_(),
      'Status':           STATUS.PRESCREEN_RECEIVED,
      'Notes':            truncate_(fields.notes, 500),
      'Candidate ID':     candidateId,
      'Hiring Manager':   hm ? hm['Hiring Manager Name'] : CFG.get('HIRING_MANAGER_NAME'),
      'Last Updated':     shopDateTime_()
    });
    logEvent_('CANDIDATE_INTAKE', candidateId, {
      role: fields.role, email: fields.email, source: fields.source, formRow: rowNum,
      via: fromTrigger ? 'form_trigger' : 'manual'
    });

    // Acknowledgment email (only on first creation)
    if (CFG.getBool('SEND_ACKNOWLEDGMENT_EMAIL', true)) {
      safeRun_('intake:ackEmail', function () {
        sendTemplatedEmail_('application_confirmation', fields.email, candidateId);
      });
    }
  }

  // Score (delegates to 06_Scoring_Risk.gs)
  if (typeof scorePreScreen_ === 'function') {
    safeRun_('intake:score', function () { scorePreScreen_(candidateId); });
  } else {
    logError_('intake:scoringMissing', 'scorePreScreen_ not loaded yet — paste 06_Scoring_Risk.gs', candidateId, 'WARN');
  }

  // AI-grade the resume against the role (delegates to 29_Resume_Grading.gs)
  safeRun_('intake:resume', function () {
    if (typeof gradeResumeForCandidate_ === 'function') gradeResumeForCandidate_(candidateId);
  });

  return candidateId;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pulls canonical identity + intake fields from a Pre-Screen response row.
 * Header lookups are case-insensitive; duplicate-name headers (the form has
 * two "Email Address" columns) collapse to the first non-empty value.
 */
function _extractPreScreenFields_(formRow) {
  var sh = getSheet_(SHEETS.RAW_PRESCREEN);
  var headers = getHeaderRow_(sh);
  var values = sh.getRange(formRow, 1, 1, headers.length).getValues()[0];

  // headerLower → first non-empty value
  var byHeader = {};
  headers.forEach(function (h, i) {
    var k = String(h || '').trim().toLowerCase();
    if (!k) return;
    var v = String(values[i] == null ? '' : values[i]).trim();
    if (v && !byHeader[k]) byHeader[k] = v;
  });

  function pick(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var v = byHeader[String(candidates[i]).toLowerCase()];
      if (v) return v;
    }
    return '';
  }

  var fullName = pick(['full name', 'name']);
  var parts = fullName ? fullName.split(/\s+/) : [];
  var firstName = parts.shift() || '';
  var lastName  = parts.join(' ');

  return {
    email:     normalizeEmail_(pick(['email address', 'email'])),
    firstName: firstName,
    lastName:  lastName,
    phone:     normalizePhone_(pick(['best phone number', 'phone number', 'phone'])),
    source:    pick(['how did you hear about this position?', 'source']),
    rawRole:   pick(['select the role that best matches your application.', 'role']),
    role:      normalizeRole_(pick(['select the role that best matches your application.', 'role'])),
    resume:    pick(['resume or linkedin url', 'resume', 'linkedin url', 'linkedin']),
    notes:     pick(['is there anything else you would like us to know about you?', 'notes', 'comments'])
  };
}

/**
 * Map free-form role text to a canonical Role Rules name. Canonical engine for
 * the whole system (intake, scoring routing, backfill, dashboards). CX, Valet,
 * Porter, and Driver are one unified role: 'CX / Valet Porter Driver'.
 * Unknown roles pass through unchanged so manual review can fix them.
 */
function normalizeRole_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var lc = s.toLowerCase();

  // Match "technician" anywhere (e.g. "European Automotive Technician"), but let a
  // "lube technician" fall through to the Lube Tech rule below.
  if (lc.indexOf('lube') === -1 &&
      (lc.indexOf('technician') !== -1 || lc === 'tech' || lc.indexOf('european tech') !== -1)) return 'Technician';
  if (lc.indexOf('shop foreman') !== -1 || lc === 'foreman') return 'Shop Foreman';
  if (lc.indexOf('service advisor') !== -1 || lc === 'advisor' || lc === 'sa') return 'Service Advisor';
  if (lc.indexOf('lube') !== -1) return 'Lube Tech';
  // Unified CX / Valet / Porter / Driver role.
  if (lc.indexOf('valet') !== -1 || lc.indexOf('porter') !== -1 || lc.indexOf('driver') !== -1 ||
      lc.indexOf('cx') !== -1 || lc.indexOf('customer experience') !== -1 || lc.indexOf('customer service') !== -1) {
    return ROLE_CANONICAL_CX_VALET;
  }
  if (lc.indexOf('parts') !== -1) return 'Parts';
  if (lc === 'admin' || lc.indexOf('administ') !== -1 || lc.indexOf('office') !== -1) return 'Admin';

  return s; // unknown — surface as-is for human triage
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// Creates synthetic Pre-Screen row + candidate, asserts upsert/dedupe,
// cleans up everything before returning. Skips AI scoring to avoid cost.
// ─────────────────────────────────────────────────────────────────────────────
function INTAKE_selfTest() {
  var out = ['[INTAKE] selfTest starting (no AI call, no email sent)…'];

  // Hard guard: disable sending for the duration of the test
  var sendBefore = CFG.get('SEND_ENABLED');
  CFG.set('SEND_ENABLED', 'FALSE');

  var ps = getSheetOrNull_(SHEETS.RAW_PRESCREEN);
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ps || !ac) {
    CFG.set('SEND_ENABLED', sendBefore);
    out.push('  ✗ Required sheets missing (Pre-Screen and/or All Candidates) — run bootstrapSystem() first');
    Logger.log(out.join('\n')); return out.join('\n');
  }

  var headers = getHeaderRow_(ps);
  var testEmail = 'selftest_intake_' + Date.now() + '@example.com';
  var testRole  = 'Technician';

  // Build a synthetic Pre-Screen row matching the form's columns
  var rowData = headers.map(function (h) {
    var lc = String(h || '').toLowerCase();
    if (!lc) return '';
    if (lc.indexOf('timestamp') !== -1) return new Date();
    if (lc === 'full name') return 'Selftest IntakeUser';
    if (lc.indexOf('email') !== -1) return testEmail;
    if (lc.indexOf('phone') !== -1) return '7025551212';
    if (lc.indexOf('how did you hear') !== -1) return 'SelfTest';
    if (lc.indexOf('select the role') !== -1) return testRole;
    if (lc.indexOf('how much direct automotive technician experience') !== -1) return '5+ years';
    if (lc.indexOf('availability') !== -1) return 'Full-time';
    return '';
  });
  ps.appendRow(rowData);
  var psRowNum = ps.getLastRow();
  out.push('  ✓ synthetic Pre-Screen row appended at row ' + psRowNum);

  var cid = candidateIdFromEmail_(testEmail, testRole);
  out.push('  ─ expected Candidate ID: ' + cid);

  // First process — should CREATE
  var acBefore = ac.getLastRow();
  try {
    _processPreScreenRow_(psRowNum, false);
  } catch (e) {
    out.push('  ✗ first _processPreScreenRow_ threw: ' + e.message);
  }
  var acAfter1 = ac.getLastRow();
  out.push('  ' + (acAfter1 === acBefore + 1 ? '✓' : '✗') +
           ' All Candidates row created (rows before=' + acBefore + ' after=' + acAfter1 + ')');

  // Verify Candidate ID, Role, Status on the new row
  var hits = findRowsByColumnValue_(ac, 'Candidate ID', cid);
  if (hits.length === 1) {
    out.push('  ✓ candidate findable by Candidate ID');
    out.push('    Role=' + hits[0].data['Role'] + '  Status=' + hits[0].data['Status'] +
             '  Email=' + hits[0].data['Email']);
  } else {
    out.push('  ✗ expected 1 hit for Candidate ID, got ' + hits.length);
  }

  // Second process — should UPDATE (no new row)
  try {
    _processPreScreenRow_(psRowNum, false);
  } catch (e) {
    out.push('  ✗ second _processPreScreenRow_ threw: ' + e.message);
  }
  var acAfter2 = ac.getLastRow();
  out.push('  ' + (acAfter2 === acAfter1 ? '✓' : '✗') +
           ' dedupe held — no new All Candidates row on re-submit (rows=' + acAfter2 + ')');

  // Cleanup
  try { ps.deleteRow(psRowNum); out.push('  ✓ deleted synthetic Pre-Screen row'); }
  catch (e) { out.push('  ⚠ could not delete Pre-Screen row ' + psRowNum + ': ' + e.message); }

  var cleanupHits = findRowsByColumnValue_(ac, 'Candidate ID', cid);
  cleanupHits.reverse().forEach(function (h) {
    try { ac.deleteRow(h.rowNum); }
    catch (e) { out.push('  ⚠ could not delete candidate row ' + h.rowNum + ': ' + e.message); }
  });
  out.push('  ✓ deleted ' + cleanupHits.length + ' synthetic candidate row(s)');

  CFG.set('SEND_ENABLED', sendBefore);
  out.push('  ─ SEND_ENABLED restored to ' + sendBefore);
  out.push('[INTAKE] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
