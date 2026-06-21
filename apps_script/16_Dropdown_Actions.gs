/**
 * 16_Dropdown_Actions.gs
 * Frank's European Service — Recruiting OS
 *
 * The hiring manager's interface to the system. Per project rules, the
 * manager only ever does one of three workflow actions:
 *   1) Pick a value from the "Manager Decision" dropdown on Interview Pipeline.
 *   2) Conduct the interview.
 *   3) Review the daily digest / AI recommendation.
 *
 * This file is the dispatcher for #1. An installable onEdit trigger
 * (installed by 18_Triggers.gs) fires onPipelineEdit(e) when the manager
 * edits any cell. We only act when the edit hits "Manager Decision".
 *
 * Decision → action map (values pulled live from Config DECISION_* keys):
 *
 *   Advance to Live Interview → queue full_interview_booking email →
 *                                Status=FULL_BOOKED
 *   Send Working Interview    → queue working_interview_invitation →
 *                                Status=WORKING_SCHEDULED
 *   Request References        → queue reference_and_culture_invite (BOTH the
 *                                reference-submission form and the culture-fit
 *                                form in one email, 48–72h deadline) →
 *                                Status=REFS_REQUESTED. Everything after this is
 *                                unattended (referee emails, AI grading, grand
 *                                total, leadership report card).
 *   Make Offer                → notify manager (offer prep checklist) +
 *                                queue offer_pending_followup to candidate →
 *                                Status=OFFER_PENDING
 *   Needs More Info           → queue we_are_reviewing
 *   Put in the Drawer         → queue hold_email delayed by DRAWER_EMAIL_DELAY_DAYS,
 *                                Status=IN_DRAWER
 *   Reject                    → queue gracious_decline delayed by REJECTION_EMAIL_DELAY_DAYS
 *                                (cancellable), Status=REJECTED
 *   Archive — No Email        → Status=ARCHIVED, no email sent
 *   Reopen Candidate          → cancel pending rejection/drawer emails,
 *                                Status=MANUAL_REVIEW
 *
 * Public functions:
 *   onPipelineEdit(e)                                  — trigger handler
 *   manuallyDispatchDecision(candidateId, decision)    — repair / dev shortcut
 *   DROPDOWN_selfTest()                                — read-only sanity check
 *   DROPDOWN_dryRunDispatch(candidateId, decisionValue) — full dispatch dry-run with SEND_ENABLED=FALSE
 */

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER HANDLER — installed by 18_Triggers.gs
// ─────────────────────────────────────────────────────────────────────────────

function onPipelineEdit(e) {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('onPipelineEdit', 'OK');
  return safeRun_('onPipelineEdit', function () {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEETS.INTERVIEW_PIPELINE) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return; // single-cell edits only

    var decisionCol = getColIndex_(sh, 'Manager Decision');
    if (!decisionCol || e.range.getColumn() !== decisionCol) return;

    var rowNum = e.range.getRow();
    if (rowNum < 2) return;

    var newValue = String(e.value != null ? e.value : e.range.getValue() || '').trim();
    if (!newValue) return; // cell cleared — ignore

    var rowObj = readRowAsObject_(sh, rowNum);
    var candidateId = String(rowObj['Candidate ID'] || '').trim();
    if (!candidateId) {
      logError_('onPipelineEdit', 'no Candidate ID in row ' + rowNum + ' — populate Candidate ID before selecting a decision', '', 'WARN');
      toast_('Set Candidate ID on this row before picking a decision', 'Recruiting OS', 8);
      return;
    }

    _dispatchPipelineDecision_(candidateId, newValue, rowObj, rowNum);
  });
}

/** Force a dispatch from code (repair, dev test, or smoke-test path). */
function manuallyDispatchDecision(candidateId, decisionValue) {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var hits = findRowsByColumnValue_(sh, 'Candidate ID', candidateId);
    if (!hits.length) throw new Error('manuallyDispatchDecision: candidate not found in Interview Pipeline: ' + candidateId);
    return _dispatchPipelineDecision_(candidateId, decisionValue, hits[0].data, hits[0].rowNum);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

function _dispatchPipelineDecision_(candidateId, decisionValue, candidate, rowNum) {
  var action = _decisionToAction_(decisionValue);
  if (!action) {
    logEvent_('PIPELINE_DECISION_UNRECOGNIZED', candidateId, { value: decisionValue, row: rowNum });
    toast_('Unrecognized decision value: "' + decisionValue + '"', 'Recruiting OS', 6);
    return null;
  }

  logEvent_('PIPELINE_DECISION', candidateId, {
    action: action, value: decisionValue, role: candidate['Role'] || '', row: rowNum
  });

  // F11: every manager dropdown decision is written to the Override Log so routine
  // hiring decisions leave a real audit trail (previously only a manual menu
  // action wrote here, so the tab was always empty).
  if (typeof logOverride_ === 'function') {
    safeRun_('_dispatchPipelineDecision_:overrideLog', function () {
      var actor = '';
      try { actor = Session.getActiveUser().getEmail(); } catch (e) { actor = ''; }
      logOverride_({
        actor:         actor,
        candidateId:   candidateId,
        overrideType:  'Manager Decision (dropdown)',
        previousValue: candidate['Status'] || '',
        newValue:      decisionValue + ' → ' + action,
        reason:        'Manager picked "' + decisionValue + '" on Interview Pipeline row ' + rowNum
      });
    });
  }

  // Record the decision-date + last-updated regardless of branch
  _stampDecision_(candidateId);

  switch (action) {
    case 'ADVANCE_PHONE':   return _dispatchAdvancePhone_(candidateId, candidate);
    case 'ADVANCE_LIVE':    return _dispatchAdvanceLive_(candidateId, candidate);
    case 'ADVANCE_WORKING': return _dispatchAdvanceWorking_(candidateId, candidate);
    case 'REQUEST_REFS':    return _dispatchRequestReferences_(candidateId, candidate);
    case 'MAKE_OFFER':      return _dispatchMakeOffer_(candidateId, candidate);
    case 'NEEDS_INFO':      return _dispatchNeedsInfo_(candidateId, candidate);
    case 'PUT_IN_DRAWER':   return _dispatchDrawer_(candidateId, candidate);
    case 'REJECT':          return _dispatchReject_(candidateId, candidate);
    case 'ARCHIVE':         return _dispatchArchive_(candidateId, candidate);
    case 'REOPEN':          return _dispatchReopen_(candidateId, candidate);
    case 'HIRED':           return _dispatchHired_(candidateId, candidate);
  }
  return null;
}

/** Map the dropdown's visible text back to a canonical action code. */
function _decisionToAction_(value) {
  var s = String(value).trim();
  if (!s) return null;
  if (s === CFG.get('DECISION_ADVANCE_PHONE'))   return 'ADVANCE_PHONE';
  if (s === CFG.get('DECISION_ADVANCE_LIVE'))    return 'ADVANCE_LIVE';
  if (s === CFG.get('DECISION_ADVANCE_WORKING')) return 'ADVANCE_WORKING';
  if (s === CFG.get('DECISION_REQUEST_REFERENCES')) return 'REQUEST_REFS';
  if (s === CFG.get('DECISION_MAKE_OFFER'))      return 'MAKE_OFFER';
  if (s === 'Make Offer')                        return 'MAKE_OFFER';    // legacy label alias
  if (s === 'Mark as Hired')                     return 'HIRED';         // legacy label alias
  if (s === CFG.get('DECISION_NEEDS_INFO'))      return 'NEEDS_INFO';
  if (s === CFG.get('DECISION_PUT_IN_DRAWER'))   return 'PUT_IN_DRAWER';
  if (s === CFG.get('DECISION_REJECT'))          return 'REJECT';
  if (s === CFG.get('DECISION_ARCHIVE'))         return 'ARCHIVE';
  if (s === CFG.get('DECISION_REOPEN'))          return 'REOPEN';
  if (s === CFG.get('DECISION_HIRED'))           return 'HIRED';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL DISPATCH HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function _dispatchAdvancePhone_(candidateId, candidate) {
  // Mirror the auto-routing logic: Technicians get the combined
  // phone-screen-booking + skills-test invite; everyone else gets the plain
  // phone-screen booking.
  var role = String(candidate['Role'] || '').trim();
  var template = (role === 'Technician') ? 'technician_post_prescreen' : 'phone_screen_booking';
  sendTemplatedEmail_(template, candidate['Email'], candidateId, null, {
    reason: 'manager decision: send phone screen booking'
  });
  _setBothStatuses_(candidateId, STATUS.AUTO_BOOK_SENT,
    'Phone screen booking sent (' + template + '): ' + shopDateTime_(),
    { 'Phone Screen Link Sent': shopDateTime_() });
  return { action: 'ADVANCE_PHONE', emailQueued: true, template: template };
}

function _dispatchAdvanceLive_(candidateId, candidate) {
  sendTemplatedEmail_('full_interview_booking', candidate['Email'], candidateId, null, {
    reason: 'manager decision: advance to live interview'
  });
  _setBothStatuses_(candidateId, STATUS.FULL_BOOKED,
    'Full Interview link sent: ' + shopDateTime_(),
    { 'Full Interview Link Sent': shopDateTime_() });
  return { action: 'ADVANCE_LIVE', emailQueued: true };
}

function _dispatchAdvanceWorking_(candidateId, candidate) {
  sendTemplatedEmail_('working_interview_invitation', candidate['Email'], candidateId, null, {
    reason: 'manager decision: working interview'
  });
  _setBothStatuses_(candidateId, STATUS.WORKING_SCHEDULED,
    'Working interview invited: ' + shopDateTime_());
  return { action: 'ADVANCE_WORKING', emailQueued: true };
}

/**
 * "Request References" — the post-live-interview gate. Sends the candidate ONE
 * email containing BOTH the reference-submission form and the culture-fit form,
 * with a single deadline (REFERENCE_CULTURE_DEADLINE_HOURS, default 72h). From
 * here the system runs unattended: candidate submits references → referees are
 * emailed automatically (11_References.gs) → referee + culture responses are AI
 * graded and folded into the grand-total recommendation → a candidate report
 * card is emailed to leadership (37_Report_Card.gs). The manager's only
 * remaining action is Hire ("Mark as Hired") or Not Hire ("Put in the Drawer").
 */
function _dispatchRequestReferences_(candidateId, candidate) {
  var deadline = _referenceCultureDeadline_();
  var combined = CFG.getBool('REFERENCE_CULTURE_COMBINED_EMAIL_ENABLED', true);

  if (combined) {
    sendTemplatedEmail_('reference_and_culture_invite', candidate['Email'], candidateId, {
      ResponseDeadline: deadline.label
    }, {
      reason: 'manager decision: request references + culture fit (combined)'
    });
  } else {
    // Fallback: two separate emails (legacy templates).
    sendTemplatedEmail_('reference_request_candidate', candidate['Email'], candidateId, null, {
      reason: 'manager decision: request references (standalone)'
    });
    if (typeof sendCultureInvite_ === 'function') {
      safeRun_('_dispatchRequestReferences_:culture', function () { sendCultureInvite_(candidateId); });
    }
  }

  _setBothStatuses_(candidateId, STATUS.REFS_REQUESTED,
    'References + culture fit requested — due ' + deadline.label + ' (' + (combined ? 'combined email' : 'two emails') + '): ' + shopDateTime_(),
    {
      'Next Action Due':         deadline.label,
      'Reference Deadline':      shopDateTime_(deadline.at), // parseable — drives the reminder
      'Reference Reminder Sent': ''                          // reset guard for a fresh request
    });
  return { action: 'REQUEST_REFS', emailQueued: true, combined: combined, deadline: deadline.label };
}

/**
 * Deadline for the combined references + culture ask. Returns a Date plus a
 * candidate-friendly label like "Wed, Jun 11 by 5:00 PM".
 */
function _referenceCultureDeadline_() {
  var hours = CFG.getInt('REFERENCE_CULTURE_DEADLINE_HOURS', 72);
  var at = new Date(Date.now() + hours * 60 * 60 * 1000);
  var label = Utilities.formatDate(at, CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles'), 'EEE, MMM d') + ' by 5:00 PM';
  return { at: at, label: label };
}

function _dispatchMakeOffer_(candidateId, candidate) {
  // Notify manager with offer prep checklist
  if (CFG.getBool('OFFER_PREP_ALERT_ENABLED', true)) {
    _queueManagerOfferPrep_(candidateId, candidate);
  }
  // Send candidate a warm "exciting news coming" email
  if (CFG.getBool('OFFER_CANDIDATE_EMAIL_ENABLED', true)) {
    sendTemplatedEmail_('offer_pending_followup', candidate['Email'], candidateId, null, {
      reason: 'manager decision: make offer'
    });
  }
  _setBothStatuses_(candidateId, STATUS.OFFER_PENDING,
    'Offer pending — manager notified, candidate notified: ' + shopDateTime_());
  return { action: 'MAKE_OFFER', managerNotified: true, candidateNotified: CFG.getBool('OFFER_CANDIDATE_EMAIL_ENABLED', true) };
}

function _dispatchNeedsInfo_(candidateId, candidate) {
  sendTemplatedEmail_('we_are_reviewing', candidate['Email'], candidateId, null, {
    reason: 'manager decision: needs more info'
  });
  // Status unchanged — candidate stays in current stage
  return { action: 'NEEDS_INFO', emailQueued: true };
}

function _dispatchDrawer_(candidateId, candidate) {
  var delayDays = CFG.getInt('DRAWER_EMAIL_DELAY_DAYS', 14);
  var sendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
  sendTemplatedEmail_('hold_email', candidate['Email'], candidateId, null, {
    sendAt:           sendAt,
    cancellableUntil: sendAt,
    reason:           'manager decision: drawer (delay ' + delayDays + 'd)'
  });
  _setBothStatuses_(candidateId, STATUS.IN_DRAWER,
    'In drawer — hold email queued for ' + shopDateTime_(sendAt));
  return { action: 'PUT_IN_DRAWER', emailDelayDays: delayDays };
}

function _dispatchReject_(candidateId, candidate) {
  // Capture the disposition reason from the "Rejection Reason" column (optional).
  var reason = String(candidate['Rejection Reason'] || '').trim();
  var reasonSuffix = reason ? ' [reason: ' + reason + ']' : '';
  logEvent_('CANDIDATE_REJECTED', candidateId, { reason: reason || '(unspecified)', role: candidate['Role'] || '' });

  var note;
  if (!CFG.getBool('SEND_REJECTION_EMAIL', true)) {
    _setBothStatuses_(candidateId, STATUS.REJECTED, 'Rejected (no email per config)' + reasonSuffix + ': ' + shopDateTime_());
    return { action: 'REJECT', emailSent: false, rejectionReason: reason, reason: 'SEND_REJECTION_EMAIL=FALSE' };
  }
  var delayDays = CFG.getInt('REJECTION_EMAIL_DELAY_DAYS', 5);
  var sendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
  sendTemplatedEmail_('gracious_decline', candidate['Email'], candidateId, null, {
    sendAt:           sendAt,
    cancellableUntil: sendAt,
    reason:           'manager decision: reject (delay ' + delayDays + 'd, cancellable)'
  });
  note = 'Rejected' + reasonSuffix + ' — decline email queued for ' + shopDateTime_(sendAt) + ' (cancellable via Reopen until then)';
  _setBothStatuses_(candidateId, STATUS.REJECTED, note);
  return { action: 'REJECT', emailDelayDays: delayDays, cancellable: true, rejectionReason: reason };
}

function _dispatchArchive_(candidateId, candidate) {
  _setBothStatuses_(candidateId, STATUS.ARCHIVED, 'Archived silently (no email): ' + shopDateTime_());
  return { action: 'ARCHIVE', emailSent: false };
}

function _dispatchReopen_(candidateId, candidate) {
  // Cancel any pending rejection or drawer emails
  var cancelled = 0;
  cancelled += cancelQueuedEmailsForCandidate_(candidateId, 'gracious_decline');
  cancelled += cancelQueuedEmailsForCandidate_(candidateId, 'hold_email');
  _setBothStatuses_(candidateId, STATUS.MANUAL_REVIEW,
    'Reopened — cancelled ' + cancelled + ' pending email(s): ' + shopDateTime_());
  logEvent_('CANDIDATE_REOPENED', candidateId, { cancelledEmails: cancelled });
  toast_('Candidate reopened — cancelled ' + cancelled + ' pending email(s)', 'Recruiting OS', 6);
  return { action: 'REOPEN', emailsCancelled: cancelled };
}

function _dispatchHired_(candidateId, candidate) {
  // Set status HIRED on both sheets
  _setBothStatuses_(candidateId, STATUS.HIRED,
    'Hired — congratulations email sent: ' + shopDateTime_());

  // Send congratulations to the candidate
  if (CFG.getBool('HIRED_CONGRATULATIONS_EMAIL_ENABLED', true)) {
    sendTemplatedEmail_('hired_congratulations', candidate['Email'], candidateId, null, {
      reason: 'manager decision: mark as hired'
    });
  }

  // Alert manager with onboarding checklist
  if (CFG.getBool('HIRED_MANAGER_CHECKLIST_ENABLED', true)) {
    safeRun_('_dispatchHired_:managerAlert', function () {
      var first = candidate['First Name'] || String(candidate['Full Name'] || '').split(' ')[0] || '';
      var last  = candidate['Last Name']  || '';
      var name  = (first + ' ' + last).trim();
      var role  = candidate['Role'] || '';
      queueEmail_({
        to:          CFG.get('HIRING_MANAGER_EMAIL'),
        subject:     'HIRED — ' + name + (role ? ' (' + role + ')' : '') + ' — onboarding checklist',
        body:
'Congratulations email has been sent to ' + name + '.\n\n' +
'ONBOARDING CHECKLIST:\n' +
'  [ ] Confirm start date and first-day schedule\n' +
'  [ ] Set up payroll and direct deposit\n' +
'  [ ] Issue shop email / accounts\n' +
'  [ ] Assign locker / bay / workstation\n' +
'  [ ] Schedule onboarding walkthrough\n' +
'  [ ] Send parking and first-day logistics\n' +
'  [ ] Notify team of new hire and start date\n\n' +
'CANDIDATE DETAILS:\n' +
'  Name  : ' + name + '\n' +
'  Email : ' + (candidate['Email'] || '') + '\n' +
'  Phone : ' + (candidate['Phone'] || '') + '\n' +
'  Role  : ' + role + '\n' +
'  ID    : ' + candidateId + '\n\n' +
'— Recruiting OS',
        candidateId: candidateId,
        templateKey: '__manager_hired_checklist__',
        reason:      'manager hired — onboarding checklist'
      });
    });
  }

  logEvent_('CANDIDATE_HIRED', candidateId, { role: candidate['Role'] || '' });
  toast_(candidate['First Name'] || 'Candidate' + ' marked as hired — congratulations email sent.', 'Recruiting OS', 6);
  return { action: 'HIRED', emailQueued: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGER-FACING NOTIFICATION (offer prep checklist)
// ─────────────────────────────────────────────────────────────────────────────

function _queueManagerOfferPrep_(candidateId, candidate) {
  var first = candidate['First Name'] || (String(candidate['Full Name'] || '').split(' ')[0]) || '(unknown)';
  var last  = candidate['Last Name']  || (String(candidate['Full Name'] || '').split(' ').slice(1).join(' ')) || '';
  var role  = candidate['Role'] || '(unknown role)';
  var rr    = _getRoleRule_(role);
  var payRange = (rr && rr['Pay Range']) ? rr['Pay Range'] : '(set Pay Range in Role Rules)';

  var subject = 'OFFER PREP — ' + (first + ' ' + last).trim() + ' — ' + role;
  var body =
'Manager,\n\n' +
'You selected "Make Offer" for ' + (first + ' ' + last).trim() + ' (' + role + ').\n\n' +
'OFFER PREP CHECKLIST:\n' +
'  [ ] Confirm pay within Role Rules pay range:  ' + payRange + '\n' +
'  [ ] Confirm proposed start date with shop schedule\n' +
'  [ ] Background check & driving record verified\n' +
'  [ ] Reference summary reviewed (see candidate references)\n' +
'  [ ] Generate formal offer letter\n' +
'  [ ] Schedule offer call with candidate\n\n' +
'CANDIDATE DETAILS:\n' +
'  Name : ' + (first + ' ' + last).trim() + '\n' +
'  Email: ' + (candidate['Email'] || '') + '\n' +
'  Phone: ' + (candidate['Phone'] || '') + '\n' +
'  Role : ' + role + '\n' +
'  ID   : ' + candidateId + '\n\n' +
'Candidate has been sent the "offer pending" warm-up email if OFFER_CANDIDATE_EMAIL_ENABLED=TRUE.\n\n' +
'— Recruiting OS';

  queueEmail_({
    to:           CFG.get('HIRING_MANAGER_EMAIL'),
    subject:      subject,
    body:         body,
    candidateId:  candidateId,
    templateKey:  '__manager_offer_prep__',
    reason:       'manager offer prep alert'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — status updates across All Candidates and Interview Pipeline
// ─────────────────────────────────────────────────────────────────────────────

function _setBothStatuses_(candidateId, status, note, extra) {
  var stamp = shopDateTime_();
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    var ipUpdates = {
      'Status':       status,
      'Last Updated': stamp,
      'Notes':        note || ''
    };
    if (extra) Object.keys(extra).forEach(function (k) { ipUpdates[k] = extra[k]; });
    updateRowWhere_(ip, 'Candidate ID', candidateId, ipUpdates);
  }
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (ac) {
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       status,
      'Last Updated': stamp
    });
  }
}

function _stampDecision_(candidateId) {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return;
  updateRowWhere_(ip, 'Candidate ID', candidateId, {
    'Decision Date': shopDateTime_(),
    'Last Updated':  shopDateTime_()
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK "WE ARE REVIEWING" SEND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the "we_are_reviewing" email to every candidate currently sitting in
 * MANUAL_REVIEW status who has not already received it within the dedup
 * window (EMAIL_DUPE_TEMPLATE_WINDOW_DAYS, default 7 days).
 *
 * Intended use cases:
 *   1) Run manually from the menu any time you want to make sure every
 *      pending candidate has been acknowledged.
 *   2) Run at the start of a hiring cycle to notify a batch of candidates
 *      who came in while the system was in TEST mode.
 *
 * Idempotent: the email queue's 7-day dedup gate prevents double-sends.
 * Does NOT change candidate status. Does NOT affect candidates who are
 * already in a later stage (AUTO_BOOK_SENT, PHONE_BOOKED, etc.).
 */
function sendReviewingEmailToPendingCandidates() {
  return withLock_(function () {
    var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
    if (!ac) {
      toast_('All Candidates sheet not found', 'Recruiting OS', 6);
      return 'All Candidates sheet missing';
    }
    var last = ac.getLastRow();
    if (last < 2) return 'No candidates found';

    var headers  = getHeaderRow_(ac);
    var hStatus  = headers.indexOf('Status');
    var hEmail   = headers.indexOf('Email');
    var hCid     = headers.indexOf('Candidate ID');
    if (hStatus === -1 || hEmail === -1 || hCid === -1) {
      return 'Missing columns (Status, Email, or Candidate ID) in All Candidates';
    }

    // Only candidates actively in manual review — not yet advanced, not yet
    // rejected, and not already acknowledged by a later-stage email.
    var TARGET_STATUSES = [STATUS.MANUAL_REVIEW, STATUS.SCORED];
    var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, queued: 0, skipped: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var st  = String(data[i][hStatus] || '').trim().toUpperCase();
      var cid = String(data[i][hCid]    || '').trim();
      var em  = String(data[i][hEmail]  || '').trim();

      if (!cid || !em || TARGET_STATUSES.indexOf(st) === -1) {
        summary.skipped++;
        continue;
      }

      // Build a minimal candidate object for merge fields
      var candidate = {};
      headers.forEach(function (h, j) { candidate[h] = data[i][j]; });

      sendTemplatedEmail_('we_are_reviewing', em, cid, null, {
        reason: 'manual menu: send reviewing notice to pending candidates'
      });
      summary.queued++;
    }

    var msg = 'Queued "we are reviewing" email for ' + summary.queued + ' candidate(s) — ' +
              summary.skipped + ' skipped (wrong status or missing data)';
    Logger.log('[DROPDOWN] sendReviewingEmailToPendingCandidates — ' + msg);
    toast_(msg, 'Recruiting OS', 8);
    logEvent_('BULK_REVIEWING_EMAIL_QUEUED', '', summary);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TESTS
// ─────────────────────────────────────────────────────────────────────────────

function DROPDOWN_selfTest() {
  var out = ['[DROPDOWN] selfTest (read-only)…'];

  // 1) Verify every DECISION_* key maps to an action
  var keys = ['DECISION_ADVANCE_PHONE', 'DECISION_ADVANCE_LIVE', 'DECISION_ADVANCE_WORKING',
              'DECISION_REQUEST_REFERENCES', 'DECISION_MAKE_OFFER', 'DECISION_NEEDS_INFO',
              'DECISION_PUT_IN_DRAWER', 'DECISION_REJECT', 'DECISION_ARCHIVE',
              'DECISION_REOPEN', 'DECISION_HIRED'];
  keys.forEach(function (k) {
    var v = CFG.get(k);
    var action = v ? _decisionToAction_(v) : null;
    out.push('  ' + (action ? '✓' : '✗') + ' ' + k.padEnd(28, ' ') +
             ' value="' + v + '"  →  ' + (action || '(unmapped)'));
  });

  // 1b) Show the order the dropdown will render in (happy path first)
  if (typeof MANAGER_DECISION_ORDER !== 'undefined') {
    out.push('  ─ dropdown order:');
    MANAGER_DECISION_ORDER.forEach(function (k, idx) {
      var v = CFG.get(k);
      if (v) out.push('       ' + (idx + 1) + '. ' + v);
    });
  }

  // 2) Confirm Interview Pipeline tab + Manager Decision column exist
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  out.push('  ' + (ip ? '✓' : '✗') + ' Interview Pipeline tab present');
  if (ip) {
    var col = getColIndex_(ip, 'Manager Decision');
    out.push('  ' + (col ? '✓' : '✗') + ' Manager Decision column present' + (col ? ' (col ' + col + ')' : ''));
  }

  // 3) Confirm onEdit trigger installed (informational only)
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getEventType() === ScriptApp.EventType.ON_EDIT &&
           t.getHandlerFunction() === 'onPipelineEdit';
  });
  out.push('  ─ onPipelineEdit triggers installed: ' + triggers.length +
           (triggers.length ? ' (active)' : ' (NOT installed yet — happens via installAllTriggers())'));

  out.push('[DROPDOWN] selfTest done. Use DROPDOWN_dryRunDispatch(candidateId, decisionValue) to test a real dispatch.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Run a real dispatch with SEND_ENABLED forced FALSE so no emails leave.
 * Use this to validate dispatch wiring against any real candidate in the
 * Interview Pipeline without affecting them.
 *
 *   DROPDOWN_dryRunDispatch('FES-TEC-15AD0B8A', 'Reject')
 */
function DROPDOWN_dryRunDispatch(candidateId, decisionValue) {
  if (!candidateId)    return '[DROPDOWN] dryRun needs candidateId';
  if (!decisionValue)  return '[DROPDOWN] dryRun needs decisionValue';
  var sendBefore = CFG.get('SEND_ENABLED');
  CFG.set('SEND_ENABLED', 'FALSE');
  var msg;
  try {
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var hits = findRowsByColumnValue_(sh, 'Candidate ID', candidateId);
    if (!hits.length) { msg = '[DROPDOWN] dryRun: candidate not in Interview Pipeline: ' + candidateId; }
    else {
      var result = _dispatchPipelineDecision_(candidateId, decisionValue, hits[0].data, hits[0].rowNum);
      msg = '[DROPDOWN] dryRun complete — ' + JSON.stringify(result) +
            '. Email Queue rows are BLOCKED (SEND_ENABLED was FALSE).';
    }
  } catch (e) {
    msg = '[DROPDOWN] dryRun ERROR: ' + e.message;
  } finally {
    CFG.set('SEND_ENABLED', sendBefore);
  }
  Logger.log(msg);
  return msg;
}
