/**
 * 14_Email_Queue.gs
 * Frank's European Service — Recruiting OS
 *
 * SAFETY-CRITICAL FILE.
 *
 * Every candidate-facing email — without exception — must go through
 * queueEmail_() or sendTemplatedEmail_(). No other file may call
 * MailApp.sendEmail / GmailApp.sendEmail for candidates.
 *
 * Layered safety chain (every layer must approve before bytes leave Gmail):
 *
 *   1. queueEmail_() writes a row to "Email Queue" with:
 *        To (Intended)  = original candidate address
 *        To (Actual)    = actualRecipient_(intended)  ← TEST mode reroutes
 *        Status         = PENDING
 *        Send At        = now, or next-window if quiet hours
 *
 *   2. If sendable-now, queueEmail_ immediately calls _sendQueueRow_().
 *      Otherwise the row sits PENDING until the next flushEmailQueue() run.
 *
 *   3. _sendQueueRow_() re-checks EVERY gate before MailApp.sendEmail:
 *        a) SEND_ENABLED == TRUE             (else → BLOCKED)
 *        b) Quiet hours not active           (else reschedule)
 *        c) To (Actual) non-empty            (else → BLOCKED)
 *        d) To (Actual) still matches the recomputed actualRecipient_
 *           of To (Intended)                 (catches mid-flight mode change)
 *        e) Not a duplicate of a Notification Log entry from the past 10 min
 *
 *   4. Successful send → Status=SENT, Sent At=now, Notification Log row written.
 *
 * Cancellation:
 *   cancelQueuedEmail_(queueId) flips Status to CANCELLED if still PENDING.
 *   cancelQueuedEmailsForCandidate_(cid, templateKey?) bulk-cancels.
 *
 * Public functions:
 *   queueEmail_(opts)
 *   sendTemplatedEmail_(templateKey, toEmail, candidateId, contextOverrides)
 *   flushEmailQueue()
 *   cancelQueuedEmail_(queueId)
 *   cancelQueuedEmailsForCandidate_(candidateId, templateKey)
 *   QUEUE_selfTest()              — DRY RUN, sends nothing
 *   QUEUE_selfTestSendOne()       — Actually sends one test email to TEST_RECIPIENT_EMAIL
 */

// Anti-flood: don't send same (to+subject+candidateId) twice within N minutes
var EMAIL_DUPLICATE_WINDOW_MIN = 10;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: queueEmail_
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue a candidate-facing email. Sends immediately if all gates pass and
 * not quiet hours; otherwise leaves PENDING for the next flush.
 *
 * @param {object} opts
 * @param {string} opts.to                    Intended candidate email (required)
 * @param {string} opts.subject               Email subject (required)
 * @param {string} opts.body                  Plain text body (required)
 * @param {string=} opts.cc
 * @param {string=} opts.bcc
 * @param {string=} opts.templateKey          For audit / dedupe / cancellation
 * @param {string=} opts.candidateId          For audit / dedupe / cancellation
 * @param {string=} opts.reason               Free-form short reason
 * @param {Date=}   opts.sendAt               Explicit send time (defaults to now)
 * @param {Date=}   opts.cancellableUntil     Informational; manager-visible deadline
 * @param {string=} opts.htmlBody             Optional HTML override (defaults to auto-wrapped plain)
 *
 * @return {string}  Queue ID of the new row
 */
function queueEmail_(opts) {
  opts = opts || {};
  if (!opts.to)      throw new Error('queueEmail_: opts.to is required');
  if (!opts.subject) throw new Error('queueEmail_: opts.subject is required');
  if (!opts.body)    throw new Error('queueEmail_: opts.body is required');

  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  var queueId = 'Q-' + Utilities.getUuid().substring(0, 8).toUpperCase();
  var now = new Date();
  var sendAt = opts.sendAt instanceof Date ? opts.sendAt : now;

  // Push to next send window if quiet-hours active and not explicitly future-scheduled
  if (!opts.sendAt && isQuietHoursNow_()) sendAt = _nextSendWindow_();

  var intended = String(opts.to).trim();
  var actual   = actualRecipient_(intended);   // TEST mode reroute / SEND_ENABLED=false → ''
  var html     = opts.htmlBody || _bodyToHtml_(opts.body);

  appendRowByHeader_(sh, {
    'Queue ID':          queueId,
    'Created At':        shopDateTime_(now),
    'Send At':           shopDateTime_(sendAt),
    'To (Intended)':     intended,
    'To (Actual)':       actual,
    'Cc':                String(opts.cc  || ''),
    'Bcc':               String(opts.bcc || ''),
    'Subject':           String(opts.subject),
    'Body HTML':         html,
    'Template Key':      String(opts.templateKey  || ''),
    'Candidate ID':      String(opts.candidateId  || ''),
    'Reason':            String(opts.reason       || ''),
    'Status':            'PENDING',
    'Sent At':           '',
    'Cancellable Until': opts.cancellableUntil instanceof Date ? shopDateTime_(opts.cancellableUntil) : '',
    'Error':             '',
    'Notes':             ''
  });

  // If sendAt is already past and gates are OK, attempt immediate send
  if (sendAt <= now) {
    safeRun_('queueEmail_:immediateSend', function () { _sendQueueRow_(queueId); });
  }

  logEvent_('EMAIL_QUEUED', opts.candidateId || '', {
    queueId: queueId, templateKey: opts.templateKey || '', toIntended: intended,
    toActual: actual, mode: isLiveMode_() ? 'LIVE' : 'TEST', sendAt: shopDateTime_(sendAt)
  });
  return queueId;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: sendTemplatedEmail_  (look up template, merge context, queue)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convenience wrapper: load an Email Templates row by Template Key, render
 * Subject + Body with the standard merge context (shop branding + hiring
 * manager + candidate row by candidateId + overrides), and queue it.
 */
function sendTemplatedEmail_(templateKey, toEmail, candidateId, overrides, queueOpts) {
  var tpl = _loadEmailTemplate_(templateKey);
  if (!tpl) {
    logError_('sendTemplatedEmail_:missingTemplate', 'Template not found: ' + templateKey, candidateId, 'ERROR');
    return '';
  }
  var ctx = _buildEmailContext_(candidateId, overrides);
  var subject = renderMerge_(tpl['Subject'], ctx);
  var body    = renderMerge_(tpl['Body'], ctx);

  var opts = Object.assign({}, queueOpts || {}, {
    to: toEmail, subject: subject, body: body,
    templateKey: templateKey, candidateId: candidateId
  });
  return queueEmail_(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: flushEmailQueue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process all PENDING rows where Send At <= now. Bounded by MAX_PER_FLUSH
 * to avoid execution-time limits. Safe to run from a time trigger.
 */
function flushEmailQueue() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('flushEmailQueue', 'OK');
  var MAX_PER_FLUSH = 50;
  // F13: EMAIL_QUEUE_ENABLED is now an explicit Config row (seeded by bootstrap),
  // so disabling the queue is a visible, deliberate switch — never a hidden default.
  if (!CFG.getBool('EMAIL_QUEUE_ENABLED', true)) {
    logEvent_('EMAIL_QUEUE_FLUSH_SKIPPED', '', 'EMAIL_QUEUE_ENABLED is FALSE');
    return '[QUEUE] flush — EMAIL_QUEUE_ENABLED is FALSE (skipped)';
  }
  return withLockOrSkip_('flushEmailQueue', function () {
    var sh = getSheet_(SHEETS.EMAIL_QUEUE);
    var last = sh.getLastRow();
    if (last < 2) return '[QUEUE] flush — empty';

    var headers = getHeaderRow_(sh);
    var hStatus  = headers.indexOf('Status');
    var hSendAt  = headers.indexOf('Send At');
    var hQid     = headers.indexOf('Queue ID');
    if (hStatus === -1 || hSendAt === -1 || hQid === -1) {
      throw new Error('flushEmailQueue: Email Queue is missing required columns');
    }

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var now = new Date();
    var summary = { scanned: 0, sent: 0, blocked: 0, failed: 0, deferred: 0 };

    for (var i = 0; i < data.length && summary.sent + summary.failed < MAX_PER_FLUSH; i++) {
      summary.scanned++;
      var status = String(data[i][hStatus]);
      if (status !== 'PENDING') continue;
      var sendAt = _coerceDate_(data[i][hSendAt]);
      if (sendAt > now) { summary.deferred++; continue; }
      var qid = String(data[i][hQid]);
      var res = _sendQueueRow_(qid);
      if (res === 'SENT')       summary.sent++;
      else if (res === 'BLOCKED') summary.blocked++;
      else                       summary.failed++;
    }

    // F18: if we hit the per-run cap with rows still due, warn LOUD and surface
    // the backlog so a burst can never accumulate silently.
    if (summary.sent + summary.failed >= MAX_PER_FLUSH) {
      var backlog = (typeof queueBacklogDue_ === 'function') ? queueBacklogDue_() : 0;
      if (backlog > 0) {
        summary.backlogRemaining = backlog;
        logError_('flushEmailQueue:cap',
          'Flush hit its per-run cap of ' + MAX_PER_FLUSH + ' with ' + backlog +
          ' email(s) still due. The 15-minute trigger will drain the rest.', '', 'WARN');
      }
    }

    var msg = '[QUEUE] flush — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('EMAIL_QUEUE_FLUSH', '', summary);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION
// ─────────────────────────────────────────────────────────────────────────────

/** Cancel one queued email by Queue ID. Returns true if row was set to CANCELLED. */
function cancelQueuedEmail_(queueId, reason) {
  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  var hits = findRowsByColumnValue_(sh, 'Queue ID', queueId);
  if (!hits.length) return false;
  var row = hits[0];
  if (row.data['Status'] !== 'PENDING') return false;
  updateRowWhere_(sh, 'Queue ID', queueId, {
    'Status':  'CANCELLED',
    'Sent At': '',
    'Error':   '',
    'Notes':   'Cancelled at ' + shopDateTime_() + (reason ? ' — ' + reason : '')
  });
  logEvent_('EMAIL_CANCELLED', row.data['Candidate ID'] || '', { queueId: queueId, reason: reason || '' });
  return true;
}

/** Bulk cancel all PENDING rows for a candidate, optionally limited to one templateKey. */
function cancelQueuedEmailsForCandidate_(candidateId, templateKey) {
  if (!candidateId) return 0;
  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);
  var hCid = headers.indexOf('Candidate ID');
  var hTpl = headers.indexOf('Template Key');
  var hSta = headers.indexOf('Status');
  var hQid = headers.indexOf('Queue ID');
  if (hCid === -1) return 0;

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var cancelled = 0;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][hCid]) !== String(candidateId)) continue;
    if (templateKey && String(data[i][hTpl]) !== String(templateKey)) continue;
    if (String(data[i][hSta]) !== 'PENDING') continue;
    if (cancelQueuedEmail_(String(data[i][hQid]), 'bulk cancel for candidate ' + candidateId)) cancelled++;
  }
  return cancelled;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: _sendQueueRow_  — the only place MailApp.sendEmail is called
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Final-gate send. Re-validates every safety check before sending.
 * Returns 'SENT' | 'BLOCKED' | 'FAILED'.
 */
function _sendQueueRow_(queueId) {
  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  var hits = findRowsByColumnValue_(sh, 'Queue ID', queueId);
  if (!hits.length) return 'FAILED';
  var rowNum = hits[0].rowNum;
  var row = hits[0].data;
  if (row['Status'] !== 'PENDING') return row['Status']; // already sent / cancelled

  // Gate (a) — global send switch
  if (!sendEnabled_()) {
    _markBlocked_(rowNum, 'SEND_ENABLED is FALSE');
    return 'BLOCKED';
  }

  // Gate (b) — quiet hours
  if (isQuietHoursNow_()) {
    var nextWin = _nextSendWindow_();
    sh.getRange(rowNum, getColIndex_(sh, 'Send At')).setValue(shopDateTime_(nextWin));
    sh.getRange(rowNum, getColIndex_(sh, 'Notes')).setValue('Deferred to ' + shopDateTime_(nextWin) + ' (quiet hours)');
    return 'BLOCKED'; // counts as not-sent this pass
  }

  // Gate (c+d) — F2: recompute the recipient at SEND time from To (Intended).
  // This self-heals rows that were queued while SEND_ENABLED was off (blank
  // recipient baked in) or under a different mode (recipient drift), so a
  // recovered BLOCKED row now sends to the correct address on the next flush
  // instead of staying dead forever. (Gate (a) already blocked when sending is
  // off, so by here sendEnabled_() is TRUE.)
  var intended = String(row['To (Intended)'] || '').trim();
  var toActual = actualRecipient_(intended);
  if (!toActual) {
    _markBlocked_(rowNum, 'No deliverable recipient: actualRecipient_("' + intended + '") is empty ' +
      '(TEST_RECIPIENT_EMAIL blank in TEST mode, or blank To (Intended) in LIVE).');
    return 'BLOCKED';
  }
  // Persist the recomputed recipient so the queue row reflects what we send.
  if (String(row['To (Actual)'] || '').trim().toLowerCase() !== toActual.toLowerCase()) {
    safeRun_('_sendQueueRow_:recomputeRecipient', function () {
      sh.getRange(rowNum, getColIndex_(sh, 'To (Actual)')).setValue(toActual);
    });
  }

  // Gate (e) — dedupe (anti-flood + per-template long-window)
  var dupeReason = _isDuplicateRecent_(toActual, row['Subject'], row['Candidate ID'], row['Template Key']);
  if (dupeReason) {
    _markBlocked_(rowNum, dupeReason);
    return 'BLOCKED';
  }

  // ────────── ALL GATES PASSED — send ──────────
  try {
    var subject = String(row['Subject']);
    var html    = String(row['Body HTML'] || '');
    var plain   = _htmlToPlain_(html);

    // GmailApp uses https://mail.google.com/ scope which the project already
    // has. MailApp would require an additional script.send_mail scope which
    // is not in this project's manifest. Functionally identical.
    var gmailOpts = {
      htmlBody: html,
      name:     CFG.get('EMAIL_FROM_NAME', "Frank's Recruiting Team")
    };
    var replyTo = CFG.get('DEFAULT_REPLY_TO_EMAIL', '');
    if (replyTo) gmailOpts.replyTo = replyTo;
    if (row['Cc'])  gmailOpts.cc  = String(row['Cc']);
    if (row['Bcc']) gmailOpts.bcc = String(row['Bcc']);

    GmailApp.sendEmail(toActual, subject, plain, gmailOpts);

    var sentAt = shopDateTime_();
    batchUpdateRow_(sh, rowNum, {
      'Status':  'SENT',
      'Sent At': sentAt,
      'Error':   ''
    });

    var sendMode = isLiveMode_() ? 'LIVE' : 'TEST';
    _logNotification_({
      to:           toActual,
      cc:           gmailOpts.cc || '',
      subject:      subject,
      templateKey:  row['Template Key'] || '',
      candidateId:  row['Candidate ID'] || '',
      mode:         sendMode,
      status:       'SENT',
      messageId:    '',  // GmailApp.sendEmail doesn't return a message id
      notes:        'Q=' + queueId + ' intended=' + intended
    });

    // Durable once-only record — written only on a real successful send.
    safeRun_('_sendQueueRow_:ledger', function () {
      _recordEmailLedger_(row['Candidate ID'] || '', row['Template Key'] || '', sendMode);
    });

    logEvent_('EMAIL_SENT', row['Candidate ID'] || '', {
      queueId: queueId, templateKey: row['Template Key'] || '',
      toActual: toActual, mode: isLiveMode_() ? 'LIVE' : 'TEST'
    });
    return 'SENT';

  } catch (e) {
    batchUpdateRow_(sh, rowNum, {
      'Status': 'FAILED',
      'Error':  truncate_(String(e.message || e), 500)
    });
    logError_('emailQueue:_sendQueueRow_', e, row['Candidate ID'] || '', 'ERROR');
    return 'FAILED';
  }
}

function _markBlocked_(rowNum, reason) {
  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  batchUpdateRow_(sh, rowNum, {
    'Status': 'BLOCKED',
    'Error':  truncate_(String(reason), 500)
  });
  Logger.log('[QUEUE] BLOCKED row ' + rowNum + ': ' + reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _loadEmailTemplate_(templateKey) {
  var sh = getSheetOrNull_(SHEETS.EMAIL_TEMPLATES);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Template Key', templateKey);
  return hits.length ? hits[0].data : null;
}

/** Look up a candidate by Candidate ID. Searches Interview Pipeline first, then All Candidates. */
function _getCandidateRow_(candidateId) {
  if (!candidateId) return null;
  var pl = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (pl) {
    var h = findRowsByColumnValue_(pl, 'Candidate ID', candidateId);
    if (h.length) return h[0].data;
  }
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (ac) {
    var h2 = findRowsByColumnValue_(ac, 'Candidate ID', candidateId);
    if (h2.length) return h2[0].data;
  }
  return null;
}

/** Read the first Active=TRUE row from Hiring Managers. */
function _getActiveHiringManager_() {
  var sh = getSheetOrNull_(SHEETS.HIRING_MANAGERS);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    var obj = {};
    headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = data[i][j]; });
    if (String(obj['Active']).trim().toUpperCase() === 'TRUE') return obj;
  }
  return null;
}

/** Read Role Rules row for given role (case-insensitive). */
function _getRoleRule_(role) {
  if (!role) return null;
  var sh = getSheetOrNull_(SHEETS.ROLE_RULES);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Role', role);
  if (hits.length) return hits[0].data;
  // case-insensitive fallback
  var last = sh.getLastRow();
  if (last < 2) return null;
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var roleCol = headers.indexOf('Role');
  if (roleCol === -1) return null;
  var target = String(role).trim().toLowerCase();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][roleCol]).trim().toLowerCase() === target) {
      var obj = {};
      headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = data[i][j]; });
      return obj;
    }
  }
  return null;
}

/**
 * Build the standard merge-field context. Order of precedence (last wins):
 *   1. Shop / company branding from Config
 *   2. Hiring manager from Hiring Managers sheet
 *   3. Candidate row from Interview Pipeline / All Candidates
 *   4. Role Rules for candidate's role
 *   5. Caller overrides
 */
function _buildEmailContext_(candidateId, overrides) {
  var ctx = {};

  // 1. Branding
  ctx.ShopName              = CFG.get('SHOP_NAME');
  ctx.ShopTagline           = CFG.get('SHOP_TAGLINE');
  ctx.ShopMission           = CFG.get('SHOP_MISSION');
  ctx.ShopCustomerPromise   = CFG.get('SHOP_CUSTOMER_PROMISE');
  ctx.ShopWhyWeHire         = CFG.get('SHOP_WHY_WE_HIRE');
  ctx.ShopTeamMessage       = CFG.get('SHOP_TEAM_MESSAGE');
  ctx.ShopWebsite           = CFG.get('SHOP_WEBSITE');
  ctx.ShopPerksLine         = CFG.get('SHOP_PERKS_LINE');
  ctx.ShopCultureLine       = CFG.get('SHOP_CULTURE_LINE');
  ctx.ShopSpecialties       = CFG.get('SHOP_SPECIALTIES');
  ctx.ShopCityState         = CFG.get('SHOP_CITY_STATE');
  ctx.CompanyName           = CFG.get('COMPANY_NAME');
  ctx.CompanyShortName      = CFG.get('COMPANY_SHORT_NAME');
  ctx.CompanyAddress        = CFG.get('COMPANY_ADDRESS');
  ctx.CompanyPhone          = CFG.get('COMPANY_PHONE');
  ctx.CompanySignatureName  = CFG.get('COMPANY_SIGNATURE_NAME');
  ctx.InterviewLocation     = CFG.get('LIVE_INTERVIEW_LOCATION') || CFG.get('INTERVIEW_LOCATION');
  ctx.SLADays               = CFG.get('CANDIDATE_RESPONSE_SLA_DAYS', '2');
  ctx.KeepDoorOpenMonths    = CFG.get('KEEP_DOOR_OPEN_MONTHS', '6');
  // Form-link merge fields fall back to the Form Registry so a missing Config
  // row never silently produces a blank link in a candidate email.
  ctx.SkillsTestLink        = CFG.get('TECH_SKILL_TEST_FORM_URL') || getFormUrl_('SKILLS_TEST');
  ctx.CultureFormLink       = CFG.get('CULTURE_FIT_FORM_URL')     || getFormUrl_('CULTURE_FIT');
  ctx.CandRefFormLink       = CFG.get('CAND_REF_FORM_URL')        || getFormUrl_('REFERENCE_SUBMISSION');
  ctx.RefCheckFormLink      = CFG.get('REF_CHECK_FORM_URL')       || getFormUrl_('REFERENCE_CHECK');
  ctx.PrescreenFormLink     = CFG.get('PRESCREEN_FORM_URL')       || getFormUrl_('PRESCREEN');

  // 2. Hiring Manager
  var hm = _getActiveHiringManager_();
  if (hm) {
    ctx.HiringManagerName    = hm['Hiring Manager Name'] || CFG.get('HIRING_MANAGER_NAME');
    ctx.HiringManagerEmail   = hm['Hiring Manager Email'] || CFG.get('HIRING_MANAGER_EMAIL');
    ctx.HiringManagerPhone   = hm['Phone'] || CFG.get('COMPANY_PHONE');
    ctx.BookingLink          = hm['Phone Screen Booking Link'] || CFG.get('DEFAULT_PHONE_BOOKING_LINK');
    ctx.FullInterviewLink    = hm['Full Interview Booking Link'] || CFG.get('DEFAULT_FULL_BOOKING_LINK');
  } else {
    ctx.HiringManagerName  = CFG.get('HIRING_MANAGER_NAME');
    ctx.HiringManagerEmail = CFG.get('HIRING_MANAGER_EMAIL');
    ctx.HiringManagerPhone = CFG.get('COMPANY_PHONE');
    ctx.BookingLink        = CFG.get('DEFAULT_PHONE_BOOKING_LINK');
    ctx.FullInterviewLink  = CFG.get('DEFAULT_FULL_BOOKING_LINK');
  }
  ctx.HiringManagerTitle   = CFG.get('HIRING_MANAGER_TITLE');

  // 3. Candidate
  var c = _getCandidateRow_(candidateId);
  if (c) {
    var first = c['First Name'] || (String(c['Full Name'] || '').split(' ')[0]) || '';
    var last  = c['Last Name']  || (String(c['Full Name'] || '').split(' ').slice(1).join(' ')) || '';
    ctx.CandidateFirstName = first;
    ctx.CandidateLastName  = last;
    ctx.CandidateName      = (first + ' ' + last).trim() || c['Full Name'] || '';
    ctx.CandidateEmail     = c['Email'] || '';
    ctx.CandidatePhone     = c['Phone'] || '';
    ctx.RoleName           = c['Role'] || '';
    ctx.CandidateId        = c['Candidate ID'] || candidateId;
  } else {
    ctx.CandidateId        = candidateId || '';
  }

  // 4. Role Rules
  if (ctx.RoleName) {
    var rr = _getRoleRule_(ctx.RoleName);
    if (rr) {
      ctx.PayRange         = rr['Pay Range'] || '';
      ctx.BookingLink      = rr['Phone Screen Booking Link'] || ctx.BookingLink;
      ctx.FullInterviewLink= rr['Full Interview Booking Link'] || ctx.FullInterviewLink;
      ctx.CultureFormLink  = rr['Culture Fit Form Link'] || ctx.CultureFormLink;
      ctx.RefCheckFormLink = rr['Reference Form Link'] || ctx.RefCheckFormLink;
    }
  }

  // 5. Overrides
  if (overrides) Object.keys(overrides).forEach(function (k) { ctx[k] = overrides[k]; });

  return ctx;
}

/**
 * Returns a non-empty reason string if the send is a duplicate, or '' if clean.
 *
 * Three independent checks (any one triggers a block):
 *
 *   1. Short-window (10 min): same (to + subject + candidateId) in the
 *      Notification Log. Guards against rapid-fire re-queuing of an identical
 *      message even across different templates.
 *
 *   2. ONCE-ONLY template guarantee (default ON via EMAIL_DEDUPE_TEMPLATE_LIFETIME):
 *      same (candidateId + templateKey + mode) ever recorded in the durable
 *      Email Sent Ledger. This is the authoritative "each candidate receives a
 *      given email at most once" gate and never expires (the ledger is not
 *      pruned). Mode-scoped, so a TEST send never blocks the real LIVE send.
 *
 *   3. Rolling-window template match (EMAIL_DUPE_TEMPLATE_WINDOW_DAYS, default
 *      7 days) against the Notification Log. Active when the lifetime guarantee
 *      is OFF, and also a belt-and-suspenders catch for sends logged before the
 *      ledger existed.
 */
function _isDuplicateRecent_(toActual, subject, candidateId, templateKey) {
  var nowMs = Date.now();
  var cA  = String(candidateId || '');
  var tkA = String(templateKey || '');
  var currentMode = (typeof isLiveMode_ === 'function' && isLiveMode_()) ? 'LIVE' : 'TEST';
  // Repeatable templates (worksheets, confirmations, internal "__" alerts) are
  // exempt from the once-only guarantee and keep the rolling-window behavior.
  var lifetime = CFG.getBool('EMAIL_DEDUPE_TEMPLATE_LIFETIME', true) && !_isTemplateRepeatable_(tkA);

  // ── Check 2: durable once-only ledger (authoritative) ──
  if (lifetime && cA !== '' && tkA !== '' && _emailAlreadySentLedger_(cA, tkA, currentMode)) {
    return 'Duplicate (once-only): template "' + tkA + '" already sent to candidate ' +
           cA + ' in ' + currentMode + ' mode — blocked by Email Sent Ledger';
  }

  var sh = getSheetOrNull_(SHEETS.NOTIFICATION_LOG);
  if (!sh) return '';
  var last = sh.getLastRow();
  if (last < 2) return '';
  var headers = getHeaderRow_(sh);
  var hTo   = headers.indexOf('To');
  var hSub  = headers.indexOf('Subject');
  var hCid  = headers.indexOf('Candidate ID');
  var hTs   = headers.indexOf('Timestamp');
  var hTpl  = headers.indexOf('Template Key');
  var hMode = headers.indexOf('Mode');
  if (hTo === -1 || hSub === -1 || hCid === -1 || hTs === -1) return '';

  var shortWindowMs = EMAIL_DUPLICATE_WINDOW_MIN * 60 * 1000;
  var windowDays    = CFG.getInt('EMAIL_DUPE_TEMPLATE_WINDOW_DAYS', 7);
  var longWindowMs  = windowDays * 24 * 60 * 60 * 1000;

  var tA  = String(toActual).toLowerCase();
  var sA  = String(subject);
  // Template scan against the log: lifetime → scan the whole log (catches
  // pre-ledger history); otherwise honor the rolling window.
  var checkTemplateLog = (cA !== '' && tkA !== '' && hTpl !== -1);
  var templateCutoffMs = lifetime ? -Infinity : (nowMs - longWindowMs);

  // For the short-window check we only need recent rows; for a lifetime template
  // scan we may need the whole log. Read once, sized to the wider need.
  var startRow = lifetime ? 2 : Math.max(2, last - 300 + 1);
  var rows = sh.getRange(startRow, 1, last - startRow + 1, headers.length).getValues();

  for (var i = rows.length - 1; i >= 0; i--) {
    var ts = _coerceDate_(rows[i][hTs]).getTime();

    // Check 1: short-window exact match (to + subject + candidateId)
    if (ts && (nowMs - ts) <= shortWindowMs) {
      if (String(rows[i][hTo]).toLowerCase() === tA &&
          String(rows[i][hSub]) === sA &&
          String(rows[i][hCid] || '') === cA) {
        return 'Duplicate: same recipient+subject+candidate within last ' + EMAIL_DUPLICATE_WINDOW_MIN + ' min';
      }
    }

    // Check 3: template match (candidateId + templateKey [+ mode])
    if (checkTemplateLog) {
      if (!ts || ts >= templateCutoffMs) {
        if (String(rows[i][hCid] || '') === cA && String(rows[i][hTpl] || '') === tkA) {
          // Mode-scope when the log carries it, so TEST history never blocks LIVE.
          var rowMode = hMode !== -1 ? String(rows[i][hMode] || '') : '';
          if (!rowMode || rowMode === currentMode) {
            var daysAgo = ts ? Math.round((nowMs - ts) / (24 * 60 * 60 * 1000)) : '?';
            return 'Duplicate: template "' + tkA + '" already sent to candidate ' + cA +
                   (rowMode ? ' in ' + rowMode + ' mode' : '') + ' ' + daysAgo + ' day(s) ago' +
                   (lifetime ? ' (once-only)' : ' (within ' + windowDays + '-day window)');
          }
        }
      } else if (!lifetime) {
        // windowed scan and we've passed the cutoff — no older row can match
        // either check, so stop.
        if (!ts || (nowMs - ts) > shortWindowMs) break;
      }
    }
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SENT LEDGER — durable once-only idempotency record
// ─────────────────────────────────────────────────────────────────────────────

// In-execution cache of ledger keys, so a single queue flush reads the sheet
// once rather than per row. Reset implicitly each execution (module reload).
var _EMAIL_LEDGER_KEYS = null;

function _emailLedgerKey_(candidateId, templateKey, mode) {
  return String(candidateId || '') + '||' + String(templateKey || '') + '||' + String(mode || '');
}

/**
 * True if a template is allowed to be sent more than once (exempt from the
 * once-only guarantee): internal manager-alert templates (key starts with "__")
 * plus anything listed in EMAIL_REPEATABLE_TEMPLATES.
 */
function _isTemplateRepeatable_(templateKey) {
  var tk = String(templateKey || '').trim();
  if (!tk) return true;                 // untemplated/internal one-off — don't ledger-block
  if (tk.indexOf('__') === 0) return true; // internal manager alerts
  var raw = CFG.get('EMAIL_REPEATABLE_TEMPLATES') || '';
  var list = raw.split(',').map(function (s) { return String(s).trim(); });
  return list.indexOf(tk) !== -1;
}

function _loadEmailLedgerKeys_() {
  if (_EMAIL_LEDGER_KEYS) return _EMAIL_LEDGER_KEYS;
  _EMAIL_LEDGER_KEYS = {};
  var sh = getSheetOrNull_(SHEETS.EMAIL_SENT_LEDGER);
  if (!sh) return _EMAIL_LEDGER_KEYS;
  var last = sh.getLastRow();
  if (last < 2) return _EMAIL_LEDGER_KEYS;
  var keyCol = getColIndex_(sh, 'Key');
  if (!keyCol) return _EMAIL_LEDGER_KEYS;
  var vals = sh.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || '').trim();
    if (k) _EMAIL_LEDGER_KEYS[k] = true;
  }
  return _EMAIL_LEDGER_KEYS;
}

function _emailAlreadySentLedger_(candidateId, templateKey, mode) {
  return !!_loadEmailLedgerKeys_()[_emailLedgerKey_(candidateId, templateKey, mode)];
}

/**
 * Record (or bump) a once-only ledger entry after a successful send. Idempotent:
 * if the key exists, increments Send Count and updates Last Attempt At rather
 * than appending a duplicate row.
 */
function _recordEmailLedger_(candidateId, templateKey, mode) {
  var cid = String(candidateId || '').trim();
  var tk  = String(templateKey || '').trim();
  if (!cid || !tk) return;                 // nothing to key on
  if (_isTemplateRepeatable_(tk)) return;  // repeatable templates are not once-only
  var sh = getSheetOrNull_(SHEETS.EMAIL_SENT_LEDGER);
  if (!sh) return; // ledger tab missing — run Bootstrap; log-based dedup still applies
  var key = _emailLedgerKey_(cid, tk, mode);
  var stamp = shopDateTime_();

  var existing = findRowsByColumnValue_(sh, 'Key', key);
  if (existing.length) {
    var rn = existing[0].rowNum;
    var prev = parseInt(existing[0].data['Send Count'], 10);
    updateRowWhere_(sh, 'Key', key, {
      'Send Count':      (isNaN(prev) ? 1 : prev + 1),
      'Last Attempt At': stamp
    });
  } else {
    appendRowByHeader_(sh, {
      'Key':           key,
      'Candidate ID':  cid,
      'Template Key':  tk,
      'Mode':          String(mode || ''),
      'First Sent At': stamp,
      'Send Count':    1,
      'Last Attempt At': stamp
    });
  }
  if (_EMAIL_LEDGER_KEYS) _EMAIL_LEDGER_KEYS[key] = true; // keep in-execution cache fresh
}

/**
 * Clear the once-only ledger for a candidate so their emails can be re-sent
 * (e.g. re-testing, or intentionally re-issuing a form invite). Removes all
 * ledger rows for the candidate across templates/modes. Returns count removed.
 */
function clearEmailLedgerForCandidate(candidateId) {
  return withLock_(function () {
    var cid = String(candidateId || '').trim();
    if (!cid) return 0;
    var sh = getSheetOrNull_(SHEETS.EMAIL_SENT_LEDGER);
    if (!sh) return 0;
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var cidCol = getColIndex_(sh, 'Candidate ID');
    if (!cidCol) return 0;
    var vals = sh.getRange(2, cidCol, last - 1, 1).getValues();
    var toDelete = [];
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === cid) toDelete.push(i + 2);
    }
    toDelete.sort(function (a, b) { return b - a; }).forEach(function (rn) { sh.deleteRow(rn); });
    _EMAIL_LEDGER_KEYS = null; // invalidate cache
    logEvent_('EMAIL_LEDGER_CLEARED', cid, { removed: toDelete.length });
    toast_('Cleared ' + toDelete.length + ' email-ledger row(s) for ' + cid + ' — emails can re-send', 'Recruiting OS', 6);
    return toDelete.length;
  });
}

function _logNotification_(n) {
  var sh = getSheetOrNull_(SHEETS.NOTIFICATION_LOG);
  if (!sh) return;
  appendRowByHeader_(sh, {
    'Timestamp':    shopDateTime_(),
    'To':           String(n.to || ''),
    'Cc':           String(n.cc || ''),
    'Subject':      String(n.subject || ''),
    'Template Key': String(n.templateKey || ''),
    'Candidate ID': String(n.candidateId || ''),
    'Mode':         String(n.mode || ''),
    'Status':       String(n.status || ''),
    'Message ID':   String(n.messageId || ''),
    'Notes':        String(n.notes || '')
  });
}

/**
 * Next moment we may send. If we're inside quiet hours, returns the next
 * occurrence of QUIET_HOURS_START in shop time. Otherwise returns now.
 */
function _nextSendWindow_() {
  if (!isQuietHoursNow_()) return new Date();
  var tz    = CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles');
  var start = CFG.getInt('QUIET_HOURS_START', 7);
  // Compute today's start hour in shop tz
  var now = new Date();
  var shopHourNow = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  // If we're past quiet-end already we'd not be in quiet hours; so we're either
  // late evening (push to tomorrow morning) or pre-dawn (push to today's start).
  var msPerHour = 60 * 60 * 1000;
  var hoursToAdd;
  if (shopHourNow >= start) {
    // late evening → tomorrow's start
    hoursToAdd = (24 - shopHourNow) + start;
  } else {
    // pre-dawn → today's start
    hoursToAdd = start - shopHourNow;
  }
  var next = new Date(now.getTime() + hoursToAdd * msPerHour);
  // Round down to top of hour
  next.setMinutes(0); next.setSeconds(0); next.setMilliseconds(0);
  return next;
}

function _bodyToHtml_(plain) {
  return '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">'
       + escapeHtml_(String(plain || '')).replace(/\n/g, '<br>')
       + '</div>';
}

function _htmlToPlain_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TESTS — TWO variants: one dry (no email leaves), one that sends 1.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dry-run: queues two synthetic emails, verifies safety rerouting and dedupe,
 * then cancels both rows. No email is sent.
 */
function QUEUE_selfTest() {
  var out = ['[QUEUE] selfTest (dry run — no emails sent)…'];
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh) { out.push('  ✗ Email Queue sheet missing — run bootstrapSystem()'); Logger.log(out.join('\n')); return out.join('\n'); }

  out.push('  ─ Mode: ' + (isLiveMode_() ? 'LIVE' : 'TEST'));
  out.push('  ─ SEND_ENABLED: ' + sendEnabled_());
  out.push('  ─ TEST_RECIPIENT_EMAIL: ' + CFG.get('TEST_RECIPIENT_EMAIL'));
  out.push('  ─ Quiet hours now: ' + isQuietHoursNow_());

  // Force sendAt to far-future so immediate-send doesn't fire
  var future = new Date(Date.now() + 24 * 60 * 60 * 1000);

  var qid1 = queueEmail_({
    to: 'fake_candidate_1@example.com',
    subject: '[SELFTEST] dry-run row 1 — please ignore',
    body: 'This row will be cancelled. No email sent.',
    candidateId: 'FES-TEST-SELFTEST',
    templateKey: '__selftest__',
    reason: 'QUEUE_selfTest',
    sendAt: future
  });
  out.push('  ✓ queueEmail_ row 1 created → Queue ID ' + qid1);

  var qid2 = queueEmail_({
    to: 'fake_candidate_2@example.com',
    subject: '[SELFTEST] dry-run row 2 — please ignore',
    body: 'Second test row.',
    candidateId: 'FES-TEST-SELFTEST',
    templateKey: '__selftest__',
    reason: 'QUEUE_selfTest',
    sendAt: future
  });
  out.push('  ✓ queueEmail_ row 2 created → Queue ID ' + qid2);

  // Verify TEST mode rerouted recipient
  var h1 = findRowsByColumnValue_(sh, 'Queue ID', qid1)[0];
  var expected = isTestMode_() ? CFG.get('TEST_RECIPIENT_EMAIL') : 'fake_candidate_1@example.com';
  out.push('  ' + (String(h1.data['To (Actual)']).toLowerCase() === String(expected).toLowerCase() ? '✓' : '✗') +
           ' Row 1 To (Actual) = "' + h1.data['To (Actual)'] + '" (expected "' + expected + '")');

  // Cancel both
  out.push('  ' + (cancelQueuedEmail_(qid1, 'selftest cleanup') ? '✓' : '✗') + ' cancelQueuedEmail_ row 1');
  out.push('  ' + (cancelQueuedEmail_(qid2, 'selftest cleanup') ? '✓' : '✗') + ' cancelQueuedEmail_ row 2');

  // Bulk cancel sanity
  var bulk = cancelQueuedEmailsForCandidate_('FES-TEST-SELFTEST');
  out.push('  ✓ bulk cancel for FES-TEST-SELFTEST → ' + bulk + ' (expected 0 — already cancelled)');

  // Once-only ledger wiring
  var ledger = getSheetOrNull_(SHEETS.EMAIL_SENT_LEDGER);
  out.push('  ' + (ledger ? '✓' : '✗') + ' Email Sent Ledger tab ' + (ledger ? 'present' : 'MISSING — run Bootstrap'));
  out.push('  ─ EMAIL_DEDUPE_TEMPLATE_LIFETIME: ' + CFG.getBool('EMAIL_DEDUPE_TEMPLATE_LIFETIME', true) + ' (each candidate gets a given template once, ever, per mode)');
  out.push('  ─ Repeatable (exempt) templates : ' + (CFG.get('EMAIL_REPEATABLE_TEMPLATES') || '(none)') + ' + any "__"-prefixed internal alert');
  out.push('  ─ reference_and_culture_invite repeatable? ' + _isTemplateRepeatable_('reference_and_culture_invite') + ' (expected false)');
  out.push('  ─ interview_worksheet_dayof repeatable? ' + _isTemplateRepeatable_('interview_worksheet_dayof') + ' (expected true)');

  out.push('[QUEUE] selfTest done. Test rows left in Email Queue with Status=CANCELLED for review.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Actually sends ONE test email to TEST_RECIPIENT_EMAIL.
 * Use this once to verify deliverability after deployment. Will NOT send if
 * SEND_ENABLED=FALSE or if you somehow flip into LIVE mode (extra guard).
 */
function QUEUE_selfTestSendOne() {
  if (isLiveMode_()) {
    var w = 'QUEUE_selfTestSendOne refuses to run in LIVE mode (deliverability test should only run in TEST mode).';
    Logger.log(w); return w;
  }
  if (!sendEnabled_()) {
    var w2 = 'QUEUE_selfTestSendOne: SEND_ENABLED is FALSE — nothing sent.';
    Logger.log(w2); return w2;
  }
  var subj = '[SELFTEST] Recruiting OS deliverability test — ' + shopDateTime_();
  var body = 'This is a deliverability test sent by QUEUE_selfTestSendOne().\n\n' +
             'If you received this at the address ' + CFG.get('TEST_RECIPIENT_EMAIL') +
             ', the email queue and Gmail integration are working.\n\n' +
             '— Recruiting OS';
  var qid = queueEmail_({
    to: 'safety_check_target@example.com',  // intended (will be rerouted in TEST mode)
    subject: subj,
    body: body,
    templateKey: '__selftest_send__',
    reason: 'QUEUE_selfTestSendOne',
    candidateId: ''
  });
  return '[QUEUE] selfTestSendOne — queued Q=' + qid +
         '. Check Email Queue, Notification Log, and your inbox (' + CFG.get('TEST_RECIPIENT_EMAIL') + ').';
}
