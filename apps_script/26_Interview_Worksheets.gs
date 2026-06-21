/**
 * 26_Interview_Worksheets.gs
 * Frank's European Service — Recruiting OS
 *
 * Generates a tailored interview worksheet for each candidate with an interview
 * scheduled today and emails it to the hiring manager before the interview.
 *
 * Data sources:
 *   Google Calendar          — primary: scan INTERVIEW_CALENDAR_ID for today's events
 *   Interview Pipeline       — date columns (secondary; kept after pollCalendarBookings sync)
 *   All Candidates           — AI Score / Risk fallback
 *   Master Transcript Archive — latest Summary / Strengths / Concerns
 *   Raw Pre-Screen Responses — actual Q&A answers shown verbatim in worksheet
 *   AI Prompts (interview_prep) — Gemini generates tailored questions from pre-screen text
 *
 * Daily flow (runWorksheetDigest, fired ~7 AM):
 *   1. pollCalendarBookings()         — sync calendar → pipeline date columns
 *   2. generateWorksheetsForToday()   — scan both calendar and pipeline; call Gemini for each
 *   3. sendTodayInterviewWorksheets() — email HTML worksheet to hiring manager
 *
 * Public functions:
 *   generateInterviewWorksheet_(candidateId, interviewType, interviewDate)
 *   generateWorksheetsForToday()
 *   sendTodayInterviewWorksheets()
 *   runWorksheetDigest()         — daily entrypoint (generate + send)
 *   installInterviewPrepPrompt() — upsert interview_prep AI prompt (run once after deploy)
 *   runWorksheetDigest()                    — daily 1-call entrypoint (generate + send)
 *   generateAndSendUpcomingWorksheets()     — on-demand: today + next WORKSHEET_LOOKAHEAD_DAYS days
 *   sendUpcomingInterviewWorksheets(force)  — send all DRAFT worksheets in the lookahead window
 *   WORKSHEET_selfTest()
 */

var WORKSHEET_INTERVIEW_DATE_COLUMNS = [
  { column: 'Phone Screen Booked',    type: 'Phone Screen (online)'        },
  { column: 'Full Interview Booked',  type: 'Live Interview (in-person)'   },
  { column: 'Working Interview Date', type: 'Working Interview (in-person)' }
];

// ─────────────────────────────────────────────────────────────────────────────
// DAILY ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate today's worksheets then email them. Bound to WORKSHEET_EMAIL_HOUR.
 * Calls pollCalendarBookings() first so pipeline date columns are current.
 */
function runWorksheetDigest() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('runWorksheetDigest', 'OK');
  return safeRun_('runWorksheetDigest', function () {
    if (!CFG.getBool('INTERVIEW_WORKSHEETS_ENABLED', true)) return '[WORKSHEET] disabled';
    try { pollCalendarBookings(); } catch (e) { logError_('runWorksheetDigest:poll', e, '', 'WARN'); }
    var gen  = generateWorksheetsForToday();
    var sent = sendTodayInterviewWorksheets();
    var msg  = '[WORKSHEET] runWorksheetDigest — ' + gen + ' | ' + sent;
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

function generateWorksheetsForToday() {
  return withLockOrSkip_('generateWorksheetsForToday', function () {
    var today   = _ymd_(new Date());
    var summary = { scanned: 0, generated: 0 };

    // ── Primary path: scan pipeline date columns (populated by pollCalendarBookings) ──
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (ip) {
      var last    = ip.getLastRow();
      var headers = getHeaderRow_(ip);
      var hCid    = headers.indexOf('Candidate ID');
      if (hCid !== -1 && last >= 2) {
        var rows = ip.getRange(2, 1, last - 1, headers.length).getValues();
        for (var i = 0; i < rows.length; i++) {
          summary.scanned++;
          var cid = String(rows[i][hCid] || '').trim();
          if (!cid) continue;
          WORKSHEET_INTERVIEW_DATE_COLUMNS.forEach(function (def) {
            var col = headers.indexOf(def.column);
            if (col === -1) return;
            var v = rows[i][col];
            if (!v) return;
            if (_ymd_(v) !== today) return;
            var ws = generateInterviewWorksheet_(cid, def.type, v);
            if (ws) summary.generated++;
          });
        }
      }
    }

    // ── Secondary path: direct calendar scan — catches events not yet in pipeline ──
    var calId = CFG.get('INTERVIEW_CALENDAR_ID');
    if (calId) {
      try {
        var cal = CalendarApp.getCalendarById(calId);
        if (cal) {
          var scanStart = new Date(); scanStart.setHours(0, 0, 0, 0);
          var scanEnd   = new Date(scanStart.getTime() + 48 * 60 * 60 * 1000);
          var calEvents = cal.getEvents(scanStart, scanEnd);
          var wsSh      = getSheet_(SHEETS.INTERVIEW_WORKSHEETS);
          calEvents.forEach(function (ev) {
            try {
              var evTitle = ev.getTitle() || '';
              var prefix  = CFG.get('INTERVIEW_BLOCK_EVENT_PREFIX', '[Recruiting Available]');
              if (evTitle.indexOf(prefix) === 0) return;
              if (_ymd_(ev.getStartTime()) !== today) return;

              var iType = _guessTypeFromTitle_(evTitle);
              // Match by email (guests OR description) then title name — handles
              // Koalendar bookings whose candidate email lives in the body.
              var calCid = _findCandidateForEvent_(ev);

              if (!calCid) return;
              // Skip if any worksheet already exists for this candidate on this
              // date (the pipeline scan above may have already made one).
              if (!_worksheetExistsForDate_(wsSh, calCid, today)) {
                var ws = generateInterviewWorksheet_(calCid, iType, ev.getStartTime());
                if (ws) summary.generated++;
              }
            } catch (e2) { logError_('generateWorksheetsForToday:calEvent', e2, '', 'WARN'); }
          });
        }
      } catch (calE) { logError_('generateWorksheetsForToday:calendar', calE, '', 'WARN'); }
    }

    var msg = 'generated ' + summary.generated + ' worksheet(s) for ' + today +
              ' (pipeline rows scanned: ' + summary.scanned + ')';
    Logger.log('[WORKSHEET] ' + msg);
    return msg;
  }, 30000, 'user');
}

/**
 * Build (or refresh) one worksheet for a candidate. Idempotent per
 * Candidate ID + Interview Date + Interview Type. Returns the worksheet
 * object, or null if no candidate record found.
 */
function generateInterviewWorksheet_(candidateId, interviewType, interviewDate) {
  if (!candidateId) return null;
  var ip   = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var cand = ip ? (findRowsByColumnValue_(ip, 'Candidate ID', candidateId)[0] || {}).data : null;
  if (!cand) {
    var acHit = (findRowsByColumnValue_(getSheet_(SHEETS.ALL_CANDIDATES), 'Candidate ID', candidateId)[0] || {}).data;
    cand = acHit || null;
  }
  if (!cand) {
    logError_('generateInterviewWorksheet_', 'candidate not found: ' + candidateId, candidateId, 'WARN');
    return null;
  }

  var tx      = _latestTranscriptForCandidate_(candidateId) || {};
  var name    = String(cand['Full Name'] || ((cand['First Name'] || '') + ' ' + (cand['Last Name'] || ''))).trim();
  var role    = cand['Role'] || '';
  var manager = cand['Hiring Manager'] || CFG.get('HIRING_MANAGER_NAME');

  // Latest role-based AI assessment (35_Assessments.gs), if any. Enriches the
  // brief with assessment scores, AI-suggested probe questions, and concerns.
  var assess = (typeof getLatestAssessmentResult_ === 'function')
    ? getLatestAssessmentResult_(candidateId) : null;
  var assessQuestions = assess ? _splitlist_(assess['Suggested Interview Questions']) : [];

  // Merge transcript + assessment strengths/concerns (de-duplicated, transcript first).
  var strengths      = _splitlist_(tx['Strengths']).concat(assess ? _splitlist_(assess['Strengths']) : []);
  var concerns       = _splitlist_(tx['Concerns']).concat(assess ? _splitlist_(assess['Concerns']) : []);
  strengths = strengths.filter(function (v, i) { return v && strengths.indexOf(v) === i; });
  concerns  = concerns.filter(function (v, i) { return v && concerns.indexOf(v) === i; });
  var aiSummaryText  = String((assess && assess['Summary For Worksheet']) || tx['Summary'] || cand['Notes'] || '');
  var risk           = Number(cand['Risk Score'] || 0);

  // Pre-screen raw answers (verbatim Q&A for interviewer reference)
  var preScreenAnswers = _loadPreScreenAnswers_(cand['Email'] || '');

  // AI-tailored content (Gemini call using actual pre-screen text)
  var aiContent = _generateAiWorksheetContent_(candidateId, role, cand, tx, preScreenAnswers);

  var aiAuthored = _aiAuthoredFor_(candidateId);
  var redFlags = _deriveRedFlags_(risk, concerns, tx, aiAuthored);
  var greenFlags = strengths.slice(0, 3);
  var questions = _deriveQuestions_(concerns, role);
  var clarifications = _deriveClarifications_(tx, cand, aiAuthored);
  var focus = _deriveFocus_(role, risk, concerns);

  // Questions: prefer AI-tailored questions; fall back to concern-derived ones.
  // Probe points are AI-only. Both render as newline-separated strings.
  // Assessment-suggested probes lead, then AI-tailored (or concern-derived) ones.
  var baseQuestions = (aiContent.tailored_questions && aiContent.tailored_questions.length)
    ? aiContent.tailored_questions
    : questions;
  var suggestedQuestions = assessQuestions.concat(baseQuestions)
    .filter(function (v, i, a) { return v && a.indexOf(v) === i; })
    .join('\n');
  var probePoints = (aiContent.probe_points || []).join('\n');

  var worksheet = {
    'Timestamp':                  shopDateTime_(),
    'Candidate ID':               candidateId,
    'Candidate Name':             name,
    'Role':                       role,
    'Hiring Manager':             manager,
    'Interview Type':             interviewType || '',
    'Interview Date':             interviewDate ? shopDate_(_coerceDate_(interviewDate)) : shopDate_(),
    'Scheduled Time':             _timeOf_(interviewDate),
    'Candidate Status':           cand['Status'] || '',
    'Pre-Screen Score':           cand['Pre-Screen Score'] || cand['Total Score'] || '',
    'AI Pre-Screen Score':        cand['AI Score'] || cand['Pre-Screen Score'] || '',
    'Risk Score':                 cand['Risk Score'] || '',
    'Transcript Score':           tx['AI Score'] || cand['Phone Score'] || cand['Full Score'] || '',
    'Skills Test Score':          cand['Skills Test Score'] || '',
    'Reference Score':            cand['Reference Score'] || cand['Reference Average'] || '',
    'Culture Fit Score':          cand['Culture Score'] || (assess && assess['Culture Fit Score']) || '',
    'Top Strengths':              greenFlags.join(' | '),
    'Top Concerns':               concerns.slice(0, 3).join(' | '),
    'Red Flags To Verify':        redFlags.join(' | '),
    'Green Flags To Confirm':     greenFlags.join(' | '),
    'Suggested Questions':        suggestedQuestions,
    'Probe Points':               probePoints,
    'Clarification Items':        clarifications.join('\n'),
    'Recommended Interview Focus': focus,
    'AI Summary':                 truncate_(aiSummaryText, 1500),
    'Opening Notes':              aiContent.opening_notes || '',
    'Worksheet Body':             '',   // filled below
    'Email Status':               'DRAFT',
    'Email Sent At':              '',
    'Notes':                      ''
  };

  // Render HTML — pass pre-screen answers separately (not stored as a sheet column)
  worksheet['Worksheet Body'] = _renderWorksheetHtml_(worksheet, cand, preScreenAnswers, aiContent.ai_ok);

  // Upsert by Candidate ID + Interview Date + Interview Type
  var sh          = getSheet_(SHEETS.INTERVIEW_WORKSHEETS);
  var existingRow = _findWorksheetRow_(sh, candidateId, worksheet['Interview Date'], worksheet['Interview Type']);
  if (existingRow) {
    var prior = readRowAsObject_(sh, existingRow);
    if (String(prior['Email Status']) === 'SENT') {
      worksheet['Email Status']  = 'SENT';
      worksheet['Email Sent At'] = prior['Email Sent At'];
    }
    batchUpdateRow_(sh, existingRow, worksheet);
  } else {
    appendRowByHeader_(sh, worksheet);
  }

  logEvent_('WORKSHEET_GENERATED', candidateId, {
    type:   worksheet['Interview Type'],
    date:   worksheet['Interview Date'],
    ai_ok:  aiContent.ai_ok
  });
  return worksheet;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────────────────────────

function sendTodayInterviewWorksheets(force) {
  return withLockOrSkip_('sendTodayInterviewWorksheets', function () {
    var sh = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
    if (!sh) return 'Interview Worksheets sheet missing';
    var last = sh.getLastRow();
    if (last < 2) return 'no worksheets';
    var headers = getHeaderRow_(sh);
    var data    = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var today   = _ymd_(new Date());
    var idx     = {};
    headers.forEach(function (h, i) { idx[h] = i; });
    var summary = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var r = data[i];
      if (_ymd_(r[idx['Interview Date']]) !== today) { summary.skipped++; continue; }
      if (!force && String(r[idx['Email Status']]) === 'SENT') { summary.skipped++; continue; }

      var managerEmail = _hiringManagerEmail_(r[idx['Hiring Manager']]);
      var toActual     = actualRecipient_(managerEmail);
      if (!toActual) {
        summary.skipped++;
        _setWorksheetSendState_(sh, i + 2, 'BLOCKED', 'SEND_ENABLED off or no recipient');
        continue;
      }

      var subject = '[Recruiting OS] Interview Worksheet — ' + r[idx['Candidate Name']] +
                    ' — ' + r[idx['Role']] + ' — ' + r[idx['Interview Type']];
      var html = String(r[idx['Worksheet Body']] || _renderWorksheetHtml_(_rowObj_(headers, r), {}, '', false));
      try {
        GmailApp.sendEmail(toActual, subject, _htmlToPlainSafe_(html), {
          htmlBody:  html,
          name:      CFG.get('EMAIL_FROM_NAME', "Frank's Recruiting Team"),
          replyTo:   CFG.get('DEFAULT_REPLY_TO_EMAIL', '')
        });
        _setWorksheetSendState_(sh, i + 2, 'SENT', isTestMode_() ? 'TEST → ' + toActual : 'LIVE → ' + toActual);
        summary.sent++;
        logEvent_('WORKSHEET_EMAILED', String(r[idx['Candidate ID']]), {
          to: toActual, mode: isTestMode_() ? 'TEST' : 'LIVE'
        });
      } catch (e) {
        summary.failed++;
        _setWorksheetSendState_(sh, i + 2, 'FAILED', e.message);
        logError_('sendTodayInterviewWorksheets', e, String(r[idx['Candidate ID']]), 'ERROR');
      }
    }

    var msg = 'sent ' + summary.sent + ', skipped ' + summary.skipped + ', failed ' + summary.failed +
              ' (mode=' + (isTestMode_() ? 'TEST' : 'LIVE') + ')';
    Logger.log('[WORKSHEET] ' + msg);
    toast_('Worksheets: ' + msg, 'Recruiting OS', 8);
    return msg;
  }, 30000, 'user');
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CONTENT GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call Gemini with the interview_prep prompt and this candidate's actual
 * pre-screen answers to produce tailored interview questions, probe points,
 * a prep brief, and opening notes.
 *
 * Returns a safe object regardless of whether AI succeeds.
 */
function _generateAiWorksheetContent_(candidateId, role, cand, tx, preScreenAnswers) {
  var empty = { tailored_questions: [], probe_points: [], prep_brief: '', opening_notes: '', ai_ok: false };
  try {
    if (!preScreenAnswers) return empty;

    var prompt = _loadAiPrompt_('interview_prep');
    if (!prompt || !prompt['Prompt Body']) {
      logError_('_generateAiWorksheetContent_', 'interview_prep prompt not found — run installInterviewPrepPrompt()', candidateId, 'WARN');
      return empty;
    }

    var aiSummary = String(tx['Summary'] || cand['Notes'] || 'Not available');
    var strengths = _splitlist_(tx['Strengths']).join('; ') || 'None on file';
    var concerns  = _splitlist_(tx['Concerns']).join('; ')  || 'None on file';

    // renderMerge_ (not String.replace): replaces ALL occurrences and is $-safe.
    // Candidate text routinely contains "$" (e.g. "$45/hr"); String.replace would
    // interpret $-sequences in the replacement and corrupt the prompt sent to AI.
    var promptText = renderMerge_(String(prompt['Prompt Body']), {
      RoleName:         role || 'the role',
      PreScreenPayload: preScreenAnswers,
      AiSummary:        aiSummary,
      Strengths:        strengths,
      Concerns:         concerns
    });

    var gr = _geminiGradeJson_('interview_prep', candidateId, promptText);
    if (!gr.ok || !gr.data) {
      logError_('_generateAiWorksheetContent_', 'Gemini failed: ' + (gr.error || ''), candidateId, 'WARN');
      return empty;
    }
    var d = gr.data;
    return {
      tailored_questions: Array.isArray(d.tailored_questions) ? d.tailored_questions.filter(Boolean) : [],
      probe_points:       Array.isArray(d.probe_points)       ? d.probe_points.filter(Boolean)       : [],
      prep_brief:         String(d.prep_brief    || ''),
      opening_notes:      String(d.opening_notes || ''),
      ai_ok:              true
    };
  } catch (e) {
    logError_('_generateAiWorksheetContent_', e, candidateId, 'WARN');
    return empty;
  }
}

/**
 * Load the candidate's pre-screen form answers as a formatted "Q: ... / A: ..." string.
 * Returns '' if no pre-screen row found.
 */
function _loadPreScreenAnswers_(email) {
  if (!email) return '';
  try {
    var psRow = _findPreScreenRow_(email);
    if (!psRow) return '';
    var payload = _buildPreScreenPayload_(psRow);
    var lines = [];
    Object.keys(payload).forEach(function (q) {
      var skipPatterns = ['timestamp', 'candidate id', 'email', 'form response', 'submitted'];
      var lq = q.toLowerCase();
      for (var s = 0; s < skipPatterns.length; s++) {
        if (lq.indexOf(skipPatterns[s]) !== -1) return;
      }
      lines.push('Q: ' + q + '\nA: ' + payload[q]);
    });
    return lines.join('\n\n');
  } catch (e) {
    logError_('_loadPreScreenAnswers_', e, email, 'WARN');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEW GUIDE HELPERS  (all called from _renderWorksheetHtml_)
// ─────────────────────────────────────────────────────────────────────────────

function _firstNameOf_(fullName) {
  return String(fullName || '').split(/\s+/)[0] || 'there';
}

function _setupChecklist_(interviewType, scheduledTime) {
  var isPhone   = /phone|online/i.test(interviewType);
  var isWorking = /working/i.test(interviewType);
  var s = [];
  s.push('□  Open Otter and start a NEW recording <strong>BEFORE</strong> calling or meeting the candidate.');
  s.push('□  Keep this worksheet open on a second screen or print it out.');
  if (scheduledTime) s.push('□  Scheduled: <strong>' + scheduledTime + '</strong> — be ready 5 minutes early.');
  if (isPhone) {
    s.push('□  Find a quiet space — the candidate can hear background noise on calls.');
    s.push('□  Budget 20–30 minutes.');
    s.push('□  Have the candidate\'s email pulled up in case you need to send a follow-up link.');
  } else if (isWorking) {
    s.push('□  Confirm bay/lift assignment and that the right tools are accessible.');
    s.push('□  Brief the team — treat this person like a new hire starting today.');
    s.push('□  Have pay authorization ready — working interviews are paid.');
    s.push('□  Budget approximately 4 hours.');
  } else {
    s.push('□  Have a quiet space ready — plan for 45–60 minutes.');
    s.push('□  Prepare a brief shop tour to give after the Q&A section.');
    s.push('□  Water or coffee for the candidate is a nice touch.');
  }
  return s;
}

function _openingScript_(firstName, interviewType) {
  var isPhone   = /phone|online/i.test(interviewType);
  var isWorking = /working/i.test(interviewType);
  if (isPhone) {
    return [
      '"Hi ' + firstName + ', this is [YOUR NAME] calling from Frank\'s European Service — thanks for making time today.',
      '',
      'Quick heads-up: I\'m recording this call through Otter for my own note-taking — is that okay with you?',
      '',
      'Great. This will run about 20–30 minutes. I\'ll ask you about your background and experience, and I\'ll leave a few minutes at the end for your questions. Sound good?',
      '',
      'Perfect — let\'s get started."'
    ].join('\n');
  }
  if (isWorking) {
    return [
      '"Hi ' + firstName + ', welcome to Frank\'s — I\'m [YOUR NAME]. Really glad you\'re here today.',
      '',
      'Here\'s how today works: you\'ll be working alongside the team on real jobs for about four hours. Just work the way you normally would — we want to see you in your element.',
      '',
      'A couple of things before we start:',
      '  • This is a paid working interview — you\'ll be compensated for your time today.',
      '  • I may have Otter recording any conversations we have — just for my notes.',
      '  • Ask questions whenever you have them — that\'s not a test, that\'s the job.',
      '  • We\'ll sit down and debrief together at the end of the day.',
      '',
      'Any questions before we get started? Great — let\'s go."'
    ].join('\n');
  }
  return [
    '"Hi ' + firstName + ', I\'m [YOUR NAME] — so great to finally meet you in person. Come on in.',
    '',
    'I\'ll be recording our conversation through Otter for note-taking — is that okay with you?',
    '',
    'Here\'s what we\'ll cover today: about 30 minutes of questions on your background, then a quick tour of the shop, and I\'ll save time for your questions. Total is about 45–60 minutes.',
    '',
    'Sound good? Let\'s jump in."'
  ].join('\n');
}

/**
 * Returns role/type-specific boilerplate question banks.
 * { background:[], roleSpecific:[], cultureValues:[], debrief:[] }
 */
function _boilerplateQuestions_(role, interviewType) {
  var r         = String(role || '').trim();
  var isPhone   = /phone|online/i.test(interviewType);
  var isWorking = /working/i.test(interviewType);

  if (isWorking) {
    return { background: [], roleSpecific: [], cultureValues: [], debrief: [
      'How did today feel compared to your current or most recent role?',
      'Was there anything about the job or the shop that surprised you — positively or negatively?',
      'Based on what you experienced today, how are you feeling about the opportunity?',
      'Is there anything about the role, the team, or the expectations you want to clarify before you leave?'
    ]};
  }

  var background = isPhone ? [
    'Walk me through your work history — how did you get into the automotive industry?',
    'What does your most recent role look like day-to-day?',
    'Tell me about the most challenging situation you\'ve faced at work recently and how you handled it.'
  ] : [
    'Walk me through your career so far — how did you end up in the automotive industry?',
    'What does your most recent role look like day-to-day — what are you actually responsible for?',
    'Tell me about the most challenging situation you\'ve faced at work this past year and how you handled it.',
    'What\'s your greatest professional strength, and what area are you actively working to improve?'
  ];

  var cultureValues = isPhone ? [
    'What does doing quality work mean to you personally — not the shop\'s definition, yours?',
    'What do you know about Frank\'s European Service, and why are you interested in us specifically?'
  ] : [
    'Describe a time you made a mistake on the job. What happened and what did you do?',
    'How do you handle conflict with a coworker or supervisor?',
    'What does doing quality work mean to you personally — not the shop\'s definition, yours.',
    'What do you know about Frank\'s European Service, and why us specifically rather than a dealership or a different shop?'
  ];

  var roleSpecific = [];

  if (r === 'Service Advisor') {
    roleSpecific = isPhone ? [
      'Walk me through how you handle an upset customer who disputes a repair recommendation.',
      'How do you keep customers informed when a repair takes longer than expected?',
      'What DMS or service-writing software have you used?'
    ] : [
      'Walk me through how you handle a customer who pushes back hard on an estimate.',
      'How do you communicate when you discover additional issues mid-repair not on the original estimate?',
      'How do you prioritize your workload when the shop is backed up and multiple customers are waiting?',
      'What DMS or service-writing software have you used, and how quickly do you adapt to new systems?',
      'How do you handle pressure to upsell when you\'re genuinely not sure the customer needs the service?'
    ];
  } else if (r === 'Technician') {
    roleSpecific = isPhone ? [
      'What European makes and models are you most comfortable with?',
      'Walk me through your diagnostic process when you can\'t reproduce a customer\'s complaint.'
    ] : [
      'What European makes and models are you most experienced with, and which specific systems have you worked on most?',
      'Walk me through your diagnostic process when a vehicle comes in with a complaint you can\'t reproduce.',
      'Describe the most complex diagnostic or repair you\'ve worked through. What made it hard and how did you solve it?',
      'How do you stay current with new vehicle technology, repair methods, and scan-tool software updates?',
      'How do you handle a job that turns out more involved than estimated — how do you communicate that to the advisor?'
    ];
  } else if (r === 'Lube Tech') {
    roleSpecific = isPhone ? [
      'Walk me through a standard lube service — what are your quality checkpoints?'
    ] : [
      'Walk me through a standard lube service from vehicle check-in to delivery — what are your personal quality checkpoints?',
      'During a routine service you notice something outside your scope. What do you do?',
      'How do you stay productive and maintain quality during a high-volume day?',
      'How do you communicate with the service advisor when you find additional issues during a service?'
    ];
  } else if (/CX|Valet|Porter|Driver/i.test(r)) {
    roleSpecific = isPhone ? [
      'What does exceptional customer service look like to you in a shop environment?'
    ] : [
      'Describe what a perfect customer drop-off or pick-up interaction looks like from your perspective.',
      'What experience do you have operating customer vehicles — what types and roughly how many per day?',
      'During a busy morning rush, how do you decide what to prioritize and how do you communicate with the team?',
      'What\'s your approach when a customer is upset or impatient at check-in or pick-up?'
    ];
  } else if (r === 'Parts') {
    roleSpecific = isPhone ? [
      'What parts systems have you used, and how do you handle an urgent backordered part?'
    ] : [
      'How do you approach sourcing a part that\'s backordered but urgently needed for an in-progress repair?',
      'What parts lookup or inventory management systems have you used, and how quickly do you learn new ones?',
      'What\'s your process for verifying you have the right part before handing it off to the technician?',
      'How do you build and maintain vendor relationships to get competitive pricing and priority service?'
    ];
  } else if (r === 'Shop Foreman') {
    roleSpecific = isPhone ? [
      'Walk me through how you manage workflow when the shop is understaffed and overbooked.'
    ] : [
      'Walk me through how you manage the floor on a day when you\'re understaffed and overbooked.',
      'How do you handle a technician who disagrees with your diagnostic direction on a vehicle?',
      'What does your quality-control process look like before a vehicle is returned to the customer?',
      'How have you helped a lower-skill technician develop into a stronger team contributor?',
      'When you identify a systemic process problem in the shop, how do you approach fixing it?'
    ];
  }

  return { background: background, roleSpecific: roleSpecific, cultureValues: cultureValues, debrief: [] };
}

function _closingScript_(firstName, interviewType) {
  var sla     = CFG.getInt('CANDIDATE_RESPONSE_SLA_DAYS', 2);
  var slaText = sla === 1 ? '1 business day' : sla + ' business days';
  var isPhone   = /phone|online/i.test(interviewType);
  var isWorking = /working/i.test(interviewType);
  if (isPhone) {
    return [
      '"' + firstName + ', thank you so much for your time today — I really enjoyed learning about your background.',
      '',
      'Here\'s what happens next: I\'ll review my notes and follow up within ' + slaText + ' with either next steps or a final decision. We\'ll reach out by email.',
      '',
      'Do you have any final questions for me?',
      '',
      '[Answer their questions]',
      '',
      'Great — have a wonderful day, and we\'ll be in touch soon."',
      '',
      '→ Stop the Otter recording right after hanging up.'
    ].join('\n');
  }
  if (isWorking) {
    return [
      '"' + firstName + ', thank you so much for coming in today. You got to see us in action and we got to see you — that\'s the best kind of interview.',
      '',
      'Here\'s what\'s next: we\'ll debrief internally and follow up within ' + slaText + ' with our decision.',
      '',
      'Any questions before you head out?',
      '',
      '[Answer their questions]',
      '',
      'Thanks again — safe travels, and we\'ll be in touch."',
      '',
      '→ Stop the Otter recording after the candidate leaves.'
    ].join('\n');
  }
  return [
    '"' + firstName + ', thank you so much for coming in today — this was a really great conversation.',
    '',
    'Let me show you around the shop before you head out.',
    '',
    '[SHOP TOUR — introduce to key team members, show bays, office, break room, etc.]',
    '',
    'Here\'s what happens next: I\'ll follow up within ' + slaText + ' with either next steps or a final decision.',
    '',
    'Any last questions for me?',
    '',
    '[Answer their questions]',
    '',
    'Fantastic — thanks again for your time. We\'ll be in touch soon."',
    '',
    '→ Stop Otter recording after the candidate walks out.'
  ].join('\n');
}

function _postInterviewChecklist_(interviewType) {
  return [
    '□  Stop Otter recording immediately.',
    '□  Open the Interview Pipeline tab in the Recruiting OS spreadsheet.',
    '□  Find this candidate\'s row.',
    '□  Set the "Manager Decision" dropdown to reflect your decision:',
    '        Send Phone Screen Booking  → advance to phone screen',
    '        Advance to Live Interview  → phone screen went well, invite in person',
    '        Send Working Interview     → live interview went well, ready for working eval',
    '        Make Offer                 → working interview went well, ready to hire',
    '        Needs More Info            → not sure yet — sends candidate a "still reviewing" note',
    '        Put in the Drawer          → not right now but might revisit later',
    '        Reject                     → not the right fit',
    '□  Add 2–3 sentences of notes in the Notes column (key observations, stand-out moments, concerns).',
    '□  Done — the system will automatically send the appropriate email to the candidate.'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML RENDERER  — builds the full guided interview guide email
// ─────────────────────────────────────────────────────────────────────────────

function _renderWorksheetHtml_(w, cand) {
  var type      = String(w['Interview Type'] || '');
  var firstName = _firstNameOf_(w['Candidate Name']);
  var isWorking = /working/i.test(type);

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

  function secHeader(step, title, borderColor, bgColor) {
    return '<div style="background:' + bgColor + ';border-left:4px solid ' + borderColor +
           ';padding:7px 14px;margin-top:22px">' +
           '<strong style="font-size:15px;color:' + borderColor + '">' + step + '&nbsp;&nbsp;' + title + '</strong></div>';
  }
  function preBox(content, bg, border) {
    return '<div style="background:' + (bg||'#f9f9f9') + ';border:1px solid ' + (border||'#ddd') +
           ';border-radius:4px;padding:12px 16px;font-size:14px;white-space:pre-wrap;' +
           'line-height:1.7;margin-top:6px">' + esc(content).replace(/\n/g,'<br>') + '</div>';
  }
  function scriptBox(content) {
    return '<div style="background:#f0f4ff;border-left:4px solid #3050b0;padding:12px 16px;' +
           'font-size:14px;font-style:italic;white-space:pre-wrap;line-height:1.7;margin-top:6px">' +
           esc(content).replace(/\n/g,'<br>') + '</div>';
  }
  function scoreRow(label, val, note) {
    if (val === '' || val === null || val === undefined) return '';
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:#555">' + label +
           '</td><td style="padding:3px 12px 3px 0;font-size:13px;font-weight:bold">' + esc(String(val)) +
           '</td><td style="font-size:12px;color:#888">' + (note || '') + '</td></tr>';
  }
  function qList(items, startAt) {
    if (!items || !items.length) return '';
    var out = '<ol style="margin:6px 0 0 0;padding-left:20px;font-size:14px;line-height:1.8" start="' + (startAt||1) + '">';
    items.forEach(function (q) { out += '<li style="margin:4px 0">□ ' + esc(String(q)) + '</li>'; });
    return out + '</ol>';
  }
  function subHead(title, color, note) {
    return '<div style="font-size:13px;font-weight:bold;color:' + color + ';margin:16px 0 2px">' + title + '</div>' +
           (note ? '<div style="font-size:12px;color:#aaa;margin-bottom:2px">' + note + '</div>' : '');
  }

  var h = [];
  h.push('<div style="font-family:Arial,sans-serif;max-width:780px;color:#222">');

  // Alert banner
  h.push('<div style="background:#c62828;color:#fff;padding:10px 16px;font-size:14px;' +
         'font-weight:bold;border-radius:4px;margin-bottom:14px">' +
         '⚠  START OTTER RECORDING BEFORE PROCEEDING — open Otter and tap Record first.</div>');

  // Title
  h.push('<h2 style="color:#0b3d2e;margin:0 0 4px">Interview Guide — ' + esc(w['Candidate Name'] || '') + '</h2>');
  h.push('<div style="color:#555;font-size:13px">');
  h.push('<strong>' + esc(w['Role'] || 'Unknown Role') + '</strong> &nbsp;·&nbsp; ' + esc(type));
  if (w['Interview Date']) h.push(' &nbsp;·&nbsp; ' + esc(w['Interview Date']));
  if (w['Scheduled Time']) h.push(' at <strong>' + esc(w['Scheduled Time']) + '</strong>');
  if (w['Hiring Manager']) h.push(' &nbsp;·&nbsp; Interviewer: ' + esc(w['Hiring Manager']));
  h.push('</div><hr style="border:none;border-top:2px solid #0b3d2e;margin:10px 0 0">');

  // ── STEP 1: SETUP ──────────────────────────────────────────────────────────
  h.push(secHeader('1', 'BEFORE THE INTERVIEW', '#c65900', '#fff3e0'));
  var setup    = _setupChecklist_(type, w['Scheduled Time']);
  var setupHtml = setup.map(function (s) {
    return s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  }).join('<br>');
  h.push('<div style="font-size:14px;padding:10px 14px;background:#fff8f0;border:1px solid #ffe0b2;' +
         'border-radius:4px;margin-top:6px;line-height:1.9">' + setupHtml + '</div>');

  // ── STEP 2: CANDIDATE BRIEF ─────────────────────────────────────────────────
  h.push(secHeader('2', 'CANDIDATE BRIEF — For Your Eyes Only', '#0b3d2e', '#e8f4f0'));
  h.push('<p style="font-size:12px;color:#999;margin:4px 0 8px">Review this before the interview starts. Do not read aloud.</p>');

  h.push('<table style="border-collapse:collapse;margin-bottom:10px">');
  h.push(scoreRow('Pre-Screen Score', w['Pre-Screen Score'], 'out of 100'));
  h.push(scoreRow('AI Score',         w['AI Pre-Screen Score'], ''));
  var riskNum = Number(w['Risk Score'] || 0);
  h.push(scoreRow('Risk Score',       riskNum ? riskNum + ' / 10' : '', riskNum >= 5 ? '⚠ Elevated — see red flags below' : ''));
  h.push(scoreRow('Transcript Score', w['Transcript Score'], ''));
  h.push(scoreRow('Skills Test',      w['Skills Test Score'], ''));
  h.push(scoreRow('Reference Score',  w['Reference Score'], ''));
  h.push(scoreRow('Culture Fit',      w['Culture Fit Score'], ''));
  h.push('</table>');

  if (w['AI Summary']) {
    h.push(subHead('AI Summary', '#0b3d2e', ''));
    h.push('<div style="font-size:13px;line-height:1.6;white-space:pre-wrap">' +
           esc(w['AI Summary']).replace(/\n/g,'<br>') + '</div>');
  }
  if (w['Red Flags To Verify']) {
    h.push(subHead('⚑ Red Flags to Verify in This Interview', '#c00', ''));
    h.push('<div style="font-size:13px;color:#c00;white-space:pre-wrap;line-height:1.6">' +
           esc(w['Red Flags To Verify']).replace(/\n/g,'<br>') + '</div>');
  }
  if (w['Top Strengths']) {
    h.push(subHead('✔ Strengths to Confirm', '#2e7d32', ''));
    h.push('<div style="font-size:13px;color:#2e7d32;white-space:pre-wrap;line-height:1.6">' +
           esc(w['Top Strengths']).replace(/\n/g,'<br>') + '</div>');
  }
  if (w['Recommended Interview Focus']) {
    h.push(subHead('Recommended Focus', '#333', ''));
    h.push('<div style="font-size:13px;line-height:1.6">' + esc(w['Recommended Interview Focus']) + '</div>');
  }
  if (w['Clarification Items']) {
    h.push(subHead('Clarification Items', '#555', ''));
    h.push('<div style="font-size:13px;white-space:pre-wrap;line-height:1.6">' +
           esc(w['Clarification Items']).replace(/\n/g,'<br>') + '</div>');
  }

  // ── STEP 3: OPENING SCRIPT ─────────────────────────────────────────────────
  h.push(secHeader('3', 'OPENING SCRIPT', '#3050b0', '#f0f4ff'));
  h.push('<p style="font-size:12px;color:#999;margin:4px 0 6px">Read verbatim or paraphrase naturally. Fill in [YOUR NAME].</p>');
  h.push(scriptBox(_openingScript_(firstName, type)));

  // ── STEP 4: QUESTIONS ──────────────────────────────────────────────────────
  h.push(secHeader('4', 'INTERVIEW QUESTIONS', '#0b3d2e', '#e8f4f0'));
  var bpq  = _boilerplateQuestions_(w['Role'], type);
  var qNum = 1;

  if (isWorking) {
    h.push('<p style="font-size:13px;margin:8px 0 2px;color:#555">Ask these during the <strong>end-of-day debrief</strong>, not at the start of the day.</p>');
    h.push(qList(bpq.debrief, qNum));
  } else {
    if (bpq.background && bpq.background.length) {
      h.push(subHead('A. Background &amp; Experience', '#333', 'Same questions asked of every candidate.'));
      h.push(qList(bpq.background, qNum));
      qNum += bpq.background.length;
    }
    if (bpq.roleSpecific && bpq.roleSpecific.length) {
      h.push(subHead('B. ' + esc(w['Role'] || 'Role') + '-Specific', '#333', 'Standard questions for this role.'));
      h.push(qList(bpq.roleSpecific, qNum));
      qNum += bpq.roleSpecific.length;
    }
    // Candidate-specific probes from AI analysis
    var rawQ  = String(w['Suggested Questions'] || '');
    var probes = rawQ.split('\n').map(function (s) { return s.replace(/^[•\-\d\.\s□]+/, '').trim(); }).filter(Boolean);
    if (probes.length) {
      h.push('<div style="font-size:13px;font-weight:bold;color:#9a2200;margin:16px 0 2px">C. Candidate-Specific Probes</div>');
      h.push('<div style="font-size:12px;color:#9a2200;margin-bottom:2px">⚑ AI-flagged based on <em>this candidate\'s</em> pre-screen. Prioritize these.</div>');
      h.push(qList(probes, qNum));
      qNum += probes.length;
    }
    if (bpq.cultureValues && bpq.cultureValues.length) {
      h.push(subHead('D. Culture &amp; Values', '#333', 'Non-negotiables — same for every candidate at Frank\'s.'));
      h.push(qList(bpq.cultureValues, qNum));
      qNum += bpq.cultureValues.length;
    }
    h.push(subHead('E. Candidate\'s Questions', '#333', 'Reserve 5–10 min. What they ask reveals what matters to them.'));
    h.push('<div style="font-size:14px;font-style:italic;padding:8px 12px;background:#f9f9f9;' +
           'border:1px solid #ddd;border-radius:4px">' +
           '"Do you have any questions for me about the role, the team, or what a typical day looks like here?"</div>');
  }

  // ── STEP 5: CLOSING SCRIPT ─────────────────────────────────────────────────
  h.push(secHeader('5', 'CLOSING SCRIPT', '#3050b0', '#f0f4ff'));
  h.push('<p style="font-size:12px;color:#999;margin:4px 0 6px">Read verbatim or paraphrase. Stop the recording immediately after.</p>');
  h.push(scriptBox(_closingScript_(firstName, type)));

  // ── LEGAL REMINDERS ────────────────────────────────────────────────────────
  h.push(secHeader('⚠', 'DO NOT ASK OR HINT AT', '#c00', '#fff0f0'));
  h.push('<div style="font-size:13px;color:#c00;padding:8px 14px;line-height:1.9">');
  h.push('✗&nbsp; Age, date of birth, or year of graduation<br>');
  h.push('✗&nbsp; Marital status, children, or family plans<br>');
  h.push('✗&nbsp; National origin, accent, or immigration status<br>');
  h.push('✗&nbsp; Religion or religious practices<br>');
  h.push('✗&nbsp; Disability or medical history<br>');
  h.push('✗&nbsp; "I think you\'d be a great fit" — do not hint at the hiring decision before you\'ve decided<br>');
  h.push('✗&nbsp; Specific pay figures or start dates (those belong in the offer stage)');
  h.push('</div>');

  // ── POST-INTERVIEW ─────────────────────────────────────────────────────────
  h.push(secHeader('6', 'AFTER THE INTERVIEW', '#555', '#f5f5f5'));
  h.push(preBox(_postInterviewChecklist_(type)));

  // Footer
  h.push('<hr style="border:none;border-top:1px solid #eee;margin-top:22px">');
  h.push('<div style="color:#bbb;font-size:11px">Generated by Recruiting OS · ' +
         esc(w['Timestamp'] || '') + ' · Scores are decision support, not a decision.</div>');
  h.push('</div>');
  return h.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _latestTranscriptForCandidate_(cid) {
  var sh = getSheetOrNull_(SHEETS.TRANSCRIPT_ARCHIVE);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Candidate ID', cid);
  if (!hits.length) return null;
  hits.sort(function (a, b) {
    return _coerceDate_(b.data['Meeting Date'] || b.data['Archived At']).getTime() -
           _coerceDate_(a.data['Meeting Date'] || a.data['Archived At']).getTime();
  });
  return hits[0].data;
}

function _splitlist_(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v).split(/\s*[;|\n]\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _deriveRedFlags_(risk, concerns, tx, aiAuthored) {
  var flags = [];
  if (Number(risk) >= 5) flags.push('Elevated risk score (' + risk + '/10) — verify employment history & reasons for leaving');
  if (String(tx['Confidence Level'] || '').toLowerCase() === 'low') flags.push('AI confidence was LOW — treat scores as provisional, probe in person');
  var threshold = CFG.getInt('AI_AUTHORED_LIKELIHOOD_THRESHOLD', 70);
  if (aiAuthored && aiAuthored.likelihood >= threshold) {
    flags.push('Pre-screen answers may be AI-generated (' + aiAuthored.likelihood + '/100) — ask for specific stories with names/dates the AI cannot have invented' +
      (aiAuthored.reasoning ? ': ' + aiAuthored.reasoning : ''));
  }
  concerns.slice(0, 3).forEach(function (c) { flags.push('Verify concern: ' + c); });
  return flags;
}

function _deriveQuestions_(concerns, role) {
  // Returns only candidate-specific probes (concern-derived).
  // Boilerplate questions are added during HTML rendering via _boilerplateQuestions_().
  var q = [];
  concerns.slice(0, 4).forEach(function (c) {
    q.push('Regarding "' + c + '" — can you walk me through a specific example?');
  });
  return q;
}

function _deriveClarifications_(tx, cand, aiAuthored) {
  var items = [];
  if (!tx['AI Score'] && !cand['Phone Score'] && !cand['Full Score'])
    items.push('No interview transcript on file yet — scores below are pre-screen only.');
  if (String(tx['Summary'] || '').toLowerCase().indexOf('misrepresent') !== -1)
    items.push('AI flagged possible misrepresentation — confirm claims against resume.');
  if (!tx['AI Score'] && !cand['Phone Score'] && !cand['Full Score']) items.push('No interview transcript on file yet — scores below are pre-screen only.');
  if (String(tx['Summary'] || '').toLowerCase().indexOf('misrepresent') !== -1) items.push('AI flagged possible misrepresentation — confirm claims against resume.');
  if (aiAuthored && aiAuthored.likelihood >= CFG.getInt('AI_AUTHORED_LIKELIHOOD_THRESHOLD', 70)) {
    items.push('Suspected AI-authored pre-screen — listen for whether spoken answers match the written ones in voice, specificity, and consistency.');
  }
  return items;
}

function _aiAuthoredFor_(candidateId) {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return { likelihood: 0, reasoning: '' };
  var hits = findRowsByColumnValue_(ac, 'Candidate ID', candidateId);
  if (!hits.length) return { likelihood: 0, reasoning: '' };
  return {
    likelihood: parseInt(hits[0].data['AI-Authored Likelihood'], 10) || 0,
    reasoning:  String(hits[0].data['AI-Authored Reasoning'] || '')
  };
}

function _deriveFocus_(role, risk, concerns) {
  if (Number(risk) >= 5) return 'Verify credibility & history first; then assess fit for ' + (role || 'the role') + '.';
  if (concerns.length)   return 'Probe the top concerns, then confirm strengths translate to day-to-day work.';
  return 'Confirm strengths and culture fit for ' + (role || 'the role') + '.';
}

function _findWorksheetRow_(sh, cid, dateStr, type) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);
  var hC = headers.indexOf('Candidate ID');
  var hD = headers.indexOf('Interview Date');
  var hT = headers.indexOf('Interview Type');
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][hC]) === String(cid) &&
        String(data[i][hD]) === String(dateStr) &&
        String(data[i][hT]) === String(type)) return i + 2;
  }
  return 0;
}

/**
 * True if ANY worksheet already exists for this candidate on this date,
 * regardless of interview type. Used by the calendar scans so an event whose
 * guessed type differs from the pipeline column's type (e.g. generic
 * "Interview - Name" guessed as Live vs. a pipeline Phone Screen) does not
 * create a duplicate worksheet for the same interview.
 */
function _worksheetExistsForDate_(sh, cid, dateStr) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var headers = getHeaderRow_(sh);
  var hC = headers.indexOf('Candidate ID');
  var hD = headers.indexOf('Interview Date');
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][hC]) === String(cid) && String(data[i][hD]) === String(dateStr)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP: REMOVE DUPLICATE WORKSHEETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove duplicate worksheet rows, keeping ONE row per
 * Candidate ID + Interview Date (the most recently generated, by Timestamp).
 *
 * Separate interviews on different dates are preserved. Same-day duplicates
 * (e.g. several rows auto-generated for the same booking) collapse to the
 * newest single row. Idempotent and safe to re-run. Deletes from the bottom up
 * so row indexes stay valid.
 */
function dedupeInterviewWorksheets() {
  return safeRun_('dedupeInterviewWorksheets', function () {
    var plan = _planWorksheetDedup_();
    if (!plan) return 'Interview Worksheets sheet missing';
    if (!plan.toDelete.length) {
      toast_('No duplicate worksheets found.', 'Recruiting OS', 6);
      return 'no duplicates (kept ' + plan.keptCount + ' rows)';
    }
    var sh = getSheet_(SHEETS.INTERVIEW_WORKSHEETS);
    plan.toDelete.sort(function (a, b) { return b - a; });   // bottom-up
    plan.toDelete.forEach(function (rowNum) { sh.deleteRow(rowNum); });
    var msg = 'removed ' + plan.toDelete.length + ' duplicate row(s); kept ' +
              plan.keptCount + ' (one per candidate + interview date)';
    Logger.log('[WORKSHEET] dedupe — ' + msg);
    toast_('Worksheets cleaned: ' + msg, 'Recruiting OS', 10);
    return msg;
  });
}

/**
 * Preview the duplicate cleanup WITHOUT deleting anything. Logs which rows would
 * be kept and which removed. Run this first if you want to see the effect.
 */
function previewDedupeInterviewWorksheets() {
  return safeRun_('previewDedupeInterviewWorksheets', function () {
    var plan = _planWorksheetDedup_();
    if (!plan) return 'Interview Worksheets sheet missing';
    var out = ['[WORKSHEET] dedupe PREVIEW (nothing deleted):'];
    out.push('  Would keep ' + plan.keptCount + ' row(s), remove ' + plan.toDelete.length + '.');
    plan.groups.forEach(function (g) {
      out.push('  - ' + g.name + ' / ' + g.date + ': keep row ' + g.keepRow +
               (g.deleteRows.length ? ', remove rows ' + g.deleteRows.join(', ') : ''));
    });
    var msg = out.join('\n');
    Logger.log(msg);
    toast_('Preview: would remove ' + plan.toDelete.length + ' duplicate(s). See log for detail.', 'Recruiting OS', 10);
    return msg;
  });
}

/**
 * Build the dedup plan: for each Candidate ID + Interview Date keep the row with
 * the newest Timestamp, mark the rest for deletion. Shared by preview + executor.
 */
function _planWorksheetDedup_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
  if (!sh) return null;
  var last    = sh.getLastRow();
  var headers = getHeaderRow_(sh);
  var hCid  = headers.indexOf('Candidate ID');
  var hDate = headers.indexOf('Interview Date');
  var hName = headers.indexOf('Candidate Name');
  var hTs   = headers.indexOf('Timestamp');
  var plan  = { toDelete: [], keptCount: 0, groups: [] };
  if (last < 2 || hCid === -1 || hDate === -1) return plan;

  var data  = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var byKey = {};   // "cid||date" -> [ { rowNum, ts, name, date } ]
  for (var i = 0; i < data.length; i++) {
    var cid  = String(data[i][hCid]  || '').trim();
    var date = String(data[i][hDate] || '').trim();
    if (!cid && !date) continue;            // skip fully blank rows
    var key  = cid + '||' + date;
    var tsMs = _coerceDate_(hTs !== -1 ? data[i][hTs] : '').getTime();
    if (isNaN(tsMs)) tsMs = 0;
    (byKey[key] = byKey[key] || []).push({
      rowNum: i + 2,
      ts:     tsMs,
      name:   hName !== -1 ? String(data[i][hName] || '') : cid,
      date:   date
    });
  }

  Object.keys(byKey).forEach(function (key) {
    var rows = byKey[key];
    // Newest timestamp wins; on a tie keep the lowest (earliest) row number.
    rows.sort(function (a, b) { return (b.ts - a.ts) || (a.rowNum - b.rowNum); });
    var del = rows.slice(1).map(function (r) { return r.rowNum; });
    plan.keptCount++;
    plan.groups.push({ name: rows[0].name, date: rows[0].date, keepRow: rows[0].rowNum, deleteRows: del });
    del.forEach(function (rn) { plan.toDelete.push(rn); });
  });

  return plan;
}

function _setWorksheetSendState_(sh, rowNum, status, note) {
  batchUpdateRow_(sh, rowNum, {
    'Email Status':  status,
    'Email Sent At': status === 'SENT' ? shopDateTime_() : '',
    'Notes':         note || ''
  });
}

function _hiringManagerEmail_(managerName) {
  var sh = getSheetOrNull_(SHEETS.HIRING_MANAGERS);
  if (sh && managerName) {
    var hits = findRowsByColumnValue_(sh, 'Name', managerName);
    if (hits.length && hits[0].data['Email']) return String(hits[0].data['Email']).trim();
  }
  return CFG.get('HIRING_MANAGER_EMAIL', CFG.get('DIGEST_RECIPIENT_EMAIL', ''));
}

function _ymd_(v) {
  var tz = CFG.get('TIMEZONE', 'America/Los_Angeles');
  return Utilities.formatDate(_coerceDate_(v), tz, 'yyyy-MM-dd');
}

function _timeOf_(v) {
  if (!v) return '';
  var d = _coerceDate_(v);
  if (isNaN(d.getTime()) || (d.getHours() === 0 && d.getMinutes() === 0)) return '';
  return Utilities.formatDate(d, CFG.get('TIMEZONE', 'America/Los_Angeles'), 'h:mm a');
}

function _rowObj_(headers, rowValues) {
  var o = {};
  headers.forEach(function (h, i) { o[h] = rowValues[i]; });
  return o;
}

function _htmlToPlainSafe_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h2|h3|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL / SEED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert the interview_prep AI prompt into the AI Prompts sheet.
 * Run this once after deploying the updated files.
 */
function installInterviewPrepPrompt() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.AI_PROMPTS);
    var rowObj = {
      'Prompt Key':  'interview_prep',
      'Phase':       'InterviewPrep',
      'Provider':    '{{Provider}}',
      'Model':       '{{Model}}',
      'Temperature': 0.3,
      'Prompt Body': _buildInterviewPrepPromptBody_(),
      'Notes':       'Interview prep: generates tailored questions from pre-screen answers for the hiring manager worksheet.'
    };
    var hits = findRowsByColumnValue_(sh, 'Prompt Key', 'interview_prep');
    if (hits.length) updateRowWhere_(sh, 'Prompt Key', 'interview_prep', rowObj);
    else appendRowByHeader_(sh, rowObj);
    var msg = '[WORKSHEET] interview_prep prompt ' + (hits.length ? 'updated' : 'installed');
    Logger.log(msg);
    toast_(msg, 'Recruiting OS', 6);
    return msg;
  });
}

function _buildInterviewPrepPromptBody_() {
  return (
    'You prepare an interview worksheet for a hiring manager at an auto repair shop called Frank\'s European Service. ' +
    'Your job is to write tailored, specific interview questions based on this candidate\'s actual pre-screen answers — not generic filler questions.\n\n' +
    'ROLE BEING INTERVIEWED FOR: {{RoleName}}\n\n' +
    'CANDIDATE\'S PRE-SCREEN ANSWERS (their own words):\n{{PreScreenPayload}}\n\n' +
    'PRIOR AI ANALYSIS SUMMARY (if available):\n{{AiSummary}}\n\n' +
    'KNOWN STRENGTHS: {{Strengths}}\n' +
    'KNOWN CONCERNS: {{Concerns}}\n\n' +
    'Instructions:\n' +
    '- Write 5 to 8 tailored questions that follow up DIRECTLY on what the candidate wrote in their pre-screen. ' +
    'Quote or closely paraphrase their exact words when forming questions. Each question should reference something specific they said.\n' +
    '- Write 3 to 4 probe points for concerns, vague answers, or things that need clarification or verification.\n' +
    '- Write a 2 to 3 sentence prep_brief telling the interviewer what to watch for with this specific person based on their answers.\n' +
    '- Write 1 concise sentence of opening_notes (e.g., "Candidate mentioned 8 years at a BMW dealership but was vague on diagnostic software used").\n\n' +
    'Return STRICT JSON only. No prose outside JSON. Fields:\n' +
    '  tailored_questions (array of strings),\n' +
    '  probe_points (array of strings),\n' +
    '  prep_brief (string),\n' +
    '  opening_notes (string)'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ON-DEMAND: TODAY + UPCOMING  (manual trigger from menu or editor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate and send worksheets for today through the next WORKSHEET_LOOKAHEAD_DAYS
 * days (default 7). Already-SENT worksheets are skipped unless force=true.
 * Callable from the menu or the Apps Script editor at any time.
 */
function generateAndSendUpcomingWorksheets() {
  return safeRun_('generateAndSendUpcomingWorksheets', function () {
    var gen  = generateWorksheetsForRange_();
    var sent = sendUpcomingInterviewWorksheets();
    var msg  = gen + ' | ' + sent;
    toast_('Upcoming worksheets: ' + msg, 'Recruiting OS', 8);
    Logger.log('[WORKSHEET] generateAndSendUpcomingWorksheets — ' + msg);
    return msg;
  });
}

/** Scan Interview Pipeline for interviews in [today, today + WORKSHEET_LOOKAHEAD_DAYS]. */
function generateWorksheetsForRange_() {
  return withLock_(function () {
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (!ip) return 'Interview Pipeline missing';
    var last = ip.getLastRow();
    if (last < 2) return 'no pipeline rows';
    var headers = getHeaderRow_(ip);
    var hCid = headers.indexOf('Candidate ID');
    if (hCid === -1) return 'no Candidate ID column';
    var look = CFG.getInt('WORKSHEET_LOOKAHEAD_DAYS', 7);
    var now = new Date();
    var startYmd = _ymd_(now);
    var endYmd   = _ymd_(new Date(now.getTime() + look * 24 * 60 * 60 * 1000));
    var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, generated: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var cid = String(data[i][hCid] || '').trim();
      if (!cid) continue;
      WORKSHEET_INTERVIEW_DATE_COLUMNS.forEach(function (def) {
        var col = headers.indexOf(def.column);
        if (col === -1) return;
        var v = data[i][col];
        if (!v) return;
        var ymd = _ymd_(v);
        if (ymd < startYmd || ymd > endYmd) return;
        var ws = generateInterviewWorksheet_(cid, def.type, v);
        if (ws) summary.generated++;
      });
    }

    // ── Calendar scan: catch interviews booked on the calendar but not yet
    //    reflected in pipeline date columns (Google Meet pre-screens, manually
    //    created in-person events). Mirrors generateWorksheetsForToday's scan
    //    but spans the full lookahead window. ──
    var calId = CFG.get('INTERVIEW_CALENDAR_ID');
    if (calId) {
      try {
        var cal = CalendarApp.getCalendarById(calId);
        if (cal) {
          var scanStart = new Date(); scanStart.setHours(0, 0, 0, 0);
          var scanEnd   = new Date(scanStart.getTime() + (look + 1) * 24 * 60 * 60 * 1000);
          var calEvents = cal.getEvents(scanStart, scanEnd);
          var wsSh      = getSheet_(SHEETS.INTERVIEW_WORKSHEETS);
          var prefix    = CFG.get('INTERVIEW_BLOCK_EVENT_PREFIX', '[Recruiting Available]');
          calEvents.forEach(function (ev) {
            try {
              var evTitle = ev.getTitle() || '';
              if (evTitle.indexOf(prefix) === 0) return;
              var evYmd = _ymd_(ev.getStartTime());
              if (evYmd < startYmd || evYmd > endYmd) return;

              var iType  = _guessTypeFromTitle_(evTitle);
              var calCid = _findCandidateForEvent_(ev);
              if (!calCid) return;

              // Skip if any worksheet already exists for this candidate on this
              // date (the pipeline scan above may have already made one).
              if (_worksheetExistsForDate_(wsSh, calCid, evYmd)) return;
              var ws = generateInterviewWorksheet_(calCid, iType, ev.getStartTime());
              if (ws) summary.generated++;
            } catch (e2) { logError_('generateWorksheetsForRange_:calEvent', e2, '', 'WARN'); }
          });
        }
      } catch (calE) { logError_('generateWorksheetsForRange_:calendar', calE, '', 'WARN'); }
    }

    var msg = 'generated ' + summary.generated + ' worksheet(s) for ' + startYmd +
              ' to ' + endYmd + ' (pipeline rows scanned ' + summary.scanned + ')';
    Logger.log('[WORKSHEET] ' + msg);
    return msg;
  }, 30000, 'user');
}

/**
 * Send all DRAFT worksheets whose interview date falls within today through
 * WORKSHEET_LOOKAHEAD_DAYS days. Pass force=true to resend already-SENT rows.
 */
function sendUpcomingInterviewWorksheets(force) {
  return withLock_(function () {
    var sh = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
    if (!sh) return 'Interview Worksheets sheet missing';
    var last = sh.getLastRow();
    if (last < 2) return 'no worksheets';
    var headers = getHeaderRow_(sh);
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var look = CFG.getInt('WORKSHEET_LOOKAHEAD_DAYS', 7);
    var now = new Date();
    var startYmd = _ymd_(now);
    var endYmd   = _ymd_(new Date(now.getTime() + look * 24 * 60 * 60 * 1000));
    var idx = {};
    headers.forEach(function (h, i) { idx[h] = i; });
    var summary = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var r = data[i];
      var ymd = _ymd_(r[idx['Interview Date']]);
      if (ymd < startYmd || ymd > endYmd) { summary.skipped++; continue; }
      if (!force && String(r[idx['Email Status']]) === 'SENT') { summary.skipped++; continue; }

      var managerEmail = _hiringManagerEmail_(r[idx['Hiring Manager']]);
      var toActual = actualRecipient_(managerEmail);
      if (!toActual) {
        summary.skipped++;
        _setWorksheetSendState_(sh, i + 2, 'BLOCKED', 'SEND_ENABLED off or no recipient');
        continue;
      }

      var subject = '[Recruiting OS] Interview Worksheet — ' + r[idx['Candidate Name']] +
                    ' — ' + r[idx['Role']] + ' — ' + r[idx['Interview Type']];
      var html = String(r[idx['Worksheet Body']] || _renderWorksheetHtml_(_rowObj_(headers, r), {}));
      try {
        GmailApp.sendEmail(toActual, subject, _htmlToPlainSafe_(html), {
          htmlBody:  html,
          name:      CFG.get('EMAIL_FROM_NAME', "Frank's Recruiting Team"),
          replyTo:   CFG.get('DEFAULT_REPLY_TO_EMAIL', '')
        });
        _setWorksheetSendState_(sh, i + 2, 'SENT',
          isTestMode_() ? 'TEST → ' + toActual : 'LIVE → ' + toActual);
        summary.sent++;
        logEvent_('WORKSHEET_EMAILED', String(r[idx['Candidate ID']]), {
          to: toActual, mode: isTestMode_() ? 'TEST' : 'LIVE', date: ymd
        });
      } catch (e) {
        summary.failed++;
        _setWorksheetSendState_(sh, i + 2, 'FAILED', e.message);
        logError_('sendUpcomingInterviewWorksheets', e, String(r[idx['Candidate ID']]), 'ERROR');
      }
    }
    var msg = 'sent ' + summary.sent + ', skipped ' + summary.skipped + ', failed ' + summary.failed +
              ' (range ' + startYmd + ' to ' + endYmd +
              ', mode=' + (isTestMode_() ? 'TEST' : 'LIVE') + ')';
    Logger.log('[WORKSHEET] ' + msg);
    toast_('Worksheets: ' + msg, 'Recruiting OS', 8);
    return msg;
  }, 30000, 'user');
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────

function WORKSHEET_selfTest() {
  var out = ['[WORKSHEET] selfTest (read-only)…'];
  out.push('  ─ INTERVIEW_WORKSHEETS_ENABLED : ' + CFG.getBool('INTERVIEW_WORKSHEETS_ENABLED', true));
  out.push('  ─ WORKSHEET_EMAIL_HOUR         : ' + CFG.getInt('WORKSHEET_EMAIL_HOUR', 7));
  out.push('  ─ INTERVIEW_CALENDAR_ID        : ' + (CFG.get('INTERVIEW_CALENDAR_ID') ? '✓ set' : '✗ NOT SET — calendar scan disabled'));
  out.push('  ─ Mode                         : ' + (isTestMode_() ? 'TEST → ' + CFG.get('TEST_RECIPIENT_EMAIL') : 'LIVE → hiring manager'));

  var sh = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
  out.push('  ' + (sh ? '✓' : '✗') + ' Interview Worksheets tab present');

  var aiSh = getSheetOrNull_(SHEETS.AI_PROMPTS);
  if (aiSh) {
    var hits = findRowsByColumnValue_(aiSh, 'Prompt Key', 'interview_prep');
    out.push('  ' + (hits.length ? '✓' : '✗') + ' interview_prep AI prompt' +
             (hits.length ? '' : ' — run installInterviewPrepPrompt() to install'));
  }

  var calId = CFG.get('INTERVIEW_CALENDAR_ID');
  if (calId) {
    try {
      var cal = CalendarApp.getCalendarById(calId);
      out.push('  ' + (cal ? '✓' : '✗') + ' Calendar accessible: ' + (cal ? cal.getName() : 'NOT FOUND'));
    } catch (e) {
      out.push('  ✗ Calendar open failed: ' + e.message);
    }
  }

  out.push('  ─ Pipeline date columns scanned: ' + WORKSHEET_INTERVIEW_DATE_COLUMNS.map(function (d) { return d.column; }).join(', '));
  out.push('[WORKSHEET] selfTest done. Run installInterviewPrepPrompt() then generateWorksheetsForToday() to test.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Diagnose why generateWorksheetsForToday() found 0 worksheets.
 * Shows: (1) which pipeline rows have today's date in any date column,
 * (2) what Google Calendar events exist for today and whether each matched
 * a candidate. Run from the script editor when worksheets aren't generating.
 */
function WORKSHEET_diagnoseToday() {
  var out = ['[WORKSHEET] diagnoseTodayCalendar — ' + new Date().toISOString()];
  var today = _ymd_(new Date());
  out.push('  ─ Today (shop TZ): ' + today);

  // ── Pipeline scan ──
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) {
    out.push('  ✗ Interview Pipeline sheet not found');
  } else {
    var last    = ip.getLastRow();
    var headers = getHeaderRow_(ip);
    var hCid    = headers.indexOf('Candidate ID');
    var hName   = headers.indexOf('Full Name');
    var found   = 0;
    if (last >= 2 && hCid !== -1) {
      var rows = ip.getRange(2, 1, last - 1, headers.length).getValues();
      WORKSHEET_INTERVIEW_DATE_COLUMNS.forEach(function (def) {
        var col = headers.indexOf(def.column);
        if (col === -1) { out.push('  ✗ Pipeline column "' + def.column + '" not found'); return; }
        rows.forEach(function (r) {
          var v = r[col];
          if (!v) return;
          var ymd = _ymd_(v);
          if (ymd === today) {
            found++;
            var cid  = String(r[hCid]  || '(no ID)');
            var name = String(hName !== -1 ? r[hName] : '');
            out.push('  ✓ PIPELINE MATCH: ' + def.column + ' = ' + ymd + '  — ' + (name || cid));
          }
        });
      });
    }
    out.push('  ─ Pipeline: ' + last + ' rows scanned, ' + found + ' with today\'s date in a date column');
  }

  // ── Calendar scan ──
  var calId = CFG.get('INTERVIEW_CALENDAR_ID');
  if (!calId) {
    out.push('  ✗ INTERVIEW_CALENDAR_ID not set in Config — calendar scan is disabled');
    out.push('    → Set INTERVIEW_CALENDAR_ID in the Config tab to enable calendar scanning');
  } else {
    out.push('  ─ Calendar ID: ' + truncate_(calId, 60));
    try {
      var cal = CalendarApp.getCalendarById(calId);
      if (!cal) {
        out.push('  ✗ Calendar not accessible — check INTERVIEW_CALENDAR_ID value');
      } else {
        out.push('  ✓ Calendar: ' + cal.getName());
        var scanStart = new Date(); scanStart.setHours(0, 0, 0, 0);
        var scanEnd   = new Date(scanStart.getTime() + 48 * 60 * 60 * 1000);
        var events    = cal.getEvents(scanStart, scanEnd);
        out.push('  ─ Events in 48-hr window: ' + events.length);
        var prefix = CFG.get('INTERVIEW_BLOCK_EVENT_PREFIX', '[Recruiting Available]');
        events.forEach(function (ev) {
          var evTitle = ev.getTitle() || '(no title)';
          var evYmd   = _ymd_(ev.getStartTime());
          var skip    = evTitle.indexOf(prefix) === 0;
          if (skip) return; // ignore availability blocks
          var emails  = _eventCandidateEmails_(ev);   // guests + description emails
          out.push('  ─ Event: "' + evTitle + '" on ' + evYmd +
                   (evYmd === today ? ' [TODAY]' : ' [not today]') +
                   ' | candidate emails: ' + (emails.length ? emails.join(', ') : '(none found)'));
          if (evYmd === today) {
            var cid = _findCandidateForEvent_(ev);
            if (cid) {
              out.push('      ✓ Matched candidate: ' + cid +
                       (emails.length ? ' (via email ' + emails.join(', ') + ')' : ' (via title name)'));
            } else {
              out.push('      ✗ No candidate match (checked guest + description emails and the title name).');
              out.push('        → Confirm the candidate exists in All Candidates / Interview Pipeline with this email,');
              out.push('          or force-generate: generateWorksheetManual_("CANDIDATE_ID", "' + _guessTypeFromTitle_(evTitle) + '")');
            }
          }
        });
      }
    } catch (e) {
      out.push('  ✗ Calendar error: ' + e.message);
    }
  }

  out.push('[WORKSHEET] diagnosis complete.');
  out.push('  If you have an interview today but see no matches above:');
  out.push('  1. Make sure the calendar event has the candidate as a guest (Koalendar does this automatically)');
  out.push('  2. Or run: generateWorksheetManual_("CANDIDATE_ID", "Phone Screen (online)") from the editor');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Diagnose why "Generate & Send Upcoming Worksheets" produced 0 worksheets
 * across the full WORKSHEET_LOOKAHEAD_DAYS window. Unlike WORKSHEET_diagnoseToday
 * (today only), this explains the whole lookahead the menu button uses, and
 * spells out each drop-out reason: missing calendar ID, unparseable "Booked"
 * values (e.g. a checkbox instead of a date → 1970), out-of-range dates,
 * unmatched calendar guests, and why existing worksheet rows are being skipped.
 *
 * Read-only. Run from the menu (Admin & Setup) or the Apps Script editor.
 */
function WORKSHEET_diagnoseUpcoming() {
  var out = ['[WORKSHEET] diagnoseUpcoming — ' + new Date().toISOString()];
  var look     = CFG.getInt('WORKSHEET_LOOKAHEAD_DAYS', 7);
  var now      = new Date();
  var startYmd = _ymd_(now);
  var endYmd   = _ymd_(new Date(now.getTime() + look * 24 * 60 * 60 * 1000));
  out.push('  ─ Lookahead window : ' + startYmd + ' → ' + endYmd + ' (' + look + ' days)');
  out.push('  ─ Worksheets enabled: ' + CFG.getBool('INTERVIEW_WORKSHEETS_ENABLED', true));
  out.push('  ─ Mode             : ' + (isTestMode_() ? 'TEST → ' + CFG.get('TEST_RECIPIENT_EMAIL') : 'LIVE → hiring manager'));
  var calId = CFG.get('INTERVIEW_CALENDAR_ID');
  out.push('  ─ INTERVIEW_CALENDAR_ID: ' + (calId ? '✓ set' : '✗ NOT SET — calendar scan disabled AND bookings cannot auto-stamp the pipeline date columns'));

  // ── 1. Pipeline date columns (what generation reads) ──
  out.push('');
  out.push('  ── PIPELINE DATE COLUMNS (generation source) ──');
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var inRange = 0, outRange = 0, garbled = 0;
  if (!ip) {
    out.push('  ✗ Interview Pipeline sheet not found');
  } else {
    var last = ip.getLastRow();
    var headers = getHeaderRow_(ip);
    var hCid = headers.indexOf('Candidate ID');
    var hName = headers.indexOf('Full Name');
    if (last >= 2 && hCid !== -1) {
      var rows = ip.getRange(2, 1, last - 1, headers.length).getValues();
      WORKSHEET_INTERVIEW_DATE_COLUMNS.forEach(function (def) {
        var col = headers.indexOf(def.column);
        if (col === -1) { out.push('  ✗ Column "' + def.column + '" not present in pipeline'); return; }
        var nonEmpty = 0;
        rows.forEach(function (r) {
          var v = r[col];
          if (v === '' || v === null || v === undefined) return;
          nonEmpty++;
          var ymd  = _ymd_(v);
          var who  = String(hName !== -1 ? r[hName] : '') || String(r[hCid] || '');
          var bad  = (ymd === '1970-01-01'); // _coerceDate_ fallback — value was not a real date (e.g. a checkbox/TRUE)
          if (bad) {
            garbled++;
            out.push('  ⚠ ' + def.column + ' = "' + v + '" (NOT a date → parses to 1970) — ' + who +
                     '  →  a checkbox/blank instead of the interview date');
          } else if (ymd >= startYmd && ymd <= endYmd) {
            inRange++;
            out.push('  ✓ IN RANGE: ' + def.column + ' = ' + ymd + ' — ' + who);
          } else {
            outRange++;
          }
        });
        out.push('    · ' + def.column + ': ' + nonEmpty + ' non-empty value(s)');
      });
    }
    out.push('  ─ Pipeline summary: ' + inRange + ' in-range, ' + outRange + ' out-of-range, ' + garbled + ' unparseable');
  }

  // ── 2. Calendar events in the window ──
  out.push('');
  out.push('  ── CALENDAR EVENTS IN WINDOW (fallback source) ──');
  if (!calId) {
    out.push('  ✗ INTERVIEW_CALENDAR_ID not set → the 6 interviews on your Google Calendar are invisible to the system.');
    out.push('    → Set INTERVIEW_CALENDAR_ID in the Config tab to the calendar that holds the interview events,');
    out.push('      then re-run. This also lets pollCalendarBookings stamp the pipeline "Booked" date columns.');
  } else {
    try {
      var cal = CalendarApp.getCalendarById(calId);
      if (!cal) {
        out.push('  ✗ Calendar not accessible — check the INTERVIEW_CALENDAR_ID value.');
      } else {
        out.push('  ✓ Calendar: ' + cal.getName());
        var scanStart = new Date(); scanStart.setHours(0, 0, 0, 0);
        var scanEnd   = new Date(scanStart.getTime() + (look + 1) * 24 * 60 * 60 * 1000);
        var events    = cal.getEvents(scanStart, scanEnd);
        var prefix    = CFG.get('INTERVIEW_BLOCK_EVENT_PREFIX', '[Recruiting Available]');
        var matched = 0, unmatched = 0, shown = 0;
        events.forEach(function (ev) {
          var evTitle = ev.getTitle() || '(no title)';
          if (evTitle.indexOf(prefix) === 0) return; // availability block
          var evYmd = _ymd_(ev.getStartTime());
          if (evYmd < startYmd || evYmd > endYmd) return;
          shown++;
          var emails = _eventCandidateEmails_(ev);
          var cid = _findCandidateForEvent_(ev);
          if (cid) {
            matched++;
            out.push('  ✓ ' + evYmd + '  "' + evTitle + '"  → candidate ' + cid +
                     (emails.length ? ' (via ' + emails.join(', ') + ')' : ' (via title name)'));
          } else {
            unmatched++;
            out.push('  ✗ ' + evYmd + '  "' + evTitle + '"  → NO candidate match' +
                     (emails.length ? ' (emails on event: ' + emails.join(', ') + ' not in All Candidates/Pipeline)'
                                    : ' (no candidate email in guests or description, and title name did not match)'));
          }
        });
        out.push('  ─ Calendar summary: ' + shown + ' interview event(s) in window, ' + matched + ' matched, ' + unmatched + ' unmatched');
      }
    } catch (e) {
      out.push('  ✗ Calendar error: ' + e.message);
    }
  }

  // ── 3. Existing worksheet rows + why the send step skips them ──
  out.push('');
  out.push('  ── EXISTING WORKSHEET ROWS (explains the "skipped" count) ──');
  var ws = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
  if (!ws || ws.getLastRow() < 2) {
    out.push('  ─ No worksheet rows yet.');
  } else {
    var wh = getHeaderRow_(ws);
    var wIdx = {}; wh.forEach(function (h, i) { wIdx[h] = i; });
    var wdata = ws.getRange(2, 1, ws.getLastRow() - 1, wh.length).getValues();
    var inWin = 0, past = 0, future = 0, alreadySent = 0;
    wdata.forEach(function (r) {
      var ymd = _ymd_(r[wIdx['Interview Date']]);
      var sent = String(r[wIdx['Email Status']]) === 'SENT';
      if (ymd < startYmd) past++;
      else if (ymd > endYmd) future++;
      else { inWin++; if (sent) alreadySent++; }
    });
    out.push('  ─ ' + wdata.length + ' worksheet row(s): ' + inWin + ' in window (' + alreadySent + ' already SENT), ' +
             past + ' past (skipped), ' + future + ' beyond window (skipped)');
    out.push('    A row is skipped by the send step when its Interview Date is outside ' + startYmd + '..' + endYmd +
             ', or its Email Status is already SENT.');
  }

  out.push('');
  out.push('  ── LIKELY FIX ──');
  if (!calId) {
    out.push('  Set INTERVIEW_CALENDAR_ID in Config to the interview calendar, then run pollCalendarBookings()');
    out.push('  (or "Generate & Send Upcoming Worksheets" again). That stamps the pipeline date columns and enables');
    out.push('  the calendar fallback so this week\'s 6 interviews are picked up.');
  } else {
    out.push('  Calendar is configured — check the ✗ lines above: either the booking dates are not in the pipeline');
    out.push('  "Booked" columns (run pollCalendarBookings) or the calendar guests do not match a candidate email.');
    out.push('  Force one with: generateWorksheetManual_("CANDIDATE_ID", "Live Interview (in-person)").');
  }
  var msg = out.join('\n');
  Logger.log(msg);
  toast_('Worksheet diagnosis logged — see execution log / return value', 'Recruiting OS', 8);
  return msg;
}

/**
 * Manually generate a worksheet for a specific candidate right now.
 * Call from the Apps Script editor when automatic detection doesn't fire.
 *
 * interviewType options:
 *   "Phone Screen (online)"
 *   "Live Interview (in-person)"
 *   "Working Interview (in-person)"
 *
 * Example:
 *   generateWorksheetManual_("FES-001", "Phone Screen (online)")
 */
function generateWorksheetManual_(candidateId, interviewType, interviewDateOverride) {
  if (!candidateId) { Logger.log('[WORKSHEET] generateWorksheetManual_: candidateId required'); return null; }
  var iType = interviewType || 'Live Interview (in-person)';
  var iDate = interviewDateOverride ? _coerceDate_(interviewDateOverride) : new Date();
  var ws = generateInterviewWorksheet_(candidateId, iType, iDate);
  if (!ws) { Logger.log('[WORKSHEET] generateWorksheetManual_: no worksheet generated for ' + candidateId); return null; }
  Logger.log('[WORKSHEET] generateWorksheetManual_: generated worksheet for ' + candidateId);
  // Immediately send it
  var result = sendTodayInterviewWorksheets(/*force=*/true);
  Logger.log('[WORKSHEET] sendTodayInterviewWorksheets after manual: ' + result);
  return ws;
}

/**
 * Resolve a calendar event to a Candidate ID. This is the single matcher used by
 * every calendar scan (worksheet generation AND pollCalendarBookings).
 *
 * Match order:
 *   1. Any email on the event — guests AND emails embedded in the description.
 *      Koalendar bookings do NOT add the candidate as a calendar guest; they put
 *      the email in the body ("Guest • Chris (cmcws22@gmail.com)"), so reading
 *      the description is essential.
 *   2. Candidate name parsed from the event title.
 *
 * Returns '' if nothing matches.
 */
function _findCandidateForEvent_(ev) {
  try {
    var emails = _eventCandidateEmails_(ev);
    for (var i = 0; i < emails.length; i++) {
      var cid = _findCandidateByEmail_(emails[i]);
      if (cid) return cid;
    }
  } catch (e) { logError_('_findCandidateForEvent_:email', e, '', 'WARN'); }
  try {
    return _findCandidateByEventTitle_(ev.getTitle() || '') || '';
  } catch (e2) { return ''; }
}

/**
 * Collect every candidate-looking email associated with an event: real guests
 * plus any address found in the event description (Koalendar puts it there).
 * Drops our own shop-domain addresses and calendar-resource ids, then de-dupes.
 */
function _eventCandidateEmails_(ev) {
  var out = [];
  try {
    var guests = ev.getGuestList(false) || [];
    guests.forEach(function (g) { var e = normalizeEmail_(g.getEmail()); if (e) out.push(e); });
  } catch (e) { /* ignore */ }
  try {
    var desc = String(ev.getDescription() || '');
    var re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, m;
    while ((m = re.exec(desc)) !== null) out.push(normalizeEmail_(m[0]));
  } catch (e2) { /* ignore */ }

  var skipDomain = String(CFG.get('COMPANY_EMAIL_DOMAIN', 'frankseuropeanservice.com')).toLowerCase();
  var seen = {}, res = [];
  out.forEach(function (e) {
    if (!e) return;
    if (e.indexOf('@group.calendar.google.com') !== -1) return;  // calendar resource id
    if (skipDomain && e.indexOf('@' + skipDomain) !== -1) return; // our own staff
    if (seen[e]) return;
    seen[e] = true;
    res.push(e);
  });
  return res;
}

/**
 * Extract the candidate name from a calendar event title and look them up.
 *
 * Handles common formats, including Koalendar's three-part titles where the
 * company name trails the candidate name:
 *   "Phone Screen — Chris — Frank's European Service"
 *   "Interview — ADAM HOLLAND SOSEBEE ()"
 *   "Interview — Christopher Magana"
 *   "Phone Screen — Jane Smith (Service Advisor)"
 *
 * Splits the title on em/en dashes (and space-hyphen-space), discards segments
 * that are phase labels or the shop name, and tries the remaining segment(s) as
 * the candidate name — both exact (_findCandidateByName_) and substring
 * (_findCandidateByNameInTitle_) matching.
 */
function _findCandidateByEventTitle_(title) {
  var raw = String(title || '');
  if (!raw) return '';
  var phaseOrCompanyRe = /(phone\s*screen|working\s*interview|live\s*interview|full\s*interview|interview|screen|frank'?s\s+european\s+service|frank'?s)/i;
  var segs = raw.split(/\s*[—–]\s*|\s+-\s+/)
                .map(function (s) { return s.replace(/\s*\(.*\)\s*$/, '').trim(); })
                .filter(Boolean);
  for (var i = 0; i < segs.length; i++) {
    if (phaseOrCompanyRe.test(segs[i])) continue;          // skip "Phone Screen", company name, etc.
    var cid = _findCandidateByName_(segs[i]);
    if (cid) return cid;
  }
  // Last resort: substring match of the whole title against "first last".
  return _findCandidateByNameInTitle_(raw) || '';
}

/**
 * Find a Candidate ID by full name. Searches Interview Pipeline then All Candidates.
 * Comparison is case-insensitive and normalizes internal whitespace.
 */
function _findCandidateByName_(fullName) {
  var target = String(fullName || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!target) return '';

  function searchSheet(shConst) {
    var sh = getSheetOrNull_(shConst);
    if (!sh || sh.getLastRow() < 2) return '';
    var headers = getHeaderRow_(sh);
    var hCid    = headers.indexOf('Candidate ID');
    if (hCid === -1) return '';

    // Collect name columns: Full Name, First Name + Last Name
    var hFull  = headers.indexOf('Full Name');
    var hFirst = headers.indexOf('First Name');
    var hLast  = headers.indexOf('Last Name');

    var data = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
    for (var i = 0; i < data.length; i++) {
      var cid = String(data[i][hCid] || '').trim();
      if (!cid) continue;

      var names = [];
      if (hFull  !== -1) names.push(String(data[i][hFull]  || ''));
      if (hFirst !== -1 && hLast !== -1)
        names.push((String(data[i][hFirst] || '') + ' ' + String(data[i][hLast] || '')).trim());

      for (var n = 0; n < names.length; n++) {
        var candidate = names[n].replace(/\s+/g, ' ').trim().toUpperCase();
        if (candidate && candidate === target) return cid;
      }
    }
    return '';
  }

  return searchSheet(SHEETS.INTERVIEW_PIPELINE) || searchSheet(SHEETS.ALL_CANDIDATES);
}

function _guessTypeFromTitle_(title) {
  var lc = (title || '').toLowerCase();
  if (lc.indexOf('working') !== -1) return 'Working Interview (in-person)';
  if (lc.indexOf('phone') !== -1 || lc.indexOf('screen') !== -1) return 'Phone Screen (online)';
  // Generic "Interview — Name" with no qualifier → treat as live in-person
  return 'Live Interview (in-person)';
}
