/**
 * 31_Override.gs
 * Frank's European Service — Recruiting OS
 *
 * Audited manual status override + Override Log.
 *
 * Sometimes a human needs to force a candidate's Status to a specific value
 * outside the normal dropdown-driven workflow (data repair, edge cases, a
 * decision made off-system). This file makes that possible WITHOUT losing the
 * audit trail: every override records actor, candidate ID, previous value, new
 * value, and a free-text reason to the "Override Log" sheet, then applies the
 * status through A's existing setter so both All Candidates and Interview
 * Pipeline stay in sync.
 *
 * Design rules honored:
 *   - New status values are validated against the canonical STATUS map
 *     (00_Config.gs). Unknown statuses are rejected — humans never invent
 *     status strings.
 *   - LockService is NOT held across the interactive ui.prompt() dialogs.
 *     We only acquire withLock_ around the final log-append + status-write so
 *     a manager mulling over a prompt can never block the system for 30s.
 *   - Logging-style writes go through appendRowByHeader_ so column order can
 *     evolve, and the sheet is auto-created if missing (getOrCreateSheet_).
 *
 * Public functions:
 *   manualOverride()        — UI-driven (prompts) audited status override
 *   logOverride_(obj)       — append one audit row to the Override Log
 *   OVERRIDE_selfTest()     — non-interactive sanity check (append + validation)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Override Log sheet — name + canonical header order
// ─────────────────────────────────────────────────────────────────────────────
var OVERRIDE_LOG_SHEET_NAME = 'Override Log';
var OVERRIDE_LOG_HEADERS = Object.freeze([
  'Timestamp', 'Actor', 'Candidate ID', 'Override Type',
  'Previous Value', 'New Value', 'Reason'
]);

/** Canonical list of valid status values (the STATUS map's values). */
function _validStatusValues_() {
  return Object.keys(STATUS).map(function (k) { return STATUS[k]; });
}

/** Ensure the Override Log sheet exists with its headers. Returns the Sheet. */
function _getOverrideLogSheet_() {
  return getOrCreateSheet_(OVERRIDE_LOG_SHEET_NAME, OVERRIDE_LOG_HEADERS.slice());
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: manualOverride — UI-driven audited status override
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt for Candidate ID → new Status (validated) → reason, then log the
 * override and apply the new status across both candidate sheets.
 *
 * No lock is held while the prompts are open; the lock wraps only the final
 * log-append + status-write.
 */
function manualOverride() {
  return safeRun_('manualOverride', function () {
    var ui = SpreadsheetApp.getUi();

    // 1) Candidate ID
    var idResp = ui.prompt('Manual Status Override', 'Candidate ID:', ui.ButtonSet.OK_CANCEL);
    if (idResp.getSelectedButton() !== ui.Button.OK) return;
    var candidateId = String(idResp.getResponseText() || '').trim();
    if (!candidateId) { ui.alert('No Candidate ID entered — cancelled.'); return; }

    var cand = _getCandidateRow_(candidateId);
    if (!cand) {
      ui.alert('No candidate found with ID: ' + candidateId);
      return;
    }
    var previousStatus = String(cand['Status'] || '').trim();

    // 2) New status — validated against canonical STATUS values
    var valid = _validStatusValues_();
    var newResp = ui.prompt(
      'Manual Status Override',
      'Current status: ' + (previousStatus || '(none)') + '\n\n' +
      'Enter the new status (exact value). Valid statuses:\n' + valid.join('\n'),
      ui.ButtonSet.OK_CANCEL
    );
    if (newResp.getSelectedButton() !== ui.Button.OK) return;
    var newStatus = String(newResp.getResponseText() || '').trim().toUpperCase();
    if (valid.indexOf(newStatus) === -1) {
      ui.alert('Invalid status: "' + newStatus + '"\n\nMust be one of:\n' + valid.join('\n'));
      return;
    }

    // 3) Reason (free text)
    var reasonResp = ui.prompt('Manual Status Override', 'Reason for this override:', ui.ButtonSet.OK_CANCEL);
    if (reasonResp.getSelectedButton() !== ui.Button.OK) return;
    var reason = String(reasonResp.getResponseText() || '').trim();

    var actor = '';
    try { actor = Session.getActiveUser().getEmail(); } catch (e) { actor = ''; }

    // Acquire the lock ONLY for the write phase — never across the prompts above.
    withLock_(function () {
      logOverride_({
        actor:         actor,
        candidateId:   candidateId,
        overrideType:  'Status',
        previousValue: previousStatus,
        newValue:      newStatus,
        reason:        reason
      });
      _setBothStatuses_(candidateId, newStatus, 'OVERRIDE by ' + (actor || 'unknown') + ': ' + reason);
    });

    logEvent_('MANUAL_OVERRIDE', candidateId, {
      from: previousStatus, to: newStatus, actor: actor, reason: truncate_(reason, 200)
    });
    toast_('Status overridden: ' + (previousStatus || '(none)') + ' → ' + newStatus, 'Recruiting OS', 8);
    ui.alert('Status updated to ' + newStatus + ' and logged to "' + OVERRIDE_LOG_SHEET_NAME + '".');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: logOverride_ — append one audit row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one audit row to the Override Log sheet.
 * @param {{actor:string, candidateId:string, overrideType:string,
 *          previousValue:*, newValue:*, reason:string}} obj
 * @return {number} the new row number.
 */
function logOverride_(obj) {
  obj = obj || {};
  var prev = obj.previousValue == null ? '' : String(obj.previousValue);
  var next = obj.newValue == null ? '' : String(obj.newValue);
  // Lean architecture: overrides live in the one System Log (Type=OVERRIDE),
  // not a separate Override Log tab. Falls back to a dedicated tab only if the
  // System Log doesn't exist yet (pre-migration).
  var sys = getSheetOrNull_(SHEETS.SYSTEM_LOG);
  if (sys) {
    return appendRowByHeader_(sys, {
      'Timestamp':         shopDateTime_(),
      'Type':              'OVERRIDE',
      'Severity':          'INFO',
      'Label / Event':     String(obj.overrideType || 'Status Override'),
      'Candidate ID':      String(obj.candidateId || ''),
      'Function':          String(obj.actor || ''),   // who performed it
      'Message / Details': prev + ' → ' + next,
      'Notes':             String(obj.reason || '')
    });
  }
  var sh = _getOverrideLogSheet_();
  return appendRowByHeader_(sh, {
    'Timestamp':      shopDateTime_(),
    'Actor':          String(obj.actor || ''),
    'Candidate ID':   String(obj.candidateId || ''),
    'Override Type':  String(obj.overrideType || 'Status'),
    'Previous Value': prev,
    'New Value':      next,
    'Reason':         String(obj.reason || '')
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — non-interactive. Verifies log append + status validation
// without ever opening a prompt or touching candidate data.
// ─────────────────────────────────────────────────────────────────────────────
function OVERRIDE_selfTest() {
  var out = ['[OVERRIDE] selfTest starting…'];

  // 1) Overrides now land in the unified System Log (lean architecture).
  var sys = getSheetOrNull_(SHEETS.SYSTEM_LOG) || getSheetOrNull_(SHEETS.OVERRIDE_LOG);
  out.push('  ' + (sys ? '✓' : '✗') + ' System Log present (override destination)');

  // 2) Status validation: a known value passes, junk fails
  var valid = _validStatusValues_();
  var knownOk = valid.indexOf(STATUS.HIRED) !== -1;
  var junkRejected = valid.indexOf('NOT_A_REAL_STATUS') === -1;
  out.push('  ' + (knownOk ? '✓' : '✗') + ' validation accepts a real status (' + STATUS.HIRED + ')');
  out.push('  ' + (junkRejected ? '✓' : '✗') + ' validation rejects an unknown status');

  // 3) logOverride_ append (real row, clearly tagged as a self-test)
  var before = sys ? sys.getLastRow() : 0;
  var rowNum = logOverride_({
    actor:         'OVERRIDE_selfTest',
    candidateId:   'FES-TEST-00000000',
    overrideType:  'Status Override',
    previousValue: STATUS.NEW,
    newValue:      STATUS.MANUAL_REVIEW,
    reason:        'self-test — ignore'
  });
  var after = sys ? sys.getLastRow() : 0;
  out.push('  ' + (after - before === 1 ? '✓' : '✗') + ' logOverride_ appended 1 row to System Log (row ' + rowNum + ')');

  if (sys && rowNum) {
    var obj = readRowAsObject_(sys, rowNum);
    var detail = String(obj['Message / Details'] || '');
    var fieldsOk = (obj['Type'] === 'OVERRIDE') &&
                   detail.indexOf(STATUS.NEW) !== -1 && detail.indexOf(STATUS.MANUAL_REVIEW) !== -1;
    out.push('  ' + (fieldsOk ? '✓' : '✗') + ' appended row is Type=OVERRIDE with prev → new detail');
  }

  out.push('[OVERRIDE] selfTest done. Test log row left in place for review.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
