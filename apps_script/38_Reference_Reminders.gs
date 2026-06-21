/**
 * 38_Reference_Reminders.gs
 * Frank's European Service — Recruiting OS
 *
 * Keeps the final stage from stalling silently. When the manager picks
 * "Request References" (16_Dropdown_Actions.gs), the candidate's deadline is
 * stamped into the "Reference Deadline" column and Status → REFS_REQUESTED.
 *
 * This module, run daily from autoMaintenance (28_Pipeline_Dedup.gs), does two
 * things for every candidate still sitting in REFS_REQUESTED:
 *
 *   1) REMINDER — once the deadline is within REFERENCE_REMINDER_HOURS_BEFORE
 *      (default 24h), send ONE gentle reminder (reference_culture_reminder) and
 *      stamp "Reference Reminder Sent" so it never repeats.
 *
 *   2) AUTO-PARK — once the deadline + REFERENCE_NO_RESPONSE_GRACE_HOURS passes
 *      with no submission, optionally move the candidate to the drawer
 *      (REFERENCE_AUTO_PARK_ON_NO_RESPONSE). No extra candidate email is sent —
 *      they already got the request and the reminder.
 *
 * A candidate who submits references leaves REFS_REQUESTED (→ REFS_PENDING) and
 * is automatically excluded from both actions.
 *
 * Public functions:
 *   sendReferenceDeadlineReminders()   — the daily sweep (idempotent)
 *   REFREMINDER_selfTest()
 */

function sendReferenceDeadlineReminders() {
  return safeRun_('sendReferenceDeadlineReminders', function () {
    if (!CFG.getBool('REFERENCE_REMINDER_ENABLED', true)) return '[REFREM] disabled';

    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (!ip) return '[REFREM] pipeline missing';
    var last = ip.getLastRow();
    if (last < 2) return '[REFREM] pipeline empty';

    var headers = getHeaderRow_(ip);
    var H = {}; headers.forEach(function (h, i) { H[h] = i; });
    if (H['Status'] === undefined || H['Candidate ID'] === undefined || H['Reference Deadline'] === undefined) {
      return '[REFREM] required columns missing (Status / Candidate ID / Reference Deadline) — run Bootstrap';
    }

    var hoursBefore = CFG.getInt('REFERENCE_REMINDER_HOURS_BEFORE', 24);
    var graceHours  = CFG.getInt('REFERENCE_NO_RESPONSE_GRACE_HOURS', 24);
    var autoPark    = CFG.getBool('REFERENCE_AUTO_PARK_ON_NO_RESPONSE', true);
    var now         = Date.now();
    var remindMs    = hoursBefore * 3600 * 1000;
    var graceMs     = graceHours  * 3600 * 1000;

    var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, reminded: 0, parked: 0, skipped: 0 };

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (String(row[H['Status']] || '').trim() !== STATUS.REFS_REQUESTED) continue;
      summary.scanned++;

      var cid = String(row[H['Candidate ID']] || '').trim();
      var deadlineRaw = row[H['Reference Deadline']];
      if (!cid || !deadlineRaw) { summary.skipped++; continue; }

      var deadline = _coerceDate_(deadlineRaw);
      if (!deadline || isNaN(deadline.getTime())) { summary.skipped++; continue; }
      var deadlineMs = deadline.getTime();

      var alreadyReminded = H['Reference Reminder Sent'] !== undefined &&
                            String(row[H['Reference Reminder Sent']] || '').trim() !== '';

      // 1) Reminder — within the pre-deadline window (or just past it) and not yet sent.
      if (!alreadyReminded && (deadlineMs - now) <= remindMs && (now - deadlineMs) <= graceMs) {
        var email = String(row[H['Email']] || '').trim();
        if (email) {
          var label = Utilities.formatDate(deadline, CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles'), 'EEE, MMM d') + ' by 5:00 PM';
          sendTemplatedEmail_('reference_culture_reminder', email, cid, {
            ResponseDeadline: label
          }, {
            reason: 'reference/culture deadline reminder'
          });
          if (H['Reference Reminder Sent'] !== undefined) {
            updateRowWhere_(ip, 'Candidate ID', cid, { 'Reference Reminder Sent': shopDateTime_() });
          }
          logEvent_('REF_REMINDER_SENT', cid, { deadline: shopDateTime_(deadline) });
          summary.reminded++;
        }
      }

      // 2) Auto-park — deadline + grace elapsed with no submission.
      if (autoPark && (now - deadlineMs) > graceMs) {
        _setCandidateStatus_(cid, STATUS.IN_DRAWER,
          'Auto-parked: no references/culture submitted by ' + shopDateTime_(deadline) + ' (+ ' + graceHours + 'h grace)');
        logEvent_('REF_NO_RESPONSE_PARKED', cid, { deadline: shopDateTime_(deadline) });
        summary.parked++;
      }
    }

    var msg = '[REFREM] sendReferenceDeadlineReminders — ' + JSON.stringify(summary);
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function REFREMINDER_selfTest() {
  var out = ['[REFREM] selfTest (read-only)…'];
  out.push('  ─ REFERENCE_REMINDER_ENABLED       : ' + CFG.getBool('REFERENCE_REMINDER_ENABLED', true));
  out.push('  ─ REFERENCE_REMINDER_HOURS_BEFORE  : ' + CFG.getInt('REFERENCE_REMINDER_HOURS_BEFORE', 24));
  out.push('  ─ REFERENCE_AUTO_PARK_ON_NO_RESPONSE: ' + CFG.getBool('REFERENCE_AUTO_PARK_ON_NO_RESPONSE', true));
  out.push('  ─ REFERENCE_NO_RESPONSE_GRACE_HOURS : ' + CFG.getInt('REFERENCE_NO_RESPONSE_GRACE_HOURS', 24));
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    out.push('  ─ Reference Deadline column     : ' + (getColIndex_(ip, 'Reference Deadline') ? 'present' : 'MISSING — run Bootstrap'));
    out.push('  ─ Reference Reminder Sent column: ' + (getColIndex_(ip, 'Reference Reminder Sent') ? 'present' : 'missing (reminder will resend daily without it)'));
  }
  out.push('[REFREM] selfTest done. Reminders run daily via autoMaintenance.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
