/**
 * 08_Otter_Transcripts.gs
 * Frank's European Service — Recruiting OS
 *
 * Zapier-only Otter transcript intake. Per project rules:
 *   - Otter is the SOLE transcript source.
 *   - Zapier writes each new Otter recording into "Raw Otter Transcript Intake"
 *     with Processed Status = NEW. Apps Script never imports from Gmail/Drive.
 *
 * Flow:
 *   processRawOtterIntake()
 *     for each row with Processed Status = NEW:
 *       1) skip if transcript shorter than TRANSCRIPT_MIN_CHARACTERS_FOR_AI
 *       2) match candidate by email (Organizer + Participants), then by name+date
 *       3) infer interview stage (PhoneScreen / FullInterview / WorkingInterview)
 *       4) write to Master Transcript Archive
 *       5) dispatch AI grading (09_AI_Grading.gs) if AI_GRADING_ENABLED
 *       6) mark the intake row PROCESSED / UNMATCHED / SKIPPED / ERROR
 *
 * Match outcomes (written to Raw Otter Intake → "Match Method" column):
 *   email        → matched on email address in transcript participants/organizer (high confidence)
 *   name+date    → matched on candidate name in meeting title + recent activity (medium)
 *   phone        → matched on candidate phone number appearing in the transcript text
 *   booking+time → matched to the closest "Booking Events" row within
 *                  OTTER_MATCH_WINDOW_HOURS of the recording time. This is the
 *                  anchor for in-person/live recordings that carry no email,
 *                  candidate ID, or phone spoken aloud. Full/in-person bookings
 *                  are biased over phone screens in the same window.
 *   manual       → set by user via manuallyMatchTranscript()
 *   none         → no match found — Routing Outcome = held_for_review
 *
 * Public functions:
 *   processRawOtterIntake()                      — main processor (called by trigger)
 *   manuallyMatchTranscript(otterRowNum, cid)    — repair: force-match a row
 *   reprocessOtterRow(otterRowNum)               — repair: re-run one row
 *   OTTER_selfTest()                             — synthetic test row, asserts matching
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: processRawOtterIntake — scans NEW rows, processes each
// ─────────────────────────────────────────────────────────────────────────────

function processRawOtterIntake() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('processRawOtterIntake', 'OK');
  return withLockOrSkip_('processRawOtterIntake', function () {
    if (!CFG.getBool('OTTER_IMPORT_ENABLED', true)) return '[OTTER] OTTER_IMPORT_ENABLED is FALSE — skipped';
    var sh = getSheet_(SHEETS.RAW_OTTER_INTAKE);
    var last = sh.getLastRow();
    if (last < 2) return '[OTTER] no rows in intake';

    var headers = getHeaderRow_(sh);
    var hStatus = headers.indexOf('Processed Status');
    if (hStatus === -1) throw new Error('processRawOtterIntake: missing "Processed Status" column');

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, processed: 0, unmatched: 0, skipped: 0, errors: 0 };
    var MAX_PER_RUN = 25;

    for (var i = 0; i < data.length && (summary.processed + summary.unmatched + summary.errors) < MAX_PER_RUN; i++) {
      summary.scanned++;
      var status = String(data[i][hStatus] || '').trim().toUpperCase();
      if (status !== 'NEW') continue;

      var rowNum = i + 2;
      try {
        var r = _processOtterRow_(rowNum);
        if (r === 'PROCESSED')      summary.processed++;
        else if (r === 'UNMATCHED') summary.unmatched++;
        else                        summary.skipped++;
      } catch (e) {
        summary.errors++;
        logError_('processRawOtterIntake:row' + rowNum, e, '', 'ERROR');
        _markIntakeRow_(rowNum, 'ERROR', '', MATCH_METHOD.NONE, 0, 'error', truncate_(e.message, 200));
      }
    }

    var msg = '[OTTER] processRawOtterIntake — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('OTTER_INTAKE_RUN', '', summary);
    return msg;
  });
}

/** Force a single row through the matcher + grader (repair / manual run). */
function reprocessOtterRow(otterRowNum) {
  return withLock_(function () {
    return _processOtterRow_(otterRowNum);
  });
}

/** Override the matcher: stamp a candidate onto an intake row + archive + grade. */
function manuallyMatchTranscript(otterRowNum, candidateId) {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_OTTER_INTAKE);
    var rowData = readRowAsObject_(sh, otterRowNum);
    var candidate = _getCandidateRow_(candidateId);
    if (!candidate) throw new Error('manuallyMatchTranscript: candidate not found: ' + candidateId);
    var stage = _inferInterviewStage_(rowData, candidate);
    var archiveRow = _archiveTranscript_(rowData, candidateId, candidate, stage,
      { method: MATCH_METHOD.MANUAL, confidence: 100 });
    if (CFG.getBool('AI_GRADING_ENABLED', true) && typeof gradeTranscript_ === 'function') {
      safeRun_('otter:gradeTranscript', function () { gradeTranscript_(archiveRow); });
    }
    _markIntakeRow_(otterRowNum, 'PROCESSED', candidateId, MATCH_METHOD.MANUAL, 100, 'graded', '');
    logEvent_('TRANSCRIPT_MANUAL_MATCH', candidateId, { otterRow: otterRowNum, archiveRow: archiveRow, stage: stage });
    return 'PROCESSED archiveRow=' + archiveRow;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: process one Raw Otter Intake row
// ─────────────────────────────────────────────────────────────────────────────

function _processOtterRow_(rowNum) {
  var sh = getSheet_(SHEETS.RAW_OTTER_INTAKE);
  var rowData = readRowAsObject_(sh, rowNum);

  var transcript = String(rowData['Transcript Text'] || '');
  var minChars = CFG.getInt('TRANSCRIPT_MIN_CHARACTERS_FOR_AI', 200);
  if (transcript.length < minChars) {
    _markIntakeRow_(rowNum, 'SKIPPED', '', MATCH_METHOD.NONE, 0, 'transcript_too_short',
      'transcript len=' + transcript.length + ' < min ' + minChars);
    // F12: short transcripts were dropped silently. Log the skip as an event so it
    // surfaces in the Event Log and the digest's "Skipped transcripts" section.
    logEvent_('TRANSCRIPT_SKIPPED', '', {
      otterRow: rowNum, reason: 'transcript_too_short',
      length: transcript.length, min: minChars, meetingTitle: rowData['Meeting Title'] || ''
    });
    return 'SKIPPED';
  }

  // Modality: the Raw Otter Intake sheet is the in-person path by default; a row
  // may carry an explicit __modality from the Transcript Sources importer (34).
  // Enforce Otter=in-person / Fathom=online and park any vendor↔modality conflict.
  var cls = _classifyTranscriptModality_(rowData, rowData['__modality'] || CFG.get('OTTER_MODALITY', 'in_person'));
  if (cls.conflict) {
    _markIntakeRow_(rowNum, 'SKIPPED', '', MATCH_METHOD.NONE, 0, 'modality_conflict',
      'vendor=' + cls.vendor + ' conflicts with declared modality — parked, not graded');
    logEvent_('TRANSCRIPT_MODALITY_CONFLICT', '', { otterRow: rowNum, vendor: cls.vendor, modality: cls.modality });
    return 'SKIPPED';
  }

  // Match (modality-gated). Online meetings require a verified candidate identity.
  var match = _matchCandidateToTranscript_(rowData, cls.modality);
  if (!match) {
    if (cls.modality === 'online' && CFG.getBool('ONLINE_REQUIRE_CANDIDATE_MATCH', true)) {
      _markIntakeRow_(rowNum, 'SKIPPED', '', MATCH_METHOD.NONE, 0, 'online_no_candidate_skipped',
        'Online meeting with no candidate identity — skipped, not ingested');
      logEvent_('TRANSCRIPT_ONLINE_SKIPPED', '', {
        otterRow: rowNum, meetingTitle: rowData['Meeting Title'], organizerEmail: rowData['Organizer Email']
      });
      return 'SKIPPED';
    }
    _markIntakeRow_(rowNum, 'UNMATCHED', '', MATCH_METHOD.NONE, 0, 'held_for_review',
      'No candidate match — use manuallyMatchTranscript(' + rowNum + ', "FES-XXX-XXXXXXXX")');
    logEvent_('TRANSCRIPT_UNMATCHED', '', {
      otterRow: rowNum, meetingTitle: rowData['Meeting Title'], organizerEmail: rowData['Organizer Email']
    });
    return 'UNMATCHED';
  }

  var candidate = _getCandidateRow_(match.candidateId);
  if (!candidate) {
    _markIntakeRow_(rowNum, 'ERROR', match.candidateId, match.method, match.confidence, 'error',
      'matched candidateId not found in pipeline/candidates');
    return 'ERROR';
  }

  var stage = _inferInterviewStage_(rowData, candidate, match);
  var archiveRow = _archiveTranscript_(rowData, match.candidateId, candidate, stage, match, cls.modality);

  // Dispatch AI grading
  var outcome = 'archived';
  if (CFG.getBool('AI_GRADING_ENABLED', true) && typeof gradeTranscript_ === 'function') {
    safeRun_('otter:gradeTranscript', function () { gradeTranscript_(archiveRow); });
    outcome = 'graded';
  }

  _markIntakeRow_(rowNum, 'PROCESSED', match.candidateId, match.method, match.confidence, outcome, '');
  logEvent_('TRANSCRIPT_PROCESSED', match.candidateId, {
    otterRow: rowNum, archiveRow: archiveRow, stage: stage,
    matchMethod: match.method, confidence: match.confidence
  });
  return 'PROCESSED';
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCHING
// ─────────────────────────────────────────────────────────────────────────────

// Match-method labels not present in the MATCH_METHOD enum. Kept as literals at
// the same altitude as the enum entries they extend.
var OTTER_MATCH_METHOD_PHONE    = 'phone';
var OTTER_MATCH_METHOD_BOOKING  = 'booking+time';
var OTTER_MATCH_METHOD_CALENDAR = 'calendar+email';

// Display name of the time-indexed booking log written by 07_Booking.gs.
// Kept in sync with BOOKING_EVENTS_SHEET_NAME there.
var OTTER_BOOKING_EVENTS_SHEET_NAME = 'Booking Events';

// ─────────────────────────────────────────────────────────────────────────────
// MODALITY: Otter = in-person interviews ONLY; Fathom = online meetings ONLY.
// Online meetings are identity-gated so unrelated calls are never ingested.
// ─────────────────────────────────────────────────────────────────────────────

/** Detect the note-taker vendor ('otter' | 'fathom' | '') from a transcript row. */
function _vendorFromRow_(rowData) {
  var hay = [rowData['Source App'], rowData['Organizer Email'], rowData['Participants'],
             rowData['Transcript URL'], rowData['Audio URL'], rowData['__sourceQuery']]
            .map(function (s) { return String(s || '').toLowerCase(); }).join(' ');
  function any(csv, dflt) {
    return String(CFG.get(csv, dflt) || dflt).toLowerCase().split(/\s*,\s*/).filter(Boolean);
  }
  var fathom = any('FATHOM_SENDER_DOMAINS', 'fathom.video');
  var otter  = any('OTTER_SENDER_DOMAINS',  'otter.ai');
  for (var i = 0; i < fathom.length; i++) if (hay.indexOf(fathom[i]) !== -1) return 'fathom';
  for (var j = 0; j < otter.length;  j++) if (hay.indexOf(otter[j])  !== -1) return 'otter';
  if (hay.indexOf('fathom') !== -1) return 'fathom';
  if (hay.indexOf('otter')  !== -1) return 'otter';
  return '';
}

/**
 * Resolve modality ('in_person' | 'online') for a row and cross-check it against
 * the detected vendor. Otter→in_person, Fathom→online. Returns
 * { modality, vendor, conflict }. conflict=true when ENFORCE_TRANSCRIPT_MODALITY
 * and the source's declared modality contradicts the vendor (e.g. an Otter item
 * arriving on the online/Fathom source) — caller parks it instead of grading.
 */
function _classifyTranscriptModality_(rowData, declaredModality) {
  var vendor = _vendorFromRow_(rowData);
  var vendorModality = vendor === 'fathom' ? 'online'
                     : vendor === 'otter'  ? 'in_person' : '';
  var declared = String(declaredModality || '').trim().toLowerCase();
  if (declared !== 'online' && declared !== 'in_person') declared = '';
  var modality = declared || vendorModality || CFG.get('OTTER_MODALITY', 'in_person');
  var conflict = CFG.getBool('ENFORCE_TRANSCRIPT_MODALITY', true) &&
                 !!vendorModality && !!declared && vendorModality !== declared;
  return { modality: modality, vendor: vendor, conflict: conflict };
}

/**
 * ONLINE-only matcher: a booking within OTTER_MATCH_WINDOW_HOURS whose candidate
 * email also appears among the meeting's attendees. Time alone is NOT enough —
 * there must be an email/identity intersection, so an unrelated online meeting
 * near an interview slot can never attach to a candidate. Returns a match object
 * (carries the booked interviewType) or null.
 */
function _matchOnlineByCalendarIdentity_(rowData) {
  var booking = _matchOtterByBookingTime_(_otterRowDate_(rowData));
  if (!booking || !booking.candidateId) return null;
  var cand = _getCandidateRow_(booking.candidateId);
  if (!cand) return null;
  var candEmail = normalizeEmail_(cand['Email'] || '');
  if (!candEmail) return null;
  var meetingEmails = _extractEmailsFromIntake_(rowData).map(function (e) { return e.toLowerCase(); });
  if (meetingEmails.indexOf(candEmail.toLowerCase()) === -1) return null;
  return {
    candidateId:   booking.candidateId,
    method:        OTTER_MATCH_METHOD_CALENDAR,
    confidence:    92,
    interviewType: booking.interviewType || null
  };
}

/**
 * Match a transcript row to a candidate. Behavior is modality-gated:
 *   in_person (Otter): email → name-in-title → phone → booking-time. Live
 *     in-person recordings often carry no email, so the heuristics are essential.
 *   online (Fathom): identity ONLY — calendar-corroborated identity, then a plain
 *     attendee-email match. No name/phone/bare-time guessing, so unrelated online
 *     meetings are parked rather than ingested.
 */
function _matchCandidateToTranscript_(rowData, modality) {
  modality = (modality === 'online') ? 'online' : 'in_person';
  var emails = _extractEmailsFromIntake_(rowData);

  if (modality === 'online') {
    var ident = _matchOnlineByCalendarIdentity_(rowData);
    if (ident) return ident;
    for (var k = 0; k < emails.length; k++) {
      var cidO = _findCandidateByEmail_(emails[k]);
      if (cidO) return { candidateId: cidO, method: MATCH_METHOD.EMAIL, confidence: 95 };
    }
    return null; // no verified identity → do not ingest this online meeting
  }

  // in_person (Otter)
  for (var i = 0; i < emails.length; i++) {
    var cid = _findCandidateByEmail_(emails[i]);
    if (cid) return { candidateId: cid, method: MATCH_METHOD.EMAIL, confidence: 95 };
  }
  var nameHit = _findCandidateByNameInTitle_(String(rowData['Meeting Title'] || ''));
  if (nameHit) return { candidateId: nameHit, method: MATCH_METHOD.NAME_DATE, confidence: 70 };
  var phoneHit = _findCandidateByPhoneInTranscript_(rowData);
  if (phoneHit) return { candidateId: phoneHit, method: OTTER_MATCH_METHOD_PHONE, confidence: 80 };
  var bookingHit = _matchOtterByBookingTime_(_otterRowDate_(rowData));
  if (bookingHit) {
    return {
      candidateId:   bookingHit.candidateId,
      method:        OTTER_MATCH_METHOD_BOOKING,
      confidence:    bookingHit.confidence,
      interviewType: bookingHit.interviewType || null
    };
  }
  return null;
}

/**
 * Resolve a recording's datetime from the intake row. Prefers "Meeting Date";
 * falls back to the Zapier "Timestamp"; then now. Adapted from B's _otterRowDate_.
 */
function _otterRowDate_(rowData) {
  var raw = rowData['Meeting Date'] || rowData['Timestamp'];
  if (raw instanceof Date) return raw;
  if (raw) {
    var d = new Date(String(raw));
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Scan All Candidates then Interview Pipeline for a candidate whose normalized
 * phone (>= 10 digits) appears in the transcript text / participants / title.
 * Returns a Candidate ID or ''. Bias newest-first like the email scanner.
 */
function _findCandidateByPhoneInTranscript_(rowData) {
  var hayDigits = normalizePhone_(
    [rowData['Transcript Text'], rowData['Participants'], rowData['Meeting Title']]
      .map(function (s) { return String(s || ''); }).join(' ')
  );
  if (hayDigits.length < 10) return '';

  function scan(sheetName) {
    var sh = getSheetOrNull_(sheetName);
    if (!sh) return '';
    var last = sh.getLastRow();
    if (last < 2) return '';
    var headers = getHeaderRow_(sh);
    var pc = headers.indexOf('Phone');
    var cc = headers.indexOf('Candidate ID');
    if (pc === -1 || cc === -1) return '';
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {            // newest first
      var ph = normalizePhone_(data[i][pc]);
      if (ph.length >= 10 && hayDigits.indexOf(ph) !== -1) {
        var cid = String(data[i][cc] || '').trim();
        if (cid) return cid;
      }
    }
    return '';
  }

  return scan(SHEETS.ALL_CANDIDATES) || scan(SHEETS.INTERVIEW_PIPELINE);
}

/**
 * Find the "Booking Events" row whose "Scheduled For" is closest to the
 * recording time and within OTTER_MATCH_WINDOW_HOURS. Full/in-person bookings
 * are biased over phone screens so a same-day phone screen cannot steal an
 * in-person recording. Adapted from B's _matchOtterByBookingTime_.
 *
 * Returns { candidateId, fullName, interviewType, confidence } or null.
 */
function _matchOtterByBookingTime_(meetingDate) {
  if (!meetingDate) return null;
  var target = new Date(meetingDate).getTime();
  if (isNaN(target)) return null;

  var sh = getSheetOrNull_(OTTER_BOOKING_EVENTS_SHEET_NAME);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;

  var windowHours = CFG.getFloat('OTTER_MATCH_WINDOW_HOURS', 4);
  if (!windowHours || windowHours <= 0) windowHours = 4;
  var windowMs = windowHours * 3600000;

  var headers = getHeaderRow_(sh);
  var iCid   = headers.indexOf('Candidate ID');
  var iName  = headers.indexOf('Full Name');
  var iSched = headers.indexOf('Scheduled For');
  var iType  = headers.indexOf('Interview Type');
  if (iCid === -1 || iSched === -1) return null;

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var best = null, bestScore = Infinity;
  for (var i = 0; i < data.length; i++) {
    var cid = String(data[i][iCid] || '').trim();
    var sched = data[i][iSched];
    if (!cid || !sched) continue;
    var t = (sched instanceof Date) ? sched.getTime() : new Date(String(sched)).getTime();
    if (isNaN(t)) continue;
    var diff = Math.abs(t - target);
    if (diff > windowMs) continue;
    // Bias toward Full/in-person bookings: subtract a full window so any
    // in-person booking in range beats any phone screen; ties broken by closeness.
    var type = iType === -1 ? '' : String(data[i][iType] || '');
    var isFull = (type === 'FullInterview' || type === 'WorkingInterview');
    var score = diff - (isFull ? windowMs : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { candidateId: cid, fullName: iName === -1 ? '' : String(data[i][iName] || ''), interviewType: type };
    }
  }

  if (!best) return null;
  // Confidence scales with how close the recording is to the booked time.
  best.confidence = best.interviewType && (best.interviewType === 'FullInterview' || best.interviewType === 'WorkingInterview') ? 75 : 65;
  return best;
}

/** Pull every plausible candidate email from Organizer + Participants fields. */
function _extractEmailsFromIntake_(rowData) {
  var out = [];
  var seen = {};
  function add(s) {
    var n = normalizeEmail_(s);
    if (!n) return;
    if (n.indexOf('@frankseuropeanservice.com') !== -1) return; // skip shop staff
    if (n.indexOf('@otter.ai') !== -1) return;                  // skip bot/notetaker
    if (seen[n]) return;
    seen[n] = true;
    out.push(n);
  }
  add(rowData['Organizer Email']);
  var p = String(rowData['Participants'] || '');
  var found = p.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  found.forEach(add);
  return out;
}

/** Search All Candidates then Interview Pipeline by email. Returns Candidate ID or ''. */
function _findCandidateByEmail_(email) {
  var target = normalizeEmail_(email);
  if (!target) return '';

  function scan(sheetName) {
    var sh = getSheetOrNull_(sheetName);
    if (!sh) return '';
    var last = sh.getLastRow();
    if (last < 2) return '';
    var headers = getHeaderRow_(sh);
    var ec  = headers.indexOf('Email');
    var cc  = headers.indexOf('Candidate ID');
    if (ec === -1 || cc === -1) return '';
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {            // newest first
      if (normalizeEmail_(data[i][ec]) === target) {
        var cid = String(data[i][cc] || '').trim();
        if (cid) return cid;
      }
    }
    return '';
  }

  return scan(SHEETS.ALL_CANDIDATES) || scan(SHEETS.INTERVIEW_PIPELINE);
}

/**
 * Best-effort name match: if Meeting Title contains a candidate's
 * "first last" (case-insensitive), return that Candidate ID. Bias newest first.
 */
function _findCandidateByNameInTitle_(meetingTitle) {
  var title = String(meetingTitle || '').toLowerCase();
  if (!title) return '';
  var sh = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!sh) return '';
  var last = sh.getLastRow();
  if (last < 2) return '';
  var headers = getHeaderRow_(sh);
  var iF  = headers.indexOf('First Name');
  var iL  = headers.indexOf('Last Name');
  var iC  = headers.indexOf('Candidate ID');
  if (iF === -1 || iL === -1 || iC === -1) return '';
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    var f = String(data[i][iF] || '').toLowerCase().trim();
    var l = String(data[i][iL] || '').toLowerCase().trim();
    if (!f || !l) continue;
    var full = f + ' ' + l;
    if (title.indexOf(full) !== -1) return String(data[i][iC] || '');
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE INFERENCE
// ─────────────────────────────────────────────────────────────────────────────

function _inferInterviewStage_(rowData, candidate, match) {
  // A booking-time match carries the booked interview type — the strongest
  // signal available for an in-person recording, since the title is unreliable.
  if (match && match.interviewType) {
    var it = String(match.interviewType);
    if (it === 'PhoneScreen' || it === 'FullInterview' || it === 'WorkingInterview') return it;
  }

  var title = String(rowData['Meeting Title'] || '').toLowerCase();
  if (title.indexOf('phone screen') !== -1 || title.indexOf('phonescreen') !== -1) return 'PhoneScreen';
  if (title.indexOf('working interview') !== -1)                                   return 'WorkingInterview';
  if (title.indexOf('full interview') !== -1 || title.indexOf('in-person') !== -1 ||
      title.indexOf('in person') !== -1)                                           return 'FullInterview';

  if (candidate) {
    var s = String(candidate['Status'] || '');
    if (s === STATUS.PHONE_BOOKED || s === STATUS.PHONE_DONE) return 'PhoneScreen';
    if (s === STATUS.FULL_BOOKED  || s === STATUS.FULL_DONE)  return 'FullInterview';
    if (s === STATUS.WORKING_SCHEDULED)                       return 'WorkingInterview';
  }
  return 'FullInterview';
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHIVE WRITER
// ─────────────────────────────────────────────────────────────────────────────

function _archiveTranscript_(rowData, candidateId, candidate, stage, match, modality) {
  var sh = getSheet_(SHEETS.TRANSCRIPT_ARCHIVE);
  if (!modality) modality = _classifyTranscriptModality_(rowData, rowData['__modality']).modality;
  var first = candidate['First Name'] || (String(candidate['Full Name'] || '').split(' ')[0]) || '';
  var last  = candidate['Last Name']  || (String(candidate['Full Name'] || '').split(' ').slice(1).join(' ')) || '';
  var name  = (first + ' ' + last).trim() || (candidate['Full Name'] || '');

  appendRowByHeader_(sh, {
    'Archive ID':       'TX-' + Utilities.getUuid().substring(0, 8).toUpperCase(),
    'Archived At':      shopDateTime_(),
    'Otter Source ID':  rowData['Otter Source ID'] || '',
    'Candidate ID':     candidateId,
    'Candidate Name':   name,
    'Role':             candidate['Role'] || '',
    'Hiring Manager':   candidate['Hiring Manager'] || CFG.get('HIRING_MANAGER_NAME'),
    'Phase':            stage,
    'Meeting Title':    rowData['Meeting Title'] || '',
    'Meeting Date':     rowData['Meeting Date'] || '',
    'Transcript URL':   rowData['Transcript URL'] || '',
    'Audio URL':        rowData['Audio URL'] || '',
    'Transcript Text':  rowData['Transcript Text'] || '',
    'Participants':     rowData['Participants'] || '',
    'Organizer Email':  rowData['Organizer Email'] || '',
    'Source App':       rowData['Source App'] || 'Otter',
    'Match Method':     match.method,
    'Match Confidence': match.confidence,
    'Modality':         modality === 'online' ? 'online' : 'in_person',
    'Notes':            ''
  });
  return sh.getLastRow();
}

function _markIntakeRow_(rowNum, processedStatus, candidateId, matchMethod, confidence, outcome, error) {
  var sh = getSheet_(SHEETS.RAW_OTTER_INTAKE);
  batchUpdateRow_(sh, rowNum, {
    'Processed Status':       processedStatus,
    'Processed At':           shopDateTime_(),
    'Candidate ID':           candidateId || '',
    'Candidate Match Status': candidateId ? 'MATCHED' : 'UNMATCHED',
    'Match Method':           matchMethod || MATCH_METHOD.NONE,
    'Match Confidence':       confidence || 0,
    'Routing Outcome':        outcome || '',
    'Error':                  error || ''
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// Synthetic intake row with a fake email → expects UNMATCHED, marks row cleanly,
// then deletes the row. No real candidate touched, no AI call.
// ─────────────────────────────────────────────────────────────────────────────
function OTTER_selfTest() {
  var out = ['[OTTER] selfTest starting (no AI call)…'];
  var sh = getSheetOrNull_(SHEETS.RAW_OTTER_INTAKE);
  if (!sh) { out.push('  ✗ Raw Otter Transcript Intake tab missing — run bootstrapSystem()'); Logger.log(out.join('\n')); return out.join('\n'); }

  // Disable AI grading for this run to avoid Gemini call
  var gradeBefore = CFG.get('AI_GRADING_ENABLED');
  CFG.set('AI_GRADING_ENABLED', 'FALSE');

  var srcId = 'SELFTEST-' + Date.now();
  appendRowByHeader_(sh, {
    'Timestamp':         shopDateTime_(),
    'Zap Run ID':        'SELFTEST_RUN',
    'Otter Source ID':   srcId,
    'Meeting Title':     'SelfTest fake interview',
    'Meeting Date':      shopDate_(),
    'Transcript Text':   'This is a synthetic transcript long enough to clear the minimum character threshold for the AI grading gate. ' +
                         'It does not reference any real candidate by email or by name. The matcher should return UNMATCHED.',
    'Transcript URL':    'https://otter.ai/selftest',
    'Audio URL':         '',
    'Participants':      'Travis Burd <travis.burd@frankseuropeanservice.com>, SelfTest Bot <bot@otter.ai>',
    'Organizer Email':   'travis.burd@frankseuropeanservice.com',
    'Calendar Event ID': '',
    'Source App':        'Otter',
    'Raw Payload':       '{}',
    'Processed Status':  'NEW'
  });
  var newRow = sh.getLastRow();
  out.push('  ✓ synthetic intake row appended at row ' + newRow + ' (sourceId=' + srcId + ')');

  // Process
  var result;
  try { result = _processOtterRow_(newRow); }
  catch (e) { out.push('  ✗ _processOtterRow_ threw: ' + e.message); }
  out.push('  ' + (result === 'UNMATCHED' ? '✓' : '✗') + ' expected UNMATCHED (got ' + result + ')');

  // Verify intake row was marked
  var marked = readRowAsObject_(sh, newRow);
  out.push('  ─ row after: Processed Status=' + marked['Processed Status'] +
           '  Match Method=' + marked['Match Method'] +
           '  Routing Outcome=' + marked['Routing Outcome']);

  // Booking-time proximity matcher — synthetic Booking Events row, no candidate
  // data touched. Asserts the Full booking is preferred and within the window.
  try {
    var bsh = getOrCreateSheet_(BOOKING_EVENTS_SHEET_NAME, BOOKING_EVENTS_HEADERS);
    ensureHeaders_(bsh, BOOKING_EVENTS_HEADERS);
    var when = new Date();
    var phoneRow = appendRowByHeader_(bsh, {
      'Candidate ID': 'FES-SELFTEST-PHONE', 'Full Name': 'SelfTest Phone',
      'Scheduled For': shopDateTime_(new Date(when.getTime() + 10 * 60000)), // 10 min off
      'Interview Type': 'PhoneScreen', 'Calendar Event ID': 'ST-PH-' + Date.now(),
      'Recorded At': shopDateTime_()
    });
    var fullRow = appendRowByHeader_(bsh, {
      'Candidate ID': 'FES-SELFTEST-FULL', 'Full Name': 'SelfTest Full',
      'Scheduled For': shopDateTime_(new Date(when.getTime() + 30 * 60000)), // 30 min off
      'Interview Type': 'FullInterview', 'Calendar Event ID': 'ST-FL-' + Date.now(),
      'Recorded At': shopDateTime_()
    });
    var bm = _matchOtterByBookingTime_(when);
    var fullWins = bm && bm.candidateId === 'FES-SELFTEST-FULL';
    out.push('  ' + (fullWins ? '✓' : '✗') + ' _matchOtterByBookingTime_ biased to Full booking (got ' +
             (bm ? bm.candidateId + '/' + bm.interviewType : 'null') + ')');
    try { bsh.deleteRow(fullRow); bsh.deleteRow(phoneRow); out.push('  ✓ deleted synthetic Booking Events rows'); }
    catch (e) { out.push('  ⚠ could not delete synthetic Booking Events rows: ' + e.message); }
  } catch (e) {
    out.push('  ✗ booking-time matcher test threw: ' + e.message);
  }

  // Cleanup
  try { sh.deleteRow(newRow); out.push('  ✓ deleted synthetic intake row'); }
  catch (e) { out.push('  ⚠ could not delete row ' + newRow + ': ' + e.message); }

  CFG.set('AI_GRADING_ENABLED', gradeBefore);
  out.push('  ─ AI_GRADING_ENABLED restored to ' + gradeBefore);
  out.push('[OTTER] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
