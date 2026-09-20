/**
 * ZZ_Live_Advance.gs
 * Frank's European Service — Recruiting OS
 *
 * OPTION A — ASSESSMENT → LIVE INTERVIEW (phone-screen stage retired).
 * Approved by Travis Burd 9/17/2026.
 *
 * WHAT CHANGES
 * ------------
 *   Before: pre-screen scored → AUTO_BOOK → phone-screen link → Travis runs a
 *           15-min call → transcript graded → PHONE_DONE → 46_Auto_Advance →
 *           live-interview link. The phone screen was the human bottleneck.
 *   After:  pre-screen scored → AUTO_BOOK → queued in "Live Advance Queue"
 *           with a hold → manager heads-up (no action = it sends) → the
 *           45-min LIVE INTERVIEW booking link goes out. Travis's only touch
 *           is attending the interview the candidate self-scheduled.
 *
 * HOW IT PLUGS IN (ZZ_ prefix = loads last, overrides earlier definitions)
 * ---------------------------------------------------------------------
 *   • Overrides _dispatchPostScoringEmails_ (06_Scoring_Risk.gs). Every gate
 *     that already decides AUTO_BOOK — role score bar, risk ceiling, hard
 *     gates, deterministic backstop, Auto Send Booking per role, once-only
 *     email ledger, TEST-mode rerouting — is untouched. Only the DESTINATION
 *     of a passing candidate changes: live link instead of phone link.
 *   • Everything downstream is unchanged: Koalendar → calendar poll →
 *     FULL_BOOKED → day-of worksheet → Fathom/Otter transcript → AI grade →
 *     manager decision (Request References / Hire / Drawer).
 *   • 46_Auto_Advance.gs (PHONE_DONE → live) is left in place but is now a
 *     no-op for new candidates because nobody reaches PHONE_DONE.
 *
 * SAFETY
 * ------
 *   • Master switch LIVE_ADVANCE_ENABLED defaults FALSE. Until TRUE the legacy
 *     phone-screen path runs exactly as before.
 *   • Prompt-version gate: refuses to auto-send if the "prescreen" AI prompt is
 *     the v1 seed body (the 9/6 FIX-EVERYTHING revert). Blocked candidates go
 *     to MANUAL_REVIEW and the manager is alerted — never silently dropped.
 *   • Hold + veto: LIVE_ADVANCE_HOLD_MINUTES (default 60). Cancel by setting the
 *     candidate's Manager Decision to anything, or Status=CANCELLED on their
 *     "Live Advance Queue" row.
 *   • Daily cap: LIVE_ADVANCE_DAILY_CAP releases per day (default 2). Anything
 *     over the cap waits for the next day — it is never lost.
 *   • Optional second gate: LIVE_ADVANCE_REQUIRE_ASSESSMENT (default FALSE
 *     until the role-scenario questions are live on the form and the backtest
 *     shows sane pass rates). When TRUE, the 35_Assessments decision must also
 *     be AUTO_BOOK_SENT or the candidate is held for review.
 *   • Timeouts: link sent but not booked → reminder after N working days →
 *     close (IN_DRAWER + honest email) after M working days. No backlog.
 *   • Honors SYSTEM_MODE / SEND_ENABLED / quiet hours via the normal queue.
 *
 * PUBLIC FUNCTIONS
 * ----------------
 *   LIVEADV_install()              — seed Config keys, queue tab, templates. SAFE (switch stays FALSE).
 *   LIVEADV_installTrigger()       — install the 15-minute LIVEADV_run trigger. NEEDS APPROVAL.
 *   LIVEADV_run()                  — trigger entry: release due + sweep unbooked.
 *   LIVEADV_previewNow()           — read-only: what would release right now.
 *   LIVEADV_cancel(candidateId)    — cancel a pending release.
 *   LIVEADV_backtest()             — writes "Live Advance Backtest" tab from historical candidates.
 *   LIVEADV_dumpPrescreenForm()    — read-only: logs the pre-screen form structure.
 *   LIVEADV_planRoleQuestions()    — read-only: shows where role scenario questions would be inserted.
 *   LIVEADV_installRoleQuestions() — inserts the Assessment Question Bank questions into the pre-screen form.
 *   LIVEADV_selfTest()
 */

var LIVEADV_SHEET = 'Live Advance Queue';
var LIVEADV_HEADERS = Object.freeze([
  'Queued At', 'Candidate ID', 'Full Name', 'Role', 'Prescreen Score', 'Risk Score',
  'Release At', 'Release Ms', 'Status', 'Released At', 'Reason', 'Notes'
]);
var LIVEADV_BACKTEST_SHEET = 'Live Advance Backtest';

// Seeded into Config by LIVEADV_install() ONLY where the key is missing.
var LIVEADV_CFG_DEFAULTS = Object.freeze({
  LIVE_ADVANCE_ENABLED:                  'FALSE',  // master switch — Travis flips to TRUE
  LIVE_ADVANCE_HOLD_MINUTES:             '60',
  LIVE_ADVANCE_DAILY_CAP:                '2',
  LIVE_ADVANCE_REQUIRE_V2_PROMPT:        'TRUE',
  LIVE_ADVANCE_REQUIRE_ASSESSMENT:       'FALSE',  // flip TRUE after form questions + backtest
  LIVE_ADVANCE_ASSESSMENT_WAIT_HOURS:    '24',
  LIVE_ADVANCE_NO_BOOKING_REMINDER_DAYS: '5',      // working days
  LIVE_ADVANCE_NO_BOOKING_CLOSE_DAYS:    '10',     // working days
  LIVE_ADVANCE_TEMPLATE:                 'live_interview_booking',
  LIVE_ADVANCE_TEMPLATE_TECH:            'live_interview_booking_technician',
  LIVE_ADVANCE_REMINDER_TEMPLATE:        'live_interview_booking_reminder',
  LIVE_ADVANCE_CLOSE_TEMPLATE:           'live_interview_no_response_close',
  LIVE_ADVANCE_FORM_QUESTIONS_PER_ROLE:  '5'       // top-weighted questions inserted per role section
});

// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDE — post-scoring email dispatch (06_Scoring_Risk.gs)
// Identical to the original except the AUTO_BOOK branch, which now queues the
// live-interview link when LIVE_ADVANCE_ENABLED=TRUE.
// ─────────────────────────────────────────────────────────────────────────────
function _dispatchPostScoringEmails_(candidateId, candidate, score, risk, routing) {
  if (CFG.getBool('HIRING_PAUSE_MODE', false)) {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.IN_DRAWER,
      'Notes':        truncate_('Pause mode active at scoring time — pre-screen scored ' + score + ', parked in drawer with not-hiring response', 500),
      'Last Updated': shopDateTime_()
    });
    sendTemplatedEmail_('not_currently_hiring', candidate['Email'], candidateId, null, {
      reason: 'hiring pause mode — score=' + score
    });
    logEvent_('CANDIDATE_PAUSED', candidateId, { score: score, risk: risk, role: candidate['Role'] });
    return;
  }

  if (routing.action === 'AUTO_BOOK') {
    if (!CFG.getBool('AUTO_BOOKING_ENABLED', true)) {
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'AUTO_BOOKING_ENABLED=FALSE', wouldHaveSent: 'booking', score: score });
      return;
    }
    // ── OPTION A: live interview instead of phone screen ──
    if (CFG.getBool('LIVE_ADVANCE_ENABLED', false)) {
      LIVEADV_queue_(candidateId, candidate, score, risk);
      return;
    }
    // ── Legacy phone-screen path (unchanged) ──
    var role = candidate['Role'];
    if (role === 'Technician' && score >= CFG.getInt('TECH_SKILL_TEST_MIN_SCORE', 60)) {
      sendTemplatedEmail_('technician_post_prescreen', candidate['Email'], candidateId, null, {
        reason: 'auto-book + skill test (technician, score=' + score + ')'
      });
    } else {
      sendTemplatedEmail_('phone_screen_booking', candidate['Email'], candidateId, null, {
        reason: 'auto-book (score=' + score + ', risk=' + risk + ')'
      });
    }
  } else if (routing.action === 'HARD_REJECT') {
    if (!CFG.getBool('AUTO_REJECTION_ENABLED', true)) {
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'AUTO_REJECTION_ENABLED=FALSE', wouldHaveSent: 'gracious_decline', score: score });
      return;
    }
    if (!CFG.getBool('SEND_REJECTION_EMAIL', true)) {
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'SEND_REJECTION_EMAIL=FALSE', wouldHaveSent: 'gracious_decline', score: score });
      return;
    }
    var delayDays = CFG.getInt('REJECTION_EMAIL_DELAY_DAYS', 5);
    var sendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
    sendTemplatedEmail_('gracious_decline', candidate['Email'], candidateId, null, {
      sendAt:           sendAt,
      cancellableUntil: sendAt,
      reason:           'auto-reject after hard-reject scoring (score=' + score + ')'
    });
  } else if (routing.action === 'MANUAL_REVIEW') {
    if (CFG.getBool('SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW', true)) {
      sendTemplatedEmail_('we_are_reviewing', candidate['Email'], candidateId, null, {
        reason: 'auto-review notice — scored ' + score + ', routed to manual review'
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GATES
// ─────────────────────────────────────────────────────────────────────────────

/** All conditions that must hold before ANY live link is queued or released. */
function LIVEADV_gateCheck_() {
  if (!CFG.getBool('LIVE_ADVANCE_ENABLED', false)) return { ok: false, reason: 'LIVE_ADVANCE_ENABLED=FALSE' };
  if (!CFG.getBool('GRADING_V2_ENABLED', true))    return { ok: false, reason: 'GRADING_V2_ENABLED=FALSE' };
  if (typeof GRADE_prescreenV2_ !== 'function')     return { ok: false, reason: '44_Grading_V2.gs not loaded' };
  if (CFG.getBool('LIVE_ADVANCE_REQUIRE_V2_PROMPT', true) && !LIVEADV_promptIsV2_()) {
    return { ok: false, reason: 'prescreen AI prompt is the v1 seed body — run GRADE_installV2Prompt()' };
  }
  return { ok: true, reason: '' };
}

/** TRUE when the installed "prescreen" prompt is NOT the v1 seed body. */
function LIVEADV_promptIsV2_() {
  var p = _loadAiPrompt_('prescreen');
  if (!p) return false;
  var body = String(p['Prompt Body'] || '');
  if (!body.trim()) return false;
  var v1 = '';
  try {
    for (var i = 0; i < SEED_AI_PROMPTS.length; i++) {
      if (SEED_AI_PROMPTS[i]['Prompt Key'] === 'prescreen') { v1 = String(SEED_AI_PROMPTS[i]['Prompt Body'] || ''); break; }
    }
  } catch (e) { v1 = ''; }
  if (v1 && LIVEADV_norm_(body) === LIVEADV_norm_(v1)) return false;
  return true;
}

function LIVEADV_norm_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE (called from the dispatch override the moment scoring says AUTO_BOOK)
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_queue_(candidateId, candidate, score, risk) {
  var gate = LIVEADV_gateCheck_();
  if (!gate.ok) {
    logEvent_('LIVEADV_BLOCKED', candidateId, { reason: gate.reason, score: score, risk: risk });
    LIVEADV_alertOnce_('blocked:' + gate.reason,
      'Live auto-advance is BLOCKED — ' + gate.reason,
      'A candidate qualified for a live interview but auto-advance could not send.\n\n' +
      'Reason: ' + gate.reason + '\n' +
      'Candidate: ' + LIVEADV_name_(candidate) + ' (' + (candidate['Role'] || '') + ') — score ' + score + ', risk ' + risk + '\n\n' +
      'They were routed to MANUAL_REVIEW so nothing is lost. Fix the cause and they will advance on the next pass.\n\n— Recruiting OS');
    _setBothStatuses_(candidateId, STATUS.MANUAL_REVIEW,
      'Qualified for live interview but auto-advance blocked: ' + gate.reason + ' — ' + shopDateTime_());
    if (CFG.getBool('SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW', true)) {
      sendTemplatedEmail_('we_are_reviewing', candidate['Email'], candidateId, null, { reason: 'live-advance blocked: ' + gate.reason });
    }
    return;
  }

  // Role not open (Role Rules → Auto Send Booking = FALSE): park honestly, no backlog.
  if (!LIVEADV_roleOpen_(candidate['Role'])) {
    _setBothStatuses_(candidateId, STATUS.IN_DRAWER,
      'Qualified (score ' + score + ') but role not open — Role Rules Auto Send Booking = FALSE — parked in drawer ' + shopDateTime_());
    sendTemplatedEmail_('not_currently_hiring', candidate['Email'], candidateId, null, { reason: 'role closed at scoring time — score=' + score });
    logEvent_('LIVEADV_ROLE_CLOSED', candidateId, { role: candidate['Role'], score: score });
    return;
  }

  var q = getOrCreateSheet_(LIVEADV_SHEET, LIVEADV_HEADERS);
  ensureHeaders_(q, LIVEADV_HEADERS);
  if (LIVEADV_openIds_(q)[candidateId]) {
    logEvent_('LIVEADV_ALREADY_QUEUED', candidateId, {});
    return;
  }

  var holdMin   = CFG.getInt('LIVE_ADVANCE_HOLD_MINUTES', 60);
  var releaseAt = new Date(Date.now() + holdMin * 60 * 1000);
  var name      = LIVEADV_name_(candidate);
  var role      = String(candidate['Role'] || '');

  appendRowByHeader_(q, {
    'Queued At':       shopDateTime_(),
    'Candidate ID':    candidateId,
    'Full Name':       name,
    'Role':            role,
    'Prescreen Score': score,
    'Risk Score':      risk,
    'Release At':      shopDateTime_(releaseAt),
    'Release Ms':      releaseAt.getTime(),
    'Status':          'PENDING',
    'Released At':     '',
    'Reason':          'Pre-screen score ' + score + ' cleared the role auto-book bar, risk ' + risk + ' within ceiling',
    'Notes':           'Live interview link auto-sends in ' + holdMin + ' min unless cancelled.'
  });

  _setBothStatuses_(candidateId, STATUS.AUTO_BOOK_SENT,
    'Live interview link queued — auto-sends ' + shopDateTime_(releaseAt) + ' unless cancelled',
    { 'Live Advance Queued': shopDateTime_() });

  LIVEADV_notifyManager_(['• ' + name + ' — ' + role + ' — score ' + score + ' (risk ' + risk + ')'], holdMin);
  logEvent_('LIVEADV_QUEUED', candidateId, { score: score, risk: risk, holdMin: holdMin, role: role });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER ENTRY
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_run() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('LIVEADV_run', 'OK');
  if (!CFG.getBool('LIVE_ADVANCE_ENABLED', false)) {
    logEvent_('LIVEADV_SKIPPED', '', 'LIVE_ADVANCE_ENABLED=FALSE');
    return '[LIVEADV] disabled';
  }
  return withLockOrSkip_('LIVEADV_run', function () {
    var rel   = LIVEADV_releaseDue_();
    var sweep = LIVEADV_sweepUnbooked_();
    var msg = '[LIVEADV] released=' + rel.released + ' held=' + rel.held + ' skipped=' + rel.skipped +
              ' | reminders=' + sweep.reminders + ' closed=' + sweep.closed;
    Logger.log(msg);
    logEvent_('LIVEADV_RUN', '', { released: rel.released, held: rel.held, skipped: rel.skipped, reminders: sweep.reminders, closed: sweep.closed });
    return msg;
  });
}

/** Send the live link for every PENDING row whose hold has expired and still passes every gate. */
function LIVEADV_releaseDue_() {
  var out = { released: 0, held: 0, skipped: 0 };
  var q = getSheetOrNull_(LIVEADV_SHEET);
  if (!q) return out;
  var last = q.getLastRow();
  if (last < 2) return out;

  var gate = LIVEADV_gateCheck_();
  if (!gate.ok) {
    LIVEADV_alertOnce_('release-blocked:' + gate.reason, 'Live auto-advance releases are BLOCKED — ' + gate.reason,
      'Pending live-interview links are being held.\n\nReason: ' + gate.reason + '\n\n— Recruiting OS');
    out.held = last - 1;
    return out;
  }

  var headers = getHeaderRow_(q);
  var data = q.getRange(2, 1, last - 1, headers.length).getValues();
  function c(n) { return headers.indexOf(n); }
  var cId = c('Candidate ID'), cStatus = c('Status'), cMs = c('Release Ms'), cRel = c('Release At'),
      cRelAt = c('Released At'), cNotes = c('Notes'), cQueued = c('Queued At'), cRole = c('Role');

  var cap = CFG.getInt('LIVE_ADVANCE_DAILY_CAP', 2);
  var releasedToday = LIVEADV_releasedTodayCount_(data, cStatus, cRelAt);
  var now = Date.now();
  var tz  = CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles');

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][cStatus] || '').toUpperCase() !== 'PENDING') continue;
    var relMs = parseInt(data[i][cMs], 10);
    if (isNaN(relMs) || relMs <= 0) {
      var d = (data[i][cRel] instanceof Date) ? data[i][cRel] : new Date(data[i][cRel]);
      relMs = isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (relMs > now) { out.skipped++; continue; }

    var id = String(data[i][cId] || '').trim();
    if (!id) continue;
    var rowNum = i + 2;

    // Manager may have acted during the hold — they own it now.
    var cand = _getCandidateRow_(id);
    if (!cand) { q.getRange(rowNum, cStatus + 1).setValue('SKIPPED'); out.skipped++; continue; }
    if (String(cand['Decision'] || cand['Manager Decision'] || '').trim()) {
      q.getRange(rowNum, cStatus + 1).setValue('SUPERSEDED');
      logEvent_('LIVEADV_SUPERSEDED', id, { decision: cand['Decision'] || cand['Manager Decision'] });
      out.skipped++; continue;
    }
    var st = String(cand['Status'] || '').toUpperCase();
    if (st !== String(STATUS.AUTO_BOOK_SENT).toUpperCase()) {
      q.getRange(rowNum, cStatus + 1).setValue('SUPERSEDED');
      logEvent_('LIVEADV_SUPERSEDED', id, { status: cand['Status'] });
      out.skipped++; continue;
    }

    // Daily cap — never lost, just waits.
    if (cap > 0 && releasedToday >= cap) {
      q.getRange(rowNum, cNotes + 1).setValue('Daily cap ' + cap + ' reached — releases next day. ' + shopDateTime_());
      out.held++; continue;
    }

    // Optional second gate — the role assessment must agree.
    if (CFG.getBool('LIVE_ADVANCE_REQUIRE_ASSESSMENT', false) && CFG.getBool('ASSESSMENT_AI_ENABLED', true)) {
      var a = (typeof getLatestAssessmentResult_ === 'function') ? getLatestAssessmentResult_(id) : null;
      if (!a) {
        var queuedAt = (data[i][cQueued] instanceof Date) ? data[i][cQueued] : new Date(data[i][cQueued]);
        var waitH = CFG.getInt('LIVE_ADVANCE_ASSESSMENT_WAIT_HOURS', 24);
        var ageH = isNaN(queuedAt.getTime()) ? 999 : (now - queuedAt.getTime()) / 3600000;
        if (ageH < waitH) { out.held++; continue; }  // give the assessment time to land
        LIVEADV_holdForReview_(q, rowNum, cStatus, cNotes, id, cand, 'No role assessment result after ' + waitH + 'h');
        out.held++; continue;
      }
      var ds = String(a['Decision Status'] || '').toUpperCase();
      if (ds !== String(STATUS.AUTO_BOOK_SENT).toUpperCase()) {
        LIVEADV_holdForReview_(q, rowNum, cStatus, cNotes, id, cand,
          'Role assessment did not clear: ' + (a['Decision Reason'] || ds || 'no decision'));
        out.held++; continue;
      }
    }

    // ── Release: send the live-interview link ──
    try {
      var role = String(cand['Role'] || data[i][cRole] || '').trim();
      var tpl  = LIVEADV_templateFor_(role);
      sendTemplatedEmail_(tpl, cand['Email'], id, null, { reason: 'live auto-advance (pre-screen score cleared bar; hold expired, no manager action)' });
      var stamp = shopDateTime_();
      // Status stays AUTO_BOOK_SENT on purpose: pollCalendarBookings() promotes to
      // FULL_BOOKED when the candidate actually books, which also writes the
      // booking time, the Booking Events row and the day-of worksheet.
      _setBothStatuses_(id, STATUS.AUTO_BOOK_SENT,
        'Live interview link sent (auto-advance): ' + stamp + ' — awaiting candidate booking',
        { 'Full Interview Link Sent': stamp, 'Live Link Sent': stamp });
      q.getRange(rowNum, cStatus + 1).setValue('RELEASED');
      q.getRange(rowNum, cRelAt + 1).setValue(stamp);
      q.getRange(rowNum, cNotes + 1).setValue('Sent ' + tpl + ' ' + stamp);
      if (typeof logOverride_ === 'function') {
        safeRun_('liveadv:override', function () {
          logOverride_({
            actor: 'SYSTEM (live auto-advance)', candidateId: id,
            overrideType: 'Auto Advance to Live Interview (from assessment)',
            previousValue: String(cand['Status'] || ''), newValue: 'Live link sent',
            reason: 'Pre-screen score cleared the role bar; hold expired with no manager action.'
          });
        });
      }
      logEvent_('LIVEADV_RELEASED', id, { template: tpl, role: role });
      releasedToday++;
      out.released++;
    } catch (e) {
      q.getRange(rowNum, cStatus + 1).setValue('ERROR');
      logError_('LIVEADV_releaseDue_:' + id, e, id, 'ERROR');
      out.skipped++;
    }
  }
  return out;
}

function LIVEADV_holdForReview_(q, rowNum, cStatus, cNotes, id, cand, why) {
  q.getRange(rowNum, cStatus + 1).setValue('HELD_REVIEW');
  q.getRange(rowNum, cNotes + 1).setValue(why + ' — ' + shopDateTime_());
  _setBothStatuses_(id, STATUS.MANUAL_REVIEW, 'Live auto-advance held for review: ' + why + ' — ' + shopDateTime_());
  logEvent_('LIVEADV_HELD_REVIEW', id, { why: why });
  if (CFG.getBool('SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW', true)) {
    safeRun_('liveadv:reviewingEmail', function () {
      sendTemplatedEmail_('we_are_reviewing', cand['Email'], id, null, { reason: 'live-advance held: ' + why });
    });
  }
}

function LIVEADV_releasedTodayCount_(data, cStatus, cRelAt) {
  var tz = CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles');
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var n = 0;
  data.forEach(function (r) {
    if (String(r[cStatus] || '').toUpperCase() !== 'RELEASED') return;
    var v = r[cRelAt];
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return;
    if (Utilities.formatDate(d, tz, 'yyyy-MM-dd') === today) n++;
  });
  return n;
}

/** Technicians get the variant that also carries the skills test link. Falls back to the stock template if the seeded one is missing. */
function LIVEADV_templateFor_(role) {
  var isTech = /technician/i.test(role || '') && !/lube/i.test(role || '');
  var key = isTech ? CFG.get('LIVE_ADVANCE_TEMPLATE_TECH', 'live_interview_booking_technician')
                   : CFG.get('LIVE_ADVANCE_TEMPLATE', 'live_interview_booking');
  return LIVEADV_templateExists_(key) ? key : 'full_interview_booking';
}

function LIVEADV_templateExists_(key) {
  try {
    var sh = getSheetOrNull_(SHEETS.EMAIL_TEMPLATES);
    return !!(sh && findRowsByColumnValue_(sh, 'Template Key', key).length);
  } catch (e) { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP — link sent, candidate never booked → reminder → close. No backlog.
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_sweepUnbooked_() {
  var out = { reminders: 0, closed: 0 };
  var q = getSheetOrNull_(LIVEADV_SHEET);
  if (!q) return out;
  var last = q.getLastRow();
  if (last < 2) return out;
  var headers = getHeaderRow_(q);
  var data = q.getRange(2, 1, last - 1, headers.length).getValues();
  var cId = headers.indexOf('Candidate ID'), cStatus = headers.indexOf('Status'),
      cRelAt = headers.indexOf('Released At'), cNotes = headers.indexOf('Notes');
  var remindDays = CFG.getInt('LIVE_ADVANCE_NO_BOOKING_REMINDER_DAYS', 5);
  var closeDays  = CFG.getInt('LIVE_ADVANCE_NO_BOOKING_CLOSE_DAYS', 10);

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][cStatus] || '').toUpperCase() !== 'RELEASED') continue;
    var id = String(data[i][cId] || '').trim();
    if (!id) continue;
    var v = data[i][cRelAt];
    var sentAt = (v instanceof Date) ? v : new Date(v);
    if (isNaN(sentAt.getTime())) continue;
    var cand = _getCandidateRow_(id);
    if (!cand) continue;
    // Anything other than "link sent, nothing since" means they booked or the manager acted.
    if (String(cand['Status'] || '').toUpperCase() !== String(STATUS.AUTO_BOOK_SENT).toUpperCase()) continue;
    if (String(cand['Decision'] || cand['Manager Decision'] || '').trim()) continue;

    var wd = LIVEADV_workingDaysSince_(sentAt);
    var notes = String(data[i][cNotes] || '');
    var rowNum = i + 2;

    if (wd >= closeDays && notes.indexOf('REMINDER_SENT') !== -1) {
      var closeTpl = CFG.get('LIVE_ADVANCE_CLOSE_TEMPLATE', 'live_interview_no_response_close');
      if (LIVEADV_templateExists_(closeTpl)) {
        sendTemplatedEmail_(closeTpl, cand['Email'], id, null, { reason: 'no booking after ' + wd + ' working days — closing' });
      }
      _setBothStatuses_(id, STATUS.IN_DRAWER, 'Closed — live interview link sent ' + shopDateTime_(sentAt) + ', never booked (' + wd + ' working days). Reply reopens.');
      q.getRange(rowNum, cStatus + 1).setValue('CLOSED_NO_BOOKING');
      q.getRange(rowNum, cNotes + 1).setValue(notes + ' | CLOSED ' + shopDateTime_());
      logEvent_('LIVEADV_CLOSED_NO_BOOKING', id, { workingDays: wd });
      out.closed++;
    } else if (wd >= remindDays && notes.indexOf('REMINDER_SENT') === -1) {
      var remTpl = CFG.get('LIVE_ADVANCE_REMINDER_TEMPLATE', 'live_interview_booking_reminder');
      if (LIVEADV_templateExists_(remTpl)) {
        sendTemplatedEmail_(remTpl, cand['Email'], id, null, { reason: 'no booking after ' + wd + ' working days — reminder' });
      }
      q.getRange(rowNum, cNotes + 1).setValue(notes + ' | REMINDER_SENT ' + shopDateTime_());
      logEvent_('LIVEADV_REMINDER_SENT', id, { workingDays: wd });
      out.reminders++;
    }
  }
  return out;
}

/** Whole working days (Mon–Fri, shop time) elapsed since a date. */
function LIVEADV_workingDaysSince_(d) {
  var tz = CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles');
  var start = new Date(d.getTime()), now = new Date();
  var n = 0;
  var cur = new Date(start.getTime() + 24 * 3600 * 1000);
  while (cur.getTime() <= now.getTime() && n < 400) {
    var dow = Utilities.formatDate(cur, tz, 'u'); // 1=Mon … 7=Sun
    if (dow !== '6' && dow !== '7') n++;
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_openIds_(q) {
  var map = {};
  var last = q.getLastRow();
  if (last < 2) return map;
  var headers = getHeaderRow_(q);
  var cId = headers.indexOf('Candidate ID'), cStatus = headers.indexOf('Status');
  q.getRange(2, 1, last - 1, headers.length).getValues().forEach(function (r) {
    var st = String(r[cStatus] || '').toUpperCase();
    if (st === 'PENDING' || st === 'RELEASED') map[String(r[cId] || '').trim()] = true;
  });
  return map;
}

function LIVEADV_name_(c) {
  c = c || {};
  var n = ((c['First Name'] || '') + ' ' + (c['Last Name'] || '')).trim();
  return n || String(c['Full Name'] || '').trim() || '(unknown)';
}

function LIVEADV_notifyManager_(lines, holdMin) {
  var to = CFG.get('HIRING_MANAGER_EMAIL');
  if (!to) return;
  safeRun_('liveadv:notify', function () {
    queueEmail_({
      to: to,
      subject: 'AUTO-SENDING live interview link in ' + holdMin + ' min — ' + lines.length + ' candidate(s)',
      body:
        'These candidates cleared the pre-screen bar and will automatically receive the LIVE INTERVIEW booking link in ' + holdMin + ' minutes:\n\n' +
        lines.join('\n') + '\n\n' +
        'No action needed to let them through.\n\n' +
        'To stop one: open Interview Pipeline and set that candidate\'s Manager Decision to anything, ' +
        'or set their row in the "' + LIVEADV_SHEET + '" tab to CANCELLED.\n\n— Recruiting OS',
      templateKey: '__live_advance__',
      reason: 'live auto-advance heads-up'
    });
  });
}

/** Manager alert throttled to once per 24h per distinct key (script property). */
function LIVEADV_alertOnce_(key, subject, body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var pk = 'LIVEADV_ALERT::' + String(key).slice(0, 80);
    var lastMs = parseInt(props.getProperty(pk) || '0', 10);
    if (Date.now() - lastMs < 24 * 3600 * 1000) return;
    props.setProperty(pk, String(Date.now()));
    var to = CFG.get('HIRING_MANAGER_EMAIL');
    if (!to) return;
    queueEmail_({ to: to, subject: subject, body: body, templateKey: '__live_advance_alert__', reason: 'live auto-advance alert' });
  } catch (e) { Logger.log('LIVEADV_alertOnce_ failed: ' + e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_cancel(candidateId) {
  var q = getSheetOrNull_(LIVEADV_SHEET);
  if (!q) return '[LIVEADV] no queue';
  var headers = getHeaderRow_(q);
  var cId = headers.indexOf('Candidate ID') + 1, cStatus = headers.indexOf('Status') + 1;
  for (var r = 2; r <= q.getLastRow(); r++) {
    if (String(q.getRange(r, cId).getValue() || '').trim() === candidateId &&
        String(q.getRange(r, cStatus).getValue() || '').toUpperCase() === 'PENDING') {
      q.getRange(r, cStatus).setValue('CANCELLED');
      logEvent_('LIVEADV_CANCELLED', candidateId, {});
      return '[LIVEADV] cancelled ' + candidateId;
    }
  }
  return '[LIVEADV] no pending row for ' + candidateId;
}

function LIVEADV_previewNow() {
  var out = ['[LIVEADV] preview — ' + shopDateTime_()];
  var g = LIVEADV_gateCheck_();
  out.push('  gate: ' + (g.ok ? 'OPEN' : 'BLOCKED — ' + g.reason));
  var q = getSheetOrNull_(LIVEADV_SHEET);
  if (!q || q.getLastRow() < 2) { out.push('  queue empty'); var m0 = out.join('\n'); Logger.log(m0); return m0; }
  var headers = getHeaderRow_(q);
  var data = q.getRange(2, 1, q.getLastRow() - 1, headers.length).getValues();
  var cName = headers.indexOf('Full Name'), cRole = headers.indexOf('Role'), cStatus = headers.indexOf('Status'),
      cMs = headers.indexOf('Release Ms'), cScore = headers.indexOf('Prescreen Score');
  data.forEach(function (r) {
    var st = String(r[cStatus] || '');
    var due = parseInt(r[cMs], 10) <= Date.now();
    out.push('  ' + st.padEnd(18, ' ') + (st === 'PENDING' ? (due ? '→ DUE NOW  ' : '   waiting ') : '           ') +
             r[cName] + ' (' + r[cRole] + ') score=' + r[cScore]);
  });
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Install the 15-minute trigger. Idempotent. REQUIRES MANAGER APPROVAL. */
function LIVEADV_installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'LIVEADV_run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('LIVEADV_run').timeBased().everyMinutes(15).create();
  var msg = '[LIVEADV] 15-minute trigger installed';
  Logger.log(msg);
  try { toast_(msg, 'Recruiting OS', 6); } catch (e) {}
  return msg;
}

function LIVEADV_removeTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'LIVEADV_run') { ScriptApp.deleteTrigger(t); n++; }
  });
  return '[LIVEADV] removed ' + n + ' trigger(s)';
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — Config keys (only if missing), queue tab, email templates.
// Does NOT install the trigger and does NOT flip the master switch.
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_install() {
  return withLock_(function () {
    var added = [];
    Object.keys(LIVEADV_CFG_DEFAULTS).forEach(function (k) {
      if (!CFG.has(k)) { CFG.set(k, LIVEADV_CFG_DEFAULTS[k]); added.push(k); }
    });
    CFG.reset();
    var q = getOrCreateSheet_(LIVEADV_SHEET, LIVEADV_HEADERS);
    ensureHeaders_(q, LIVEADV_HEADERS);
    var t = LIVEADV_seedTemplates_();
    var msg = '[LIVEADV] install — config added: ' + (added.length ? added.join(', ') : 'none (all present)') +
              ' | queue tab OK | templates added: ' + t.added + ', existing: ' + t.skipped;
    Logger.log(msg);
    logEvent_('LIVEADV_INSTALLED', '', { configAdded: added, templatesAdded: t.added });
    try { toast_(msg, 'Recruiting OS', 8); } catch (e) {}
    return msg + '\n' + LIVEADV_selfTest();
  });
}

/** Insert-only. Never overwrites an existing Template Key. */
function LIVEADV_seedTemplates_() {
  var sh = getSheetOrNull_(SHEETS.EMAIL_TEMPLATES);
  if (!sh) return { added: 0, skipped: 0 };
  var rows = [
    {
      'Template Key': 'live_interview_booking',
      'Subject':      'Next step — come meet us in person for the {{RoleName}} role',
      'Body':
        'Hi {{CandidateFirstName}},\n\n' +
        'A quick, honest update: your application for the {{RoleName}} role stood out, and we would like to skip the phone tag and have you come in for a real conversation.\n\n' +
        'Pick a time that works for you:\n{{FullInterviewLink}}\n\n' +
        'Where: {{InterviewLocation}}\nPlan for 45–60 minutes. You will meet {{HiringManagerName}}, walk the shop, and see the work firsthand — {{ShopSpecialties}}.\n\n' +
        'One thing worth saying plainly: {{ShopWhyWeHire}} This visit is as much about you evaluating us as it is about us evaluating you. Come with questions about the work, the team, the expectations, and what we offer in return. Long-term fit matters more to us than filling a seat quickly.\n\n' +
        'If none of the open times work, just reply to this email and we will find one.\n\n' +
        'Looking forward to having you in,\n{{HiringManagerName}}\n{{HiringManagerTitle}} · {{ShopName}}\n{{CompanyPhone}}',
      'Required Merge Fields': 'CandidateFirstName,RoleName,FullInterviewLink,InterviewLocation,HiringManagerName,HiringManagerTitle,ShopName,ShopSpecialties,ShopWhyWeHire,CompanyPhone',
      'Notes': 'Option A (9/17/26): sent automatically when the pre-screen clears the role bar. Replaces the phone-screen booking email. Sent by ZZ_Live_Advance.gs.'
    },
    {
      'Template Key': 'live_interview_booking_technician',
      'Subject':      'Two steps to move forward — Technician at {{ShopName}}',
      'Body':
        'Hi {{CandidateFirstName}},\n\n' +
        'A quick, honest update: your application stood out, and we would like to have you come in and meet us in person. To move your Technician application forward, please do BOTH of the following:\n\n' +
        '1) Book your in-person interview with {{HiringManagerName}}:\n   {{FullInterviewLink}}\n\n' +
        '2) Complete the Technician Skill Level Test before you come in (~20 minutes):\n   {{SkillsTestLink}}\n\n' +
        'Why both: the skill test tells us about the systems you know, the tools you use, and the work you have actually done — so the interview can be about the role, the shop, and what you are looking for, not the basics.\n\n' +
        'Please complete the test on your own. We are not looking for perfect answers — we are looking for honest ones. That standard reflects how we operate across everything we do here.\n\n' +
        'Where: {{InterviewLocation}}\nPlan for 45–60 minutes. You will walk the shop and see the work firsthand — {{ShopSpecialties}}. {{ShopPerksLine}}\n\n' +
        'If none of the open times work, just reply to this email and we will find one.\n\n' +
        'Looking forward to having you in,\n{{HiringManagerName}}\n{{HiringManagerTitle}} · {{ShopName}}\n{{CompanyPhone}}',
      'Required Merge Fields': 'CandidateFirstName,RoleName,FullInterviewLink,SkillsTestLink,InterviewLocation,HiringManagerName,HiringManagerTitle,ShopName,ShopSpecialties,ShopPerksLine,CompanyPhone',
      'Notes': 'Option A (9/17/26): technician variant — live interview link + skills test in one email. Replaces technician_post_prescreen. Sent by ZZ_Live_Advance.gs.'
    },
    {
      'Template Key': 'live_interview_booking_reminder',
      'Subject':      'Still want to meet — pick a time for your {{RoleName}} interview',
      'Body':
        'Hi {{CandidateFirstName}},\n\n' +
        'A quick, honest nudge: we sent you a link to book an in-person interview for the {{RoleName}} role and have not seen a time come through yet. The invitation is still open.\n\n' +
        'Pick a time here:\n{{FullInterviewLink}}\n\n' +
        'If the open times do not work, or something has changed on your end, just reply to this email — a real person will read it and we will sort it out.\n\n' +
        'Thanks,\n{{HiringManagerName}}\n{{ShopName}} · {{CompanyPhone}}',
      'Required Merge Fields': 'CandidateFirstName,RoleName,FullInterviewLink,HiringManagerName,ShopName,CompanyPhone',
      'Notes': 'Option A (9/17/26): single reminder after LIVE_ADVANCE_NO_BOOKING_REMINDER_DAYS working days with no booking. Sent by ZZ_Live_Advance.gs.'
    },
    {
      'Template Key': 'live_interview_no_response_close',
      'Subject':      'Closing the loop on your {{RoleName}} application — {{ShopName}}',
      'Body':
        'Hi {{CandidateFirstName}},\n\n' +
        'A quick, honest update: we invited you to book an in-person interview for the {{RoleName}} role and followed up once, but we have not heard back. We are going to close your application for now so we are not leaving you in limbo.\n\n' +
        'If the timing was just off, reply to this email and we will reopen it — no need to start over. We keep applications on file for {{KeepDoorOpenMonths}} months.\n\n' +
        'We wish you the very best,\n{{HiringManagerName}}\n{{ShopName}}',
      'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,KeepDoorOpenMonths,HiringManagerName',
      'Notes': 'Option A (9/17/26): honest close after LIVE_ADVANCE_NO_BOOKING_CLOSE_DAYS working days with no booking. Candidate goes IN_DRAWER; a reply reopens. Sent by ZZ_Live_Advance.gs.'
    }
  ];
  var added = 0, skipped = 0;
  rows.forEach(function (row) {
    if (findRowsByColumnValue_(sh, 'Template Key', row['Template Key']).length) { skipped++; return; }
    appendRowByHeader_(sh, row);
    added++;
  });
  return { added: added, skipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST — what WOULD have auto-sent, using stored scores. Read-only on the
// pipeline; writes only the "Live Advance Backtest" tab. Use it to set the bars.
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_backtest() {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var last = ac.getLastRow();
  if (last < 2) return '[LIVEADV] backtest: no candidates';
  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  function c(n) { return headers.indexOf(n); }
  var cId = c('Candidate ID'), cFn = c('First Name'), cLn = c('Last Name'), cRole = c('Role'),
      cScore = c('AI Score'), cRisk = c('Risk Score'), cTier = c('Score Tier'), cStatus = c('Status'), cEmail = c('Email');

  var requireAssess = CFG.getBool('LIVE_ADVANCE_REQUIRE_ASSESSMENT', false);
  var rows = [];
  var tally = { scored: 0, wouldSend: 0, autoBookButAssessHeld: 0, review: 0, reject: 0, byRole: {} };

  data.forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var score = parseFloat(r[cScore]);
    if (isNaN(score)) return;
    var risk = parseFloat(r[cRisk]); if (isNaN(risk)) risk = 0;
    var role = cRole >= 0 ? String(r[cRole] || '') : '';
    var rule = _getRoleRule_(role);
    var route = ROUTE_v2_(score, risk, rule, null);
    var assess = null, assessDecision = '', assessReason = '';
    if (typeof getLatestAssessmentResult_ === 'function') {
      try { assess = getLatestAssessmentResult_(id); } catch (e) { assess = null; }
    }
    if (assess) { assessDecision = String(assess['Decision Status'] || ''); assessReason = String(assess['Decision Reason'] || ''); }

    var would = route.action === 'AUTO_BOOK';
    var heldByAssess = false;
    if (would && requireAssess) {
      if (String(assessDecision).toUpperCase() !== String(STATUS.AUTO_BOOK_SENT).toUpperCase()) { would = false; heldByAssess = true; }
    }
    tally.scored++;
    if (would) tally.wouldSend++;
    else if (heldByAssess) tally.autoBookButAssessHeld++;
    else if (route.action === 'HARD_REJECT') tally.reject++;
    else tally.review++;
    tally.byRole[role] = tally.byRole[role] || { scored: 0, wouldSend: 0 };
    tally.byRole[role].scored++;
    if (would) tally.byRole[role].wouldSend++;

    rows.push([
      id, ((cFn >= 0 ? r[cFn] : '') + ' ' + (cLn >= 0 ? r[cLn] : '')).trim(), role,
      score, risk, cTier >= 0 ? r[cTier] : '', String(r[cStatus] || ''),
      route.action, route.reason,
      assessDecision, assessReason,
      would ? 'YES' : (heldByAssess ? 'HELD (assessment)' : 'no')
    ]);
  });

  var hdr = ['Candidate ID', 'Name', 'Role', 'AI Score', 'Risk', 'Tier', 'Current Status',
             'V2 Route', 'V2 Reason', 'Assessment Decision', 'Assessment Reason', 'Would Auto-Send'];
  var sh = getOrCreateSheet_(LIVEADV_BACKTEST_SHEET, hdr);
  sh.clearContents();
  var summary = 'Backtest ' + shopDateTime_() + ' — scored=' + tally.scored + ' wouldSend=' + tally.wouldSend +
                ' heldByAssessment=' + tally.autoBookButAssessHeld + ' review=' + tally.review + ' reject=' + tally.reject +
                ' | requireAssessment=' + requireAssess + ' | byRole=' + JSON.stringify(tally.byRole);
  sh.getRange(1, 1).setValue(summary);
  sh.getRange(2, 1, 1, hdr.length).setValues([hdr]);
  if (rows.length) sh.getRange(3, 1, rows.length, hdr.length).setValues(rows);
  Logger.log('[LIVEADV] ' + summary);
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SCREEN FORM — make it the combined Candidate Assessment by inserting the
// Assessment Question Bank scenario questions into each role's section.
// Question titles are used VERBATIM so the response columns match what
// 35_Assessments.gs reads (raw[questionText]).
// ─────────────────────────────────────────────────────────────────────────────
var LIVEADV_FORM_SECTION_KEYWORDS = Object.freeze({
  'ASSESS_SHOP_FOREMAN':    ['foreman'],
  'ASSESS_SERVICE_ADVISOR': ['service advisor', 'advisor'],
  'ASSESS_LUBE_TECH':       ['lube'],
  'ASSESS_TECHNICIAN':      ['technician'],
  'ASSESS_PARTS':           ['parts'],
  'ASSESS_ADMIN':           ['admin', 'office'],
  'ASSESS_CX':              ['customer experience', 'cx'],
  'ASSESS_VALET_PORTER':    ['valet', 'porter', 'driver']
});

function LIVEADV_openPrescreenForm_() {
  var editId = (typeof getFormEditId_ === 'function') ? getFormEditId_('PRESCREEN') : '';
  if (!editId) throw new Error('PRESCREEN Edit ID missing in Form Registry');
  return FormApp.openById(editId);
}

/** Read-only: log every item in the pre-screen form with its index and type. */
function LIVEADV_dumpPrescreenForm() {
  var form = LIVEADV_openPrescreenForm_();
  var items = form.getItems();
  var out = ['[LIVEADV] pre-screen form "' + form.getTitle() + '" — ' + items.length + ' items'];
  items.forEach(function (it) {
    out.push('  ' + String(it.getIndex()).padStart(3, ' ') + '  ' + String(it.getType()).padEnd(16, ' ') + '  ' + it.getTitle());
  });
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Map each Assessment section key to a page-break (section) in the form. */
function LIVEADV_sectionMap_(form) {
  var items = form.getItems();
  var breaks = [];
  items.forEach(function (it) {
    if (it.getType() === FormApp.ItemType.PAGE_BREAK) breaks.push({ index: it.getIndex(), title: String(it.getTitle() || '') });
  });
  var used = {};
  var map = {};
  Object.keys(LIVEADV_FORM_SECTION_KEYWORDS).forEach(function (key) {
    var kws = LIVEADV_FORM_SECTION_KEYWORDS[key];
    for (var b = 0; b < breaks.length; b++) {
      if (used[breaks[b].index]) continue;
      var t = breaks[b].title.toLowerCase();
      for (var k = 0; k < kws.length; k++) {
        if (t.indexOf(kws[k]) !== -1) {
          var end = (b + 1 < breaks.length) ? breaks[b + 1].index : items.length;
          map[key] = { breakIndex: breaks[b].index, title: breaks[b].title, endIndex: end };
          used[breaks[b].index] = true;
          b = breaks.length; break;
        }
      }
    }
  });
  return { map: map, breaks: breaks, itemCount: items.length };
}

/** Read-only plan: which questions would be inserted where. */
function LIVEADV_planRoleQuestions() { return LIVEADV_installRoleQuestions_(true); }

/** Live: insert missing role scenario questions at the end of each matching section. */
function LIVEADV_installRoleQuestions() { return LIVEADV_installRoleQuestions_(false); }

function LIVEADV_installRoleQuestions_(dryRun) {
  var form = LIVEADV_openPrescreenForm_();
  var out = ['[LIVEADV] ' + (dryRun ? 'PLAN' : 'INSTALL') + ' role scenario questions → "' + form.getTitle() + '"'];
  var inserted = 0, existing = 0, unmapped = [];

  Object.keys(LIVEADV_FORM_SECTION_KEYWORDS).forEach(function (key) {
    var sm = LIVEADV_sectionMap_(form);          // recomputed each pass — indices shift on insert
    var sec = sm.map[key];
    var questions = (typeof loadAssessmentQuestions_ === 'function') ? loadAssessmentQuestions_(key) : [];
    questions = LIVEADV_topQuestions_(questions, CFG.getInt('LIVE_ADVANCE_FORM_QUESTIONS_PER_ROLE', 5));
    if (!questions.length) { out.push('  ' + key + ': no active questions in Assessment Question Bank — skipped'); return; }
    if (!sec) { unmapped.push(key); out.push('  ' + key + ': NO MATCHING SECTION in form — skipped (' + questions.length + ' questions)'); return; }

    var titles = {};
    form.getItems().forEach(function (it) { titles[LIVEADV_norm_(it.getTitle())] = true; });
    out.push('  ' + key + ' → section "' + sec.title + '" (items ' + sec.breakIndex + '–' + (sec.endIndex - 1) + ')');

    var insertAt = sec.endIndex;
    questions.forEach(function (q) {
      var text = String(q['Question'] || '').trim();
      if (!text) return;
      if (titles[LIVEADV_norm_(text)]) { existing++; out.push('      = already present: ' + text.slice(0, 70)); return; }
      if (dryRun) { out.push('      + would insert at ' + insertAt + ': ' + text.slice(0, 70)); insertAt++; inserted++; return; }
      var item = form.addParagraphTextItem().setTitle(text).setRequired(true);
      form.moveItem(item.getIndex(), insertAt);
      out.push('      + inserted at ' + insertAt + ': ' + text.slice(0, 70));
      insertAt++; inserted++;
    });
  });

  out.push('[LIVEADV] ' + (dryRun ? 'plan' : 'install') + ' done — ' + (dryRun ? 'would insert ' : 'inserted ') + inserted +
           ', already present ' + existing + (unmapped.length ? ', UNMAPPED: ' + unmapped.join(', ') : ''));
  if (!dryRun) logEvent_('LIVEADV_FORM_QUESTIONS_INSTALLED', '', { inserted: inserted, existing: existing, unmapped: unmapped });
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE / SWITCH CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

/** Highest Scoring Weight first (ties by Order), capped at n. n <= 0 = no cap. */
function LIVEADV_topQuestions_(qs, n) {
  var arr = (qs || []).slice();
  arr.sort(function (a, b) {
    var wa = parseFloat(a['Scoring Weight']) || 0, wb = parseFloat(b['Scoring Weight']) || 0;
    if (wb !== wa) return wb - wa;
    return (parseFloat(a['Order']) || 0) - (parseFloat(b['Order']) || 0);
  });
  return n > 0 ? arr.slice(0, n) : arr;
}

/** TRUE unless Role Rules → Auto Send Booking is FALSE (boolean or text) for the role. */
function LIVEADV_roleOpen_(role) {
  var rule = _getRoleRule_(role);
  if (!rule) return true;
  var v = rule['Auto Send Booking'];
  return !(v === false || String(v).trim().toUpperCase() === 'FALSE');
}

/** Auto Send Booking = TRUE only for the roles listed; FALSE for every other role row. */
function LIVEADV_setAutoSendRoles(openRoles) {
  openRoles = (openRoles && openRoles.length) ? openRoles : ['Technician', 'Service Advisor'];
  var sh = getSheet_(SHEETS.ROLE_RULES);
  var headers = getHeaderRow_(sh);
  var cRole = headers.indexOf('Role') + 1, cAuto = headers.indexOf('Auto Send Booking') + 1;
  if (!cRole || !cAuto) throw new Error('Role Rules headers missing (Role / Auto Send Booking)');
  var changed = [];
  for (var r = 2; r <= sh.getLastRow(); r++) {
    var role = String(sh.getRange(r, cRole).getValue() || '').trim();
    if (!role) continue;
    var want = openRoles.indexOf(role) !== -1;
    var cur = LIVEADV_roleOpen_(role);
    if (cur !== want) { sh.getRange(r, cAuto).setValue(want); changed.push(role + ' → ' + want); }
  }
  try { if (typeof _roleRulesCache_ !== 'undefined') _roleRulesCache_ = null; } catch (e) {}
  logEvent_('LIVEADV_AUTOSEND_ROLES_SET', '', { open: openRoles, changed: changed });
  var msg = '[LIVEADV] Auto Send Booking TRUE for: ' + openRoles.join(', ') + ' | changed: ' + (changed.length ? changed.join(', ') : 'none');
  Logger.log(msg); return msg;
}

/** Master switch ON. Candidates who clear the bar now get the live link after the hold. */
function LIVEADV_enable() {
  CFG.set('LIVE_ADVANCE_ENABLED', 'TRUE'); CFG.reset();
  logEvent_('LIVEADV_ENABLED', '', {});
  return LIVEADV_selfTest();
}

/** Master switch OFF. Legacy phone-screen path resumes. Pending queue rows simply wait. */
function LIVEADV_disable() {
  CFG.set('LIVE_ADVANCE_ENABLED', 'FALSE'); CFG.reset();
  logEvent_('LIVEADV_DISABLED', '', {});
  return '[LIVEADV] disabled';
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDE — pollCalendarBookings (07_Booking.gs)
// Verbatim copy of the original with ONE addition after "var lcTitle": Koalendar
// event titles carry only names ("Name & Travis Burd"), so a live-interview
// booking was being classified as a phone screen. LIVEADV_phaseHint_ reads the
// booking slug from the event description and adds "full" when it is the
// full-interview event, so the original title checks classify it correctly.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns 'full' when the calendar event was booked through the full-interview Koalendar page. */
function LIVEADV_phaseHint_(ev) {
  var d = String(ev.getDescription ? (ev.getDescription() || '') : '').toLowerCase();
  if (!d) return '';
  var link = String(CFG.get('DEFAULT_FULL_BOOKING_LINK', '') || '').toLowerCase();
  var slug = link.split('?')[0].split('/').filter(Boolean).pop() || 'fes-full-interview';
  if (d.indexOf('koalendar.com/e/' + slug) !== -1 || d.indexOf('/e/' + slug + '/') !== -1) return 'full';
  if (/full interview|in-person interview|in person interview/.test(d)) return 'full';
  return '';
}

function pollCalendarBookings() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('pollCalendarBookings', 'OK');
  // Track whether any same-day worksheets were generated inside the lock so we
  // can send them AFTER releasing it. sendTodayInterviewWorksheets() acquires
  // its own lock and cannot be nested inside ours.
  var _todayWorksheetsGenerated = false;

  var lockResult = withLockOrSkip_('pollCalendarBookings', function () {
    var calId = CFG.get('INTERVIEW_CALENDAR_ID');
    if (!calId) return '[BOOKING] INTERVIEW_CALENDAR_ID not set';
    var cal;
    try { cal = CalendarApp.getCalendarById(calId); }
    catch (e) { return '[BOOKING] cannot open calendar: ' + e.message; }
    if (!cal) return '[BOOKING] calendar not found: ' + calId;

    var look = CFG.getInt('INTERVIEW_BLOCK_LOOKAHEAD_DAYS', 21);
    var now = new Date();
    var end = new Date(now.getTime() + look * 24 * 60 * 60 * 1000);
    var events = cal.getEvents(now, end);

    var summary = { scanned: 0, matched: 0, alreadyBooked: 0, unmatched: 0, errors: 0 };
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);

    events.forEach(function (ev) {
      summary.scanned++;
      try {
        // Skip our own [Recruiting Available] block events
        var title = ev.getTitle() || '';
        var prefix = CFG.get('INTERVIEW_BLOCK_EVENT_PREFIX', '[Recruiting Available]');
        if (title.indexOf(prefix) === 0) return;

        // Match by email (calendar guests OR an address in the event body) then
        // by candidate name in the title. Koalendar bookings do not add the
        // candidate as a guest — the email is in the description — so a
        // guest-only match silently missed every Koalendar booking.
        var matchedCid = (typeof _findCandidateForEvent_ === 'function')
          ? _findCandidateForEvent_(ev)
          : '';
        if (!matchedCid) { summary.unmatched++; return; }

        // Determine phase by event title heuristics
        var lcTitle = title.toLowerCase();
        // ZZ_Live_Advance: Koalendar titles are "Name & Travis Burd" — the booking type only appears
        // in the description (event slug). Fold a hint into lcTitle so the existing checks work.
        try { lcTitle += ' ' + LIVEADV_phaseHint_(ev); } catch (e) {}
        var phase = 'PhoneScreen';
        if (lcTitle.indexOf('full') !== -1 || lcTitle.indexOf('in-person') !== -1 ||
            lcTitle.indexOf('in person') !== -1) phase = 'FullInterview';
        else if (lcTitle.indexOf('working') !== -1) phase = 'WorkingInterview';

        // Check if already booked at this status (idempotent)
        var hits = ip ? findRowsByColumnValue_(ip, 'Candidate ID', matchedCid) : [];
        if (!hits.length) { summary.unmatched++; return; }
        var current = hits[0].data;
        var currentStatus = String(current['Status'] || '');
        var newStatus = (phase === 'PhoneScreen') ? STATUS.PHONE_BOOKED :
                        (phase === 'WorkingInterview') ? STATUS.WORKING_SCHEDULED :
                        STATUS.FULL_BOOKED;

        if (currentStatus === newStatus || currentStatus === STATUS.PHONE_DONE ||
            currentStatus === STATUS.FULL_DONE) {
          summary.alreadyBooked++;
          return;
        }

        // Update pipeline + all candidates
        var stamp = shopDateTime_();
        var updates = {
          'Status':       newStatus,
          'Last Updated': stamp
        };
        if (phase === 'PhoneScreen') {
          updates['Phone Screen Booked']  = shopDateTime_(ev.getStartTime());
        } else if (phase === 'FullInterview') {
          updates['Full Interview Booked'] = shopDateTime_(ev.getStartTime());
        } else if (phase === 'WorkingInterview') {
          // BUG-FIX: Working Interview Date was never written, so generateWorksheetsForToday()
          // could never find working interviews. Must be populated just like the other phases.
          updates['Working Interview Date'] = shopDateTime_(ev.getStartTime());
        }
        updateRowWhere_(ip, 'Candidate ID', matchedCid, updates);

        var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
        if (ac) updateRowWhere_(ac, 'Candidate ID', matchedCid, {
          'Status': newStatus, 'Last Updated': stamp
        });

        summary.matched++;
        logEvent_('CANDIDATE_BOOKED', matchedCid, {
          phase: phase, eventTitle: title, eventStart: shopDateTime_(ev.getStartTime())
        });

        // Persist a time-indexed booking row so 08_Otter_Transcripts can match
        // in-person recordings (no email/ID) by booking-time proximity.
        // Idempotent by Calendar Event ID. Failure here must never block the
        // booking flow, so wrap in safeRun_.
        safeRun_('pollCalendarBookings:bookingEvent', function () {
          _recordBookingEvent_(matchedCid, current, ev, phase);
        });

        // If the interview is TODAY, generate the worksheet immediately rather
        // than waiting for the 7am daily trigger. Flag it so we can send the
        // email after the lock releases (nested withLock_ calls would deadlock).
        safeRun_('pollCalendarBookings:worksheet', function () {
          var tz = CFG.get('TIMEZONE', 'America/Los_Angeles');
          var interviewYmd = Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd');
          var todayYmd     = Utilities.formatDate(new Date(),        tz, 'yyyy-MM-dd');
          if (interviewYmd === todayYmd && typeof generateInterviewWorksheet_ === 'function') {
            var wsType = phase === 'WorkingInterview' ? 'Working Interview (in-person)' :
                         phase === 'FullInterview'    ? 'Live Interview (in-person)'    :
                                                        'Phone Screen (online)';
            generateInterviewWorksheet_(matchedCid, wsType, ev.getStartTime());
            _todayWorksheetsGenerated = true;
            logEvent_('WORKSHEET_GENERATED_FROM_CALENDAR_POLL', matchedCid, { phase: phase });
          }
        });

        // Alert manager
        if (CFG.getBool('IMMEDIATE_BOOKING_ALERTS_ENABLED', true)) {
          _notifyManagerBooked_(matchedCid, current, ev, phase);
        }
      } catch (e) {
        summary.errors++;
        logError_('pollCalendarBookings:event', e, '', 'WARN');
      }
    });

    var msg = '[BOOKING] pollCalendarBookings — ' + JSON.stringify(summary);
    Logger.log(msg);
    return msg;
  });

  // BUG-FIX: Worksheets generated above for today's interviews were left as DRAFT because
  // sendTodayInterviewWorksheets() could not be called inside the lock. If the daily 7am
  // digest already ran and a booking was detected later in the day, the worksheet would
  // never be emailed (next day's 7am run skips dates that no longer equal today).
  // Calling this here — outside the lock — ensures same-day late bookings are sent promptly.
  if (_todayWorksheetsGenerated && typeof sendTodayInterviewWorksheets === 'function') {
    safeRun_('pollCalendarBookings:sendWorksheets', function () {
      sendTodayInterviewWorksheets();
    });
  }

  return lockResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST (read-only)
// ─────────────────────────────────────────────────────────────────────────────
function LIVEADV_selfTest() {
  var out = ['[LIVEADV] selfTest…'];
  Object.keys(LIVEADV_CFG_DEFAULTS).forEach(function (k) {
    out.push('  ─ ' + k.padEnd(40, ' ') + ' : ' + CFG.get(k) + (CFG.has(k) ? '' : '   (DEFAULT — not in Config yet)'));
  });
  var g = LIVEADV_gateCheck_();
  out.push('  ' + (g.ok ? '✓' : '✗') + ' gate: ' + (g.ok ? 'OPEN' : g.reason));
  out.push('  ' + (LIVEADV_promptIsV2_() ? '✓' : '✗') + ' prescreen prompt is V2 (not the v1 seed body)');
  var q = getSheetOrNull_(LIVEADV_SHEET);
  out.push('  ' + (q ? '✓' : '✗') + ' "' + LIVEADV_SHEET + '" tab ' + (q ? 'present (' + Math.max(0, q.getLastRow() - 1) + ' rows)' : 'missing — run LIVEADV_install()'));
  ['live_interview_booking', 'live_interview_booking_technician', 'live_interview_booking_reminder', 'live_interview_no_response_close']
    .forEach(function (k) { out.push('  ' + (LIVEADV_templateExists_(k) ? '✓' : '✗') + ' template ' + k); });
  var installed = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'LIVEADV_run'; });
  out.push('  ' + (installed ? '✓' : '✗') + ' LIVEADV_run trigger ' + (installed ? 'installed' : 'NOT installed — LIVEADV_installTrigger() after approval'));
  var legacy = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'AUTOADV_run'; });
  out.push('  ─ legacy AUTOADV_run (phone→live) trigger: ' + (legacy ? 'installed (harmless)' : 'not installed (expected)'));
  ['Technician', 'Service Advisor'].forEach(function (role) {
    var rr = _getRoleRule_(role);
    out.push('  ─ ' + role + ': auto-book bar=' + (rr ? rr['Auto Booking Minimum Score'] : '?') +
             ' maxRisk=' + (rr ? rr['Max Risk Score For Auto Booking'] : '?') +
             ' autoSend=' + (rr ? rr['Auto Send Booking'] : '?'));
  });
  out.push('[LIVEADV] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
