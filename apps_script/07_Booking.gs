/**
 * 07_Booking.gs
 * Frank's European Service — Recruiting OS
 *
 * Phone screen / full interview booking helpers. Two responsibilities:
 *   1) Send booking-link emails on demand (called from 06_Scoring_Risk auto-book
 *      path or 16_Dropdown_Actions advance-to-live path; both already wired).
 *   2) Poll the recruiting calendar for newly-booked interview events, match
 *      them to candidates by attendee email, update status, and notify the
 *      hiring manager.
 *
 * We do NOT integrate with the Koalendar API directly — Koalendar drops the
 * booked event onto the configured Google Calendar (INTERVIEW_CALENDAR_ID).
 * That calendar is our source of truth; the poller scans recent events.
 *
 * Public functions:
 *   sendPhoneBookingLink_(candidateId)
 *   sendFullInterviewLink_(candidateId)
 *   pollCalendarBookings()           — daily trigger fires this
 *   BOOKING_selfTest()
 *
 * Booking Events log:
 *   Every detected/matched booking is ALSO appended to the "Booking Events"
 *   sheet (time-indexed, idempotent by Calendar Event ID). 08_Otter_Transcripts
 *   uses this log to match in-person Otter recordings — which carry no email or
 *   candidate ID — to the candidate whose booked interview is closest in time.
 */

// Display name for the time-indexed booking log. SHEETS.BOOKING_EVENTS does not
// exist in 00_Config (that file is owned elsewhere), so we reference the tab by
// its literal name here. Keep this string in sync with /tmp/port_spec2.md.
var BOOKING_EVENTS_SHEET_NAME = 'Booking Events';
var BOOKING_EVENTS_HEADERS = [
  'Candidate ID', 'Full Name', 'Email', 'Phone', 'Scheduled For',
  'Interview Type', 'Calendar Event ID', 'Recorded At'
];

// ─────────────────────────────────────────────────────────────────────────────
// SEND BOOKING LINKS (called from scoring / dropdown actions)
// ─────────────────────────────────────────────────────────────────────────────

function sendPhoneBookingLink_(candidateId) {
  var c = _getCandidateRow_(candidateId);
  if (!c) { logError_('sendPhoneBookingLink_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return ''; }
  if (!c['Email']) { logError_('sendPhoneBookingLink_', 'no email', candidateId, 'WARN'); return ''; }
  return sendTemplatedEmail_('phone_screen_booking', c['Email'], candidateId, null, {
    reason: 'phone screen booking link'
  });
}

function sendFullInterviewLink_(candidateId) {
  var c = _getCandidateRow_(candidateId);
  if (!c) { logError_('sendFullInterviewLink_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return ''; }
  if (!c['Email']) { logError_('sendFullInterviewLink_', 'no email', candidateId, 'WARN'); return ''; }
  return sendTemplatedEmail_('full_interview_booking', c['Email'], candidateId, null, {
    reason: 'full interview booking link'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR POLLING — detect newly-booked interviews
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan the configured INTERVIEW_CALENDAR_ID for events in the next
 * INTERVIEW_BLOCK_LOOKAHEAD_DAYS. For each event, try to match an attendee
 * email to a candidate. If a candidate is matched and not already marked
 * booked, update status and (optionally) alert manager.
 */
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

function _notifyManagerBooked_(candidateId, candidate, ev, phase) {
  var first = candidate['First Name'] || (String(candidate['Full Name'] || '').split(' ')[0]) || '';
  var last  = candidate['Last Name']  || '';
  var name  = (first + ' ' + last).trim();
  var role  = candidate['Role'] || '';
  var subj  = phase + ' booked — ' + name + ' (' + role + ') — ' + shopDateTime_(ev.getStartTime());
  var body  =
'Booking confirmed via calendar.\n\n' +
'Candidate : ' + name + '\n' +
'Role      : ' + role + '\n' +
'Phase     : ' + phase + '\n' +
'When      : ' + shopDateTime_(ev.getStartTime()) + '\n' +
'Event     : ' + (ev.getTitle() || '') + '\n' +
'Candidate Email: ' + (candidate['Email'] || '') + '\n' +
'Candidate Phone: ' + (candidate['Phone'] || '') + '\n' +
'Candidate ID   : ' + candidateId + '\n\n' +
'— Recruiting OS';
  queueEmail_({
    to:           CFG.get('HIRING_MANAGER_EMAIL'),
    subject:      subj,
    body:         body,
    candidateId:  candidateId,
    templateKey:  '__manager_booking_alert__',
    reason:       'manager booking alert'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING EVENTS LOG — time-indexed, idempotent by Calendar Event ID.
// Consumed by 08_Otter_Transcripts for booking-time proximity matching of
// in-person recordings that carry no email or candidate ID.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append (idempotently) one Booking Events row for a detected calendar booking.
 * Wrapped in withLock_ so a concurrent Otter poll never reads a half-written row
 * and the dedup-by-Event-ID check is atomic. Safe to call repeatedly: a row with
 * the same Calendar Event ID is written at most once.
 *
 * @param {string} candidateId
 * @param {object} candidate   pipeline row object (First/Last/Full Name, Email, Phone)
 * @param {CalendarEvent} ev
 * @param {string} phase       'PhoneScreen' | 'FullInterview' | 'WorkingInterview'
 */
function _recordBookingEvent_(candidateId, candidate, ev, phase) {
  var eventId = '';
  try { eventId = ev.getId() || ''; } catch (e) { eventId = ''; }

  return withLock_(function () {
    var sh = getOrCreateSheet_(BOOKING_EVENTS_SHEET_NAME, BOOKING_EVENTS_HEADERS);
    ensureHeaders_(sh, BOOKING_EVENTS_HEADERS);

    // Idempotency: skip if this Calendar Event ID is already logged.
    if (eventId) {
      var existing = findRowsByColumnValue_(sh, 'Calendar Event ID', eventId);
      if (existing.length) return existing[0].rowNum;
    }

    candidate = candidate || {};
    var first = candidate['First Name'] || (String(candidate['Full Name'] || '').split(' ')[0]) || '';
    var last  = candidate['Last Name']  || (String(candidate['Full Name'] || '').split(' ').slice(1).join(' ')) || '';
    var name  = (first + ' ' + last).trim() || String(candidate['Full Name'] || '');

    // Map A's internal phase to the B-style Interview Type that the Otter
    // booking-time matcher biases on (Full beats Phone in the same window).
    var interviewType = (phase === 'PhoneScreen')      ? 'PhoneScreen' :
                        (phase === 'WorkingInterview') ? 'WorkingInterview' :
                                                         'FullInterview';

    appendRowByHeader_(sh, {
      'Candidate ID':      candidateId,
      'Full Name':         name,
      'Email':             candidate['Email'] || '',
      'Phone':             candidate['Phone'] || '',
      'Scheduled For':     shopDateTime_(ev.getStartTime()),
      'Interview Type':    interviewType,
      'Calendar Event ID': eventId,
      'Recorded At':       shopDateTime_()
    });
    return sh.getLastRow();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function BOOKING_selfTest() {
  var out = ['[BOOKING] selfTest (read-only)…'];
  var calId = CFG.get('INTERVIEW_CALENDAR_ID');
  out.push('  ─ INTERVIEW_CALENDAR_ID    : ' + (calId ? truncate_(calId, 60) : '(blank)'));
  if (calId) {
    try {
      var cal = CalendarApp.getCalendarById(calId);
      out.push('  ' + (cal ? '✓' : '✗') + ' calendar accessible: ' + (cal ? cal.getName() : 'NOT FOUND'));
    } catch (e) {
      out.push('  ✗ calendar open failed: ' + e.message);
    }
  }
  out.push('  ─ IMMEDIATE_BOOKING_ALERTS : ' + CFG.getBool('IMMEDIATE_BOOKING_ALERTS_ENABLED'));
  out.push('  ─ DEFAULT_PHONE_BOOKING    : ' + CFG.get('DEFAULT_PHONE_BOOKING_LINK'));
  out.push('  ─ DEFAULT_FULL_BOOKING     : ' + CFG.get('DEFAULT_FULL_BOOKING_LINK'));

  // Booking Events log — exercise idempotent record with a synthetic event.
  try {
    var fakeStart = new Date();
    var fakeId = 'SELFTEST-EVT-' + Date.now();
    var fakeEv = {
      getId: function () { return fakeId; },
      getStartTime: function () { return fakeStart; },
      getTitle: function () { return 'SelfTest Full Interview'; }
    };
    var cand = { 'First Name': 'Self', 'Last Name': 'Test', 'Email': 'selftest@example.com', 'Phone': '7025551234' };
    var r1 = _recordBookingEvent_('FES-SELFTEST', cand, fakeEv, 'FullInterview');
    var r2 = _recordBookingEvent_('FES-SELFTEST', cand, fakeEv, 'FullInterview'); // dup
    out.push('  ' + (r1 === r2 ? '✓' : '✗') + ' _recordBookingEvent_ idempotent by Event ID (rows ' + r1 + '/' + r2 + ')');
    var bsh = getSheetOrNull_(BOOKING_EVENTS_SHEET_NAME);
    if (bsh && r1) {
      try { bsh.deleteRow(r1); out.push('  ✓ deleted synthetic Booking Events row'); }
      catch (e) { out.push('  ⚠ could not delete synthetic Booking Events row ' + r1 + ': ' + e.message); }
    }
  } catch (e) {
    out.push('  ✗ Booking Events log test threw: ' + e.message);
  }

  out.push('[BOOKING] selfTest done. Run pollCalendarBookings() to scan calendar.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
