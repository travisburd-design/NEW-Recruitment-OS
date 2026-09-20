/**
 * 46_Auto_Advance.gs
 * Frank's European Service — Recruiting OS
 *
 * AUTO-ADVANCE TO LIVE INTERVIEW.
 *
 * THE BOTTLENECK THIS REMOVES
 * ---------------------------
 * Before this module, the pipeline ran itself up to the phone screen and then
 * stopped dead. A candidate could be graded 92, have a strong phone screen
 * transcript, and sit untouched until the hiring manager happened to open the
 * workbook and pick a dropdown value. Strong candidates take other offers in
 * that gap.
 *
 * HOW IT WORKS
 * ------------
 *   1. Every 15 minutes, scan the Interview Pipeline for PHONE_DONE candidates
 *      whose graded phone score clears the role's live-interview bar and whose
 *      risk is inside the ceiling.
 *   2. Queue them with a HOLD (default 60 minutes) and email the hiring manager
 *      a single heads-up naming everyone about to be advanced.
 *   3. When the hold expires, send the live-interview booking link automatically
 *      via the normal dropdown path (_dispatchAdvanceLive_), so status, override
 *      logging and the once-only email ledger all behave identically to a manual
 *      advance.
 *   4. To stop one, set its Decision to anything, or set its Auto Advance Queue
 *      row Status to CANCELLED, before the hold expires.
 *
 * SAFETY
 * ------
 *   • Never rejects, never archives, never sends anything to a candidate other
 *     than the live-interview booking link they would have received anyway.
 *   • Honours SYSTEM_MODE / SEND_ENABLED — in TEST everything reroutes to the
 *     test recipient exactly like every other send.
 *   • Skips any candidate whose Decision column is already set (the manager
 *     touched them, so the manager owns them).
 *   • Master switch: AUTO_ADVANCE_LIVE_ENABLED=FALSE turns the whole thing off.
 *
 * Public functions:
 *   AUTOADV_run()            — trigger entry (scan + queue + release)
 *   AUTOADV_previewNow()     — read-only: who would be advanced right now
 *   AUTOADV_cancel(id)       — cancel a queued advance
 *   AUTOADV_installTrigger() — install the 15-minute trigger
 *   AUTOADV_selfTest()
 */

var AUTOADV_SHEET = 'Auto Advance Queue';
var AUTOADV_HEADERS = Object.freeze([
  'Queued At', 'Candidate ID', 'Full Name', 'Role', 'Phone Score', 'Risk Score',
  'Release At', 'Status', 'Released At', 'Reason', 'Notes'
]);

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────

/** Live-interview bar for a role. Role Rules column wins; Config is the default. */
function AUTOADV_bar_(roleRule) {
  var fromRule = roleRule ? parseFloat(roleRule['Auto Advance Live Minimum Score']) : NaN;
  if (!isNaN(fromRule) && fromRule > 0) return fromRule;
  // Sensible default: the role's auto-booking bar, since a live interview is a
  // bigger commitment than a phone screen.
  var autoMin = roleRule ? parseFloat(roleRule['Auto Booking Minimum Score']) : NaN;
  var dflt = CFG.getInt('AUTO_ADVANCE_LIVE_MIN_SCORE', 0);
  if (dflt > 0) return dflt;
  return isNaN(autoMin) ? 80 : autoMin;
}

function AUTOADV_maxRisk_(roleRule) {
  var r = roleRule ? parseFloat(roleRule['Max Risk Score For Auto Booking']) : NaN;
  if (!isNaN(r)) return r;
  return CFG.getInt('AUTO_ADVANCE_LIVE_MAX_RISK', 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

/** Trigger entry: release anything past its hold, then queue new candidates. */
function AUTOADV_run() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('AUTOADV_run', 'OK');
  if (!CFG.getBool('AUTO_ADVANCE_LIVE_ENABLED', true)) {
    logEvent_('AUTOADV_SKIPPED', '', 'AUTO_ADVANCE_LIVE_ENABLED=FALSE');
    return '[AUTOADV] disabled';
  }
  return withLockOrSkip_('AUTOADV_run', function () {
    var released = AUTOADV_releaseDue_();
    var queued   = AUTOADV_queueEligible_();
    var msg = '[AUTOADV] released=' + released.released + ' skipped=' + released.skipped +
              ' newlyQueued=' + queued.queued + ' scanned=' + queued.scanned;
    Logger.log(msg);
    logEvent_('AUTOADV_RUN', '', { released: released.released, queued: queued.queued });
    return msg;
  });
}

/** Find PHONE_DONE candidates over the bar and queue them with a hold. */
function AUTOADV_queueEligible_() {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return { scanned: 0, queued: 0 };
  var last = ip.getLastRow();
  if (last < 2) return { scanned: 0, queued: 0 };

  var headers = getHeaderRow_(ip);
  var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
  function c(n) { return headers.indexOf(n); }
  var cId = c('Candidate ID'), cStatus = c('Status'), cPhone = c('Phone Score'),
      cRisk = c('Risk Score'), cRole = c('Role'), cFn = c('First Name'),
      cLn = c('Last Name'), cDecision = c('Decision');

  var holdMin = CFG.getInt('AUTO_ADVANCE_HOLD_MINUTES', 60);
  var queue = getOrCreateSheet_(AUTOADV_SHEET, AUTOADV_HEADERS);
  ensureHeaders_(queue, AUTOADV_HEADERS);
  var existing = AUTOADV_openIds_(queue);

  var scanned = 0, queued = 0, heads = [];

  data.forEach(function (r) {
    scanned++;
    var id = String(r[cId] || '').trim();
    if (!id || existing[id]) return;
    if (String(r[cStatus] || '').toUpperCase() !== String(STATUS.PHONE_DONE).toUpperCase()) return;
    // The manager already touched this candidate — they own it.
    if (cDecision >= 0 && String(r[cDecision] || '').trim()) return;

    var phone = parseFloat(r[cPhone]);
    if (isNaN(phone) || phone <= 0) return;
    var risk = cRisk >= 0 ? parseFloat(r[cRisk]) : 0;
    if (isNaN(risk)) risk = 0;

    var role = cRole >= 0 ? String(r[cRole] || '') : '';
    var rule = _getRoleRule_(role);
    var bar = AUTOADV_bar_(rule), maxRisk = AUTOADV_maxRisk_(rule);

    if (phone < bar) return;
    if (risk > maxRisk) {
      logEvent_('AUTOADV_BLOCKED_BY_RISK', id, { phone: phone, risk: risk, maxRisk: maxRisk });
      return;
    }

    var name = ((cFn >= 0 ? r[cFn] : '') + ' ' + (cLn >= 0 ? r[cLn] : '')).trim();
    var releaseAt = new Date(Date.now() + holdMin * 60 * 1000);

    appendRowByHeader_(queue, {
      'Queued At':   shopDateTime_(),
      'Candidate ID': id, 'Full Name': name, 'Role': role,
      'Phone Score': phone, 'Risk Score': risk,
      'Release At':  shopDateTime_(releaseAt),
      'Status':      'PENDING',
      'Released At': '',
      'Reason':      'Phone score ' + phone + ' >= bar ' + bar + ', risk ' + risk + ' <= ' + maxRisk,
      'Notes':       'Auto-advance to live interview in ' + holdMin + ' min unless cancelled.'
    });
    // Store the real timestamp for reliable comparison.
    _autoAdvSetReleaseMs_(queue, id, releaseAt.getTime());

    queued++;
    heads.push('• ' + name + ' — ' + role + ' — phone ' + phone + ' (risk ' + risk + ')');
    logEvent_('AUTOADV_QUEUED', id, { phone: phone, risk: risk, bar: bar, holdMin: holdMin });
  });

  if (heads.length) AUTOADV_notifyManager_(heads, holdMin);
  return { scanned: scanned, queued: queued };
}

/** Send the live-interview link for anything whose hold has expired. */
function AUTOADV_releaseDue_() {
  var queue = getSheetOrNull_(AUTOADV_SHEET);
  if (!queue) return { released: 0, skipped: 0 };
  var last = queue.getLastRow();
  if (last < 2) return { released: 0, skipped: 0 };

  var headers = getHeaderRow_(queue);
  var data = queue.getRange(2, 1, last - 1, headers.length).getValues();
  var cId = headers.indexOf('Candidate ID'), cStatus = headers.indexOf('Status'),
      cRel = headers.indexOf('Release At');

  var now = Date.now(), released = 0, skipped = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][cStatus] || '').toUpperCase() !== 'PENDING') continue;
    var relMs = _autoAdvGetReleaseMs_(queue, i + 2, data[i][cRel]);
    if (relMs > now) { skipped++; continue; }

    var id = String(data[i][cId] || '').trim();
    if (!id) continue;

    // Re-read the pipeline: the manager may have acted during the hold.
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    var hits = ip ? findRowsByColumnValue_(ip, 'Candidate ID', id) : [];
    if (!hits.length) {
      queue.getRange(i + 2, cStatus + 1).setValue('SKIPPED');
      skipped++; continue;
    }
    var row = hits[0].data;
    var stillPhoneDone = String(row['Status'] || '').toUpperCase() === String(STATUS.PHONE_DONE).toUpperCase();
    var untouched = !String(row['Decision'] || '').trim();
    if (!stillPhoneDone || !untouched) {
      queue.getRange(i + 2, cStatus + 1).setValue('SUPERSEDED');
      logEvent_('AUTOADV_SUPERSEDED', id, { status: row['Status'], decision: row['Decision'] });
      skipped++; continue;
    }

    var candidate = _getCandidateRow_(id) || row;
    try {
      _dispatchAdvanceLive_(id, candidate);
      queue.getRange(i + 2, cStatus + 1).setValue('RELEASED');
      queue.getRange(i + 2, headers.indexOf('Released At') + 1).setValue(shopDateTime_());
      if (typeof logOverride_ === 'function') {
        safeRun_('autoadv:override', function () {
          logOverride_({
            actor:         'SYSTEM (auto-advance)',
            candidateId:   id,
            overrideType:  'Auto Advance to Live Interview',
            previousValue: String(row['Status'] || ''),
            newValue:      String(STATUS.FULL_BOOKED),
            reason:        'Phone score ' + row['Phone Score'] + ' cleared the role bar; ' +
                           'hold expired with no manager action.'
          });
        });
      }
      logEvent_('AUTOADV_RELEASED', id, { phoneScore: row['Phone Score'], risk: row['Risk Score'] });
      released++;
    } catch (e) {
      queue.getRange(i + 2, cStatus + 1).setValue('ERROR');
      logError_('AUTOADV_releaseDue_:' + id, e, id, 'ERROR');
      skipped++;
    }
  }
  return { released: released, skipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function AUTOADV_openIds_(queue) {
  var map = {};
  var last = queue.getLastRow();
  if (last < 2) return map;
  var headers = getHeaderRow_(queue);
  var cId = headers.indexOf('Candidate ID'), cStatus = headers.indexOf('Status');
  var data = queue.getRange(2, 1, last - 1, headers.length).getValues();
  data.forEach(function (r) {
    var st = String(r[cStatus] || '').toUpperCase();
    if (st === 'PENDING' || st === 'RELEASED') map[String(r[cId] || '').trim()] = true;
  });
  return map;
}

/** Store the release instant in the developer metadata-free way: a hidden note. */
function _autoAdvSetReleaseMs_(queue, candidateId, ms) {
  try {
    var headers = getHeaderRow_(queue);
    var cId = headers.indexOf('Candidate ID') + 1, cRel = headers.indexOf('Release At') + 1;
    var last = queue.getLastRow();
    for (var r = last; r >= 2; r--) {
      if (String(queue.getRange(r, cId).getValue() || '').trim() === candidateId) {
        queue.getRange(r, cRel).setNote(String(ms));
        return;
      }
    }
  } catch (e) { /* note is an optimisation, not a requirement */ }
}

function _autoAdvGetReleaseMs_(queue, rowNum, displayValue) {
  try {
    var headers = getHeaderRow_(queue);
    var note = queue.getRange(rowNum, headers.indexOf('Release At') + 1).getNote();
    var ms = parseInt(note, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  } catch (e) {}
  var d = (displayValue instanceof Date) ? displayValue : new Date(displayValue);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function AUTOADV_notifyManager_(lines, holdMin) {
  var to = CFG.get('HIRING_MANAGER_EMAIL');
  if (!to) return;
  var subject = 'Auto-advance in ' + holdMin + ' min — ' + lines.length + ' candidate(s) → live interview';
  var body =
    'These candidates cleared their role\'s live-interview bar on the phone screen and will be sent the ' +
    'live-interview booking link automatically in ' + holdMin + ' minutes:\n\n' +
    lines.join('\n') +
    '\n\nTo stop one: open the Interview Pipeline and set that candidate\'s Decision to anything, ' +
    'or set their row in the "' + AUTOADV_SHEET + '" tab to CANCELLED.\n\n' +
    'No action needed to let them through.';
  // Internal manager alert. Template keys starting with "__" are treated as
  // repeatable by the queue, exactly like the daily digest.
  safeRun_('autoadv:notify', function () {
    queueEmail_({
      to: to, subject: subject, body: body,
      templateKey: '__auto_advance__', reason: 'auto-advance heads-up'
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

/** Cancel a queued auto-advance. */
function AUTOADV_cancel(candidateId) {
  var queue = getSheetOrNull_(AUTOADV_SHEET);
  if (!queue) return '[AUTOADV] no queue';
  var headers = getHeaderRow_(queue);
  var cId = headers.indexOf('Candidate ID') + 1, cStatus = headers.indexOf('Status') + 1;
  var last = queue.getLastRow();
  for (var r = 2; r <= last; r++) {
    if (String(queue.getRange(r, cId).getValue() || '').trim() === candidateId &&
        String(queue.getRange(r, cStatus).getValue() || '').toUpperCase() === 'PENDING') {
      queue.getRange(r, cStatus).setValue('CANCELLED');
      logEvent_('AUTOADV_CANCELLED', candidateId, {});
      return '[AUTOADV] cancelled ' + candidateId;
    }
  }
  return '[AUTOADV] no pending row for ' + candidateId;
}

/** Read-only: who is eligible right now, without queueing anything. */
function AUTOADV_previewNow() {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var out = ['[AUTOADV] preview — ' + shopDateTime_()];
  if (!ip || ip.getLastRow() < 2) { out.push('  pipeline empty'); Logger.log(out.join('\n')); return out.join('\n'); }
  var headers = getHeaderRow_(ip);
  var data = ip.getRange(2, 1, ip.getLastRow() - 1, headers.length).getValues();
  function c(n) { return headers.indexOf(n); }
  var cStatus = c('Status'), cPhone = c('Phone Score'), cRisk = c('Risk Score'),
      cRole = c('Role'), cFn = c('First Name'), cLn = c('Last Name');
  var n = 0;
  data.forEach(function (r) {
    if (String(r[cStatus] || '').toUpperCase() !== String(STATUS.PHONE_DONE).toUpperCase()) return;
    var phone = parseFloat(r[cPhone]); if (isNaN(phone)) phone = 0;
    var risk = parseFloat(r[cRisk]); if (isNaN(risk)) risk = 0;
    var rule = _getRoleRule_(String(r[cRole] || ''));
    var bar = AUTOADV_bar_(rule), maxRisk = AUTOADV_maxRisk_(rule);
    var pass = phone >= bar && risk <= maxRisk;
    n++;
    out.push('  ' + (pass ? '→ ADVANCE' : '   hold  ') + '  ' +
             ((r[cFn] || '') + ' ' + (r[cLn] || '')).trim() + ' (' + r[cRole] + ')  phone=' + phone +
             ' bar=' + bar + '  risk=' + risk + ' max=' + maxRisk);
  });
  if (!n) out.push('  no candidates in PHONE_DONE');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Install the 15-minute trigger. Idempotent. */
function AUTOADV_installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'AUTOADV_run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('AUTOADV_run').timeBased().everyMinutes(15).create();
  var msg = '[AUTOADV] 15-minute trigger installed';
  Logger.log(msg);
  try { toast_(msg, 'Recruiting OS', 6); } catch (e) {}
  return msg;
}

function AUTOADV_selfTest() {
  var out = ['[AUTOADV] selfTest…'];
  out.push('  ─ AUTO_ADVANCE_LIVE_ENABLED : ' + CFG.getBool('AUTO_ADVANCE_LIVE_ENABLED', true));
  out.push('  ─ AUTO_ADVANCE_HOLD_MINUTES : ' + CFG.getInt('AUTO_ADVANCE_HOLD_MINUTES', 60));
  ['Technician', 'Service Advisor'].forEach(function (role) {
    var rule = _getRoleRule_(role);
    out.push('  ─ ' + role + ': live bar=' + AUTOADV_bar_(rule) + '  maxRisk=' + AUTOADV_maxRisk_(rule));
  });
  var q = getSheetOrNull_(AUTOADV_SHEET);
  out.push('  ─ queue rows : ' + (q ? Math.max(0, q.getLastRow() - 1) : 'tab not created yet'));
  var installed = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'AUTOADV_run'; });
  out.push('  ' + (installed ? '✓' : '✗') + ' AUTOADV_run trigger installed' + (installed ? '' : ' — run AUTOADV_installTrigger()'));
  out.push('[AUTOADV] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}