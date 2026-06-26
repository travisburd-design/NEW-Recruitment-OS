/**
 * 23_Backfill.gs
 * Frank's European Service — Recruiting OS
 *
 * One-shot helpers for migrating data from the prior system without
 * re-triggering any candidate-facing automation.
 *
 *   BACKFILL_assignCandidateIds()
 *     Walks All Candidates and Interview Pipeline. For every row that has
 *     an email but a blank Candidate ID, generates and writes the stable
 *     Candidate ID (same algorithm as live intake: MD5(email+role)).
 *     Idempotent. Sends nothing. Updates nothing else.
 *
 *   BACKFILL_promoteToPipeline(email)
 *     Adds a row to Interview Pipeline for a candidate that lives in
 *     All Candidates but isn't yet promoted. No-ops if already there.
 *
 *   BACKFILL_pasteFathomTranscript(email, phase, meetingDateStr, transcriptText, meetingTitle)
 *     Manually attach a transcript to a candidate by email. Archives to
 *     Master Transcript Archive with Source App="Fathom_Manual", then runs
 *     AI grading (if enabled). Use this for each Fathom interview you
 *     conducted under the previous version.
 *
 *   BACKFILL_dryRun()
 *     Read-only report. Tells you how many IDs would be assigned, how many
 *     pipeline rows would be added, etc. Nothing written.
 *
 *   BACKFILL_selfTest()
 *     Verifies the helpers are wired correctly. No data changes.
 *
 * SAFETY:
 *   None of these functions send candidate emails. SEND_ENABLED is not
 *   touched. Triggers do not fire from these helpers.
 *
 *   The auto-scoring pipeline (scorePreScreen_) is NOT called by backfill —
 *   so the system will not try to send phone_screen_booking emails to people
 *   who already received them from the prior version.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. ASSIGN CANDIDATE IDS
// ─────────────────────────────────────────────────────────────────────────────

function BACKFILL_assignCandidateIds() {
  return withLock_(function () {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var acResult = _assignIdsInSheet_(ac);
    var ipResult = _assignIdsInSheet_(ip);

    var msg = '[BACKFILL] assignCandidateIds — ' +
              'All Candidates: ' + JSON.stringify(acResult) + '  |  ' +
              'Interview Pipeline: ' + JSON.stringify(ipResult);
    Logger.log(msg);
    logEvent_('BACKFILL_ASSIGN_IDS', '', { allCandidates: acResult, interviewPipeline: ipResult });
    return msg;
  });
}

function _assignIdsInSheet_(sheet) {
  var headers = getHeaderRow_(sheet);
  var emailCol = headers.indexOf('Email');
  var roleCol  = headers.indexOf('Role');
  var cidCol   = headers.indexOf('Candidate ID');
  if (cidCol === -1) return { error: 'no Candidate ID column' };
  if (emailCol === -1) return { error: 'no Email column' };

  var last = sheet.getLastRow();
  if (last < 2) return { scanned: 0, assigned: 0, skipped: 0, noEmail: 0 };

  var data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  var assigned = 0, skipped = 0, noEmail = 0;
  var writes = []; // batch writes to avoid 1-cell-at-a-time slowness

  for (var i = 0; i < data.length; i++) {
    var existing = String(data[i][cidCol] || '').trim();
    if (existing) { skipped++; continue; }
    var email = normalizeEmail_(data[i][emailCol]);
    if (!email) { noEmail++; continue; }
    var role = roleCol >= 0 ? String(data[i][roleCol] || '').trim() : '';
    if (!role) role = 'Unknown';
    var cid = candidateIdFromEmail_(email, role);
    writes.push({ row: i + 2, value: cid });
    assigned++;
  }

  writes.forEach(function (w) {
    sheet.getRange(w.row, cidCol + 1).setValue(w.value);
  });

  return { scanned: data.length, assigned: assigned, skipped: skipped, noEmail: noEmail };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROMOTE A CANDIDATE TO INTERVIEW PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure an Interview Pipeline row exists for a candidate, built from the
 * All Candidates row. This is the single source of the pipeline-row schema —
 * scoring (06), backfill, and any other promoter route through it.
 *
 * Idempotent: returns false if the row already exists (the caller's status
 * writer handles field updates), or if the candidate / pipeline sheet is
 * missing. Returns true when it appends a new row.
 *
 * opts: { status, stage, nextAction, via }.
 */
function _ensureInterviewPipelineRow_(candidateId, opts) {
  opts = opts || {};
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return false;
  if (findRowsByColumnValue_(ip, 'Candidate ID', candidateId).length) return false;
  var c = _getCandidateRow_(candidateId);
  if (!c) return false;

  var presScore = c['Total Score'] || c['AI Score'] || '';
  appendRowByHeader_(ip, {
    'Date Promoted':       shopDateTime_(),
    'Days in Stage':       0,
    'Role':                c['Role'] || '',
    'First Name':          c['First Name'] || '',
    'Last Name':           c['Last Name'] || '',
    'Score':               presScore,
    'Email':               c['Email'] || '',
    'Phone':               c['Phone'] || '',
    'Stage':               opts.stage || 'Pre-screen scored — review',
    'Candidate ID':        candidateId,
    'Full Name':           String((c['First Name'] || '') + ' ' + (c['Last Name'] || '')).trim(),
    'Status':              opts.status || c['Status'] || STATUS.MANUAL_REVIEW,
    'Hiring Manager':      c['Hiring Manager'] || CFG.get('HIRING_MANAGER_NAME'),
    'Pre-Screen Score':    presScore,
    'Risk Score':          c['Risk Score'] || '',
    'Notes / Next Action': opts.nextAction || '',
    'Last Updated':        shopDateTime_(),
    'Notes':               ''
  });
  logEvent_('PIPELINE_AUTO_PROMOTED', candidateId, { status: opts.status || '', via: opts.via || 'unknown' });
  return true;
}

/**
 * Adds a row to Interview Pipeline based on the All Candidates row.
 * Sets Status = MANUAL_REVIEW so manager triages via dropdown.
 * Idempotent — does nothing if already in pipeline.
 *
 * Pass an email OR a Candidate ID.
 */
function BACKFILL_promoteToPipeline(emailOrCandidateId) {
  return withLock_(function () {
    var target = String(emailOrCandidateId || '').trim();
    if (!target) throw new Error('BACKFILL_promoteToPipeline: pass an email or Candidate ID');

    var c = null;
    if (target.indexOf('@') !== -1) {
      var cid = _findCandidateByEmail_(target);
      if (cid) c = _getCandidateRow_(cid);
    } else {
      c = _getCandidateRow_(target);
    }
    if (!c) throw new Error('BACKFILL_promoteToPipeline: candidate not found: ' + target);

    var created = _ensureInterviewPipelineRow_(c['Candidate ID'], {
      status:     STATUS.MANUAL_REVIEW,
      stage:      'Backfilled — review',
      nextAction: '(backfilled ' + shopDate_() + ' — manager to triage)',
      via:        'backfill'
    });
    if (!created) return '[BACKFILL] already in pipeline: ' + c['Candidate ID'];

    logEvent_('BACKFILL_PROMOTED', c['Candidate ID'], { email: c['Email'], role: c['Role'] });
    return '[BACKFILL] promoted to Interview Pipeline: ' + c['Candidate ID'];
  });
}

/** Bulk promote: every candidate in All Candidates whose status indicates they've moved beyond intake. */
function BACKFILL_bulkPromote() {
  return withLock_(function () {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var last = ac.getLastRow();
    if (last < 2) return '[BACKFILL] All Candidates empty';
    var headers = getHeaderRow_(ac);
    var hStatus = headers.indexOf('Status');
    var hCid    = headers.indexOf('Candidate ID');
    var hEmail  = headers.indexOf('Email');
    if (hStatus === -1 || hCid === -1) throw new Error('BACKFILL_bulkPromote: All Candidates missing Status or Candidate ID column');

    var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
    var skipStatuses = { '': 1, 'NEW': 1, 'ARCHIVED': 1, 'REJECTED': 1, 'HIRED': 1 };
    var promoted = 0, already = 0, skipped = 0, noId = 0;

    for (var i = 0; i < data.length; i++) {
      var st  = String(data[i][hStatus] || '').trim().toUpperCase();
      var cid = String(data[i][hCid] || '').trim();
      if (!cid) { noId++; continue; }
      if (skipStatuses[st]) { skipped++; continue; }
      try {
        var r = BACKFILL_promoteToPipeline(cid);
        if (r.indexOf('already in pipeline') !== -1) already++;
        else promoted++;
      } catch (e) {
        skipped++;
        logError_('BACKFILL_bulkPromote', e, cid, 'WARN');
      }
    }
    var msg = '[BACKFILL] bulkPromote — scanned=' + data.length + ' promoted=' + promoted +
              ' alreadyInPipeline=' + already + ' skipped=' + skipped + ' noId=' + noId;
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PASTE A FATHOM TRANSCRIPT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach a Fathom transcript to a candidate by email.
 *
 *   BACKFILL_pasteFathomTranscript(
 *     'candidate@example.com',
 *     'PhoneScreen',             // or 'FullInterview' or 'WorkingInterview'
 *     '2026-05-12',              // meeting date (any date-parseable string)
 *     'Travis: Hey John, thanks for coming in. So tell me about your last...',
 *     'Phone Screen with John Smith — Fathom recap'  // optional title
 *   )
 *
 * Returns the new Master Transcript Archive row number.
 * AI grades automatically if AI_GRADING_ENABLED=TRUE.
 */
function BACKFILL_pasteFathomTranscript(candidateEmail, phase, meetingDateStr, transcriptText, meetingTitle) {
  return withLock_(function () {
    if (!candidateEmail) throw new Error('pasteFathomTranscript: candidateEmail required');
    if (!transcriptText) throw new Error('pasteFathomTranscript: transcriptText required');
    phase = String(phase || 'FullInterview').trim();
    if (['PhoneScreen', 'FullInterview', 'WorkingInterview'].indexOf(phase) === -1) {
      throw new Error('pasteFathomTranscript: phase must be PhoneScreen | FullInterview | WorkingInterview');
    }

    var cid = _findCandidateByEmail_(candidateEmail);
    if (!cid) throw new Error('pasteFathomTranscript: candidate not found in pipeline/all candidates: ' + candidateEmail);
    var candidate = _getCandidateRow_(cid);
    if (!candidate) throw new Error('pasteFathomTranscript: candidate row vanished mid-call: ' + cid);

    var meetingDate = meetingDateStr ? shopDate_(_coerceDate_(meetingDateStr)) : shopDate_();
    var rowData = {
      'Otter Source ID':  'FATHOM-MANUAL-' + Utilities.getUuid().substring(0, 8).toUpperCase(),
      'Meeting Title':    String(meetingTitle || (phase + ' — ' + (candidate['First Name'] || '') + ' ' + (candidate['Last Name'] || ''))).trim(),
      'Meeting Date':     meetingDate,
      'Transcript Text':  String(transcriptText),
      'Transcript URL':   '',
      'Audio URL':        '',
      'Participants':     (candidate['Email'] || '') + ', ' + CFG.get('HIRING_MANAGER_EMAIL', ''),
      'Organizer Email':  CFG.get('HIRING_MANAGER_EMAIL', ''),
      'Calendar Event ID':'',
      'Source App':       'Fathom_Manual',
      'Raw Payload':      '',
      'Processed Status': 'NEW'
    };

    // Archive (uses 08_Otter_Transcripts._archiveTranscript_)
    var archiveRow = _archiveTranscript_(rowData, cid, candidate, phase, {
      method: MATCH_METHOD.MANUAL, confidence: 100
    });

    logEvent_('FATHOM_TRANSCRIPT_PASTED', cid, {
      archiveRow: archiveRow, phase: phase, chars: transcriptText.length, meetingDate: meetingDate
    });

    // Grade immediately (if enabled)
    if (CFG.getBool('AI_GRADING_ENABLED', true) && typeof gradeTranscript_ === 'function') {
      try {
        var graded = gradeTranscript_(archiveRow);
        Logger.log('[BACKFILL] graded archive row ' + archiveRow + ': ' + JSON.stringify(graded));
      } catch (e) {
        logError_('BACKFILL:pasteFathomTranscript:grade', e, cid, 'WARN');
      }
    }

    return '[BACKFILL] transcript archived row=' + archiveRow + ' for ' + cid + ' (phase=' + phase + ')';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. DRY RUN — see what would happen before committing
// ─────────────────────────────────────────────────────────────────────────────

function BACKFILL_dryRun() {
  var out = ['[BACKFILL] dryRun — read-only inspection'];
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);

  function inspect(sh, label) {
    if (!sh) { out.push('  ✗ ' + label + ' sheet missing'); return; }
    var last = sh.getLastRow();
    if (last < 2) { out.push('  ─ ' + label + ': empty'); return; }
    var headers = getHeaderRow_(sh);
    var iE = headers.indexOf('Email');
    var iC = headers.indexOf('Candidate ID');
    if (iE === -1 || iC === -1) {
      out.push('  ✗ ' + label + ': missing Email or Candidate ID column');
      return;
    }
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var total = 0, needsId = 0, noEmail = 0;
    for (var i = 0; i < data.length; i++) {
      total++;
      var email = normalizeEmail_(data[i][iE]);
      var cid   = String(data[i][iC] || '').trim();
      if (!email) noEmail++;
      else if (!cid) needsId++;
    }
    out.push('  ─ ' + label.padEnd(22, ' ') + ' total=' + total +
             ' needs Candidate ID=' + needsId + ' noEmail(skip)=' + noEmail);
  }

  inspect(ac, 'All Candidates');
  inspect(ip, 'Interview Pipeline');

  // Promotable count
  if (ac) {
    var headers = getHeaderRow_(ac);
    var hStatus = headers.indexOf('Status');
    var hCid    = headers.indexOf('Candidate ID');
    if (hStatus !== -1 && hCid !== -1) {
      var data = ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues();
      var skipStatuses = { '': 1, 'NEW': 1, 'ARCHIVED': 1, 'REJECTED': 1, 'HIRED': 1 };
      var promotable = 0;
      data.forEach(function (r) {
        var st = String(r[hStatus] || '').trim().toUpperCase();
        var cid = String(r[hCid] || '').trim();
        if (cid && !skipStatuses[st]) promotable++;
      });
      out.push('  ─ Promotable to pipeline : ' + promotable + ' (non-terminal status, has Candidate ID)');
    }
  }

  out.push('');
  out.push('  Recommended sequence:');
  out.push('    1) BACKFILL_assignCandidateIds()');
  out.push('    2) BACKFILL_bulkPromote()');
  out.push('    3) For each Fathom transcript: BACKFILL_pasteFathomTranscript(...)');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. AI-SCORE BACKFILLED CANDIDATES (no emails — pure scoring only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-score every candidate that has a Pre-Screen response but no AI Score.
 *
 * Bounded to 50 candidates per run to stay under Apps Script's execution
 * limit (each Gemini call ~1-2s; 50 ≈ 90s). Run again to continue.
 *
 *   - Reads All Candidates → finds rows with Candidate ID + matching
 *     Pre-Screen response in Form Responses 1 + no AI Score yet.
 *   - For each, calls Gemini with the prescreen prompt.
 *   - Writes AI Score, Risk Score, Total Score, Score Tier to the candidate row.
 *   - Mirrors to Interview Pipeline if the candidate is also there.
 *   - DOES NOT change Status. DOES NOT queue any emails. DOES NOT dispatch routing.
 *     Backfilled candidates were already processed by the old system; we only
 *     attach a fresh AI score for visibility.
 */
function BACKFILL_scoreAllPending() {
  return withLock_(function () {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var last = ac.getLastRow();
    if (last < 2) return '[BACKFILL] All Candidates empty';

    var headers = getHeaderRow_(ac);
    var hCid     = headers.indexOf('Candidate ID');
    var hEmail   = headers.indexOf('Email');
    var hAiScore = headers.indexOf('AI Score');
    if (hCid === -1)     throw new Error('BACKFILL_scoreAllPending: All Candidates missing Candidate ID column');
    if (hEmail === -1)   throw new Error('BACKFILL_scoreAllPending: All Candidates missing Email column');
    if (hAiScore === -1) throw new Error('BACKFILL_scoreAllPending: All Candidates missing AI Score column');

    if (!hasSecret_(SECRETS.GEMINI_API_KEY)) {
      return '[BACKFILL] GEMINI_API_KEY not set in Script Properties — cannot score';
    }

    var MAX_PER_RUN = 50;
    var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, scored: 0, alreadyScored: 0, noPreScreen: 0, noEmail: 0, noId: 0, errors: 0 };

    for (var i = 0; i < data.length && summary.scored < MAX_PER_RUN; i++) {
      summary.scanned++;
      var cid = String(data[i][hCid] || '').trim();
      if (!cid) { summary.noId++; continue; }

      var existing = data[i][hAiScore];
      if (existing !== '' && existing !== null && existing !== undefined && String(existing).trim() !== '') {
        summary.alreadyScored++;
        continue;
      }

      var email = String(data[i][hEmail] || '').trim();
      if (!email) { summary.noEmail++; continue; }

      // Confirm a pre-screen response exists for this email before spending an API call
      if (!_findPreScreenRow_(email)) { summary.noPreScreen++; continue; }

      try {
        var r = _scoreForBackfill_(cid);
        if (r) summary.scored++; else summary.errors++;
      } catch (e) {
        summary.errors++;
        logError_('BACKFILL_scoreAllPending:' + cid, e, cid, 'WARN');
      }
    }

    var hitMax = (summary.scored >= MAX_PER_RUN);
    var msg = '[BACKFILL] scoreAllPending — ' + JSON.stringify(summary) +
              (hitMax ? '  (HIT MAX — run again to continue)' : '');
    Logger.log(msg);
    toast_('Scored ' + summary.scored + ' candidates' +
           (hitMax ? ' — run again for more' : ''), 'Recruiting OS', 8);
    logEvent_('BACKFILL_SCORE_RUN', '', summary);
    return msg;
  });
}

/** Score one specific backfilled candidate. Same no-emails behavior as bulk. */
function BACKFILL_scoreCandidate(candidateId) {
  return withLock_(function () { return _scoreForBackfill_(candidateId); });
}

/**
 * Mimics scorePreScreen_ but ONLY writes AI scores. No routing decision,
 * no email dispatch, no Status change. Safe for backfilled candidates who
 * were already processed by the prior system.
 */
function _scoreForBackfill_(candidateId) {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var candidate = _getCandidateRow_(candidateId);
  if (!candidate) { logError_('_scoreForBackfill_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return null; }

  var psRow = _findPreScreenRow_(candidate['Email']);
  if (!psRow) return null; // caller already filtered, but defensive

  var payload = _buildPreScreenPayload_(psRow);
  if (Object.keys(payload).length < 3) {
    logError_('_scoreForBackfill_', 'payload too sparse for ' + candidate['Email'], candidateId, 'WARN');
    return null;
  }

  var prompt = _loadAiPrompt_('prescreen');
  if (!prompt) { logError_('_scoreForBackfill_', 'prescreen prompt missing', candidateId); return null; }

  var roleRule = _getRoleRule_(candidate['Role']);
  var promptText = renderMerge_(prompt['Prompt Body'], {
    Payload:          JSON.stringify(payload, null, 2),
    RoleName:         candidate['Role'] || '',
    RoleRequirements: (roleRule && roleRule['Notes']) || '(see Role Rules)',
    Provider:         CFG.get('AI_PROVIDER', 'gemini'),
    Model:            CFG.get('GEMINI_MODEL')
  });

  var result = _geminiGradeJson_('prescreen_backfill', candidateId, promptText);
  if (!result.ok) {
    // Never leave a backfilled candidate in an invisible failed state — flag for
    // manual review so they surface in the Daily Digest and can be retried.
    logError_('_scoreForBackfill_:aiFailed', result.error || 'unknown', candidateId, 'WARN');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.MANUAL_REVIEW,
      'Notes':        truncate_('AI scoring failed: ' + (result.error || ''), 300),
      'Last Updated': shopDateTime_()
    });
    return null;
  }

  var ai = validatePreScreenGradeJson_(result.data);
  var risk  = ai.ai_risk_score;
  // Missing numeric score → never write a misleading 0 / "Hard Reject" tier.
  // Leave score blank and flag for manual review so the candidate isn't buried.
  if (!ai.ai_score_present) {
    logError_('_scoreForBackfill_:noScore', 'AI returned no numeric score — left blank for manual review', candidateId, 'WARN');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'AI Score':     '',
      'Risk Score':   risk,
      'Total Score':  '',
      'Score Tier':   'Review',
      'Status':       STATUS.MANUAL_REVIEW,
      'Last Updated': shopDateTime_(),
      'Notes':        truncate_('[backfill] AI returned no numeric score — manual review. ' + (ai.summary || ''), 500)
    });
    logEvent_('BACKFILL_SCORE_MISSING', candidateId, { risk: risk, role: candidate['Role'] || '' });
    return { candidateId: candidateId, score: null, risk: risk, tier: 'Review', scoreMissing: true };
  }
  var score = ai.ai_score;
  var tier  = _scoreToTier_(score);

  // Write to All Candidates — scores only, never Status
  updateRowWhere_(ac, 'Candidate ID', candidateId, {
    'AI Score':                score,
    'Risk Score':              risk,
    'Total Score':             score,
    'Score Tier':              tier,
    'AI-Authored Likelihood':  ai.ai_authored_likelihood || 0,
    'AI-Authored Reasoning':   truncate_(ai.ai_authored_reasoning || '', 300),
    'Last Updated':            shopDateTime_(),
    'Notes':                   truncate_('[backfill score] ' + (ai.summary || ''), 500)
  });

  // Mirror to Interview Pipeline if candidate exists there
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    var ipHits = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
    if (ipHits.length) {
      var ipUpdates = { 'Last Updated': shopDateTime_() };
      if (getColIndex_(ip, 'Pre-Screen Score'))   ipUpdates['Pre-Screen Score']   = score;
      if (getColIndex_(ip, 'Risk Score'))         ipUpdates['Risk Score']         = risk;
      if (getColIndex_(ip, 'Score'))              ipUpdates['Score']              = score;
      updateRowWhere_(ip, 'Candidate ID', candidateId, ipUpdates);
    }
  }

  logEvent_('BACKFILL_SCORED', candidateId, {
    score: score, risk: risk, tier: tier, role: candidate['Role'] || ''
  });

  return { candidateId: candidateId, score: score, risk: risk, tier: tier };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONVERT PRE-SCREEN RESPONSES TO CANDIDATES (no emails)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walks every row in Form Responses 5 (Pre-Screen) and runs the standard
 * intake flow against it — creates the candidate row in All Candidates,
 * generates the Candidate ID, and scores via Gemini. But it disables every
 * candidate-facing email flag for the duration of the run so NO candidate
 * email is sent or queued. Restores all flags before returning (even on error).
 *
 * Use this AFTER you've pasted historical Pre-Screen responses into Form
 * Responses 5 and want them turned into real, scored candidates in All
 * Candidates.
 *
 * Idempotent — _processPreScreenRow_ dedupes by Candidate ID, so re-running
 * doesn't create duplicates.
 */
function BACKFILL_processPreScreensSafely() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_PRESCREEN);
    var last = sh.getLastRow();
    if (last < 2) return '[BACKFILL] no Pre-Screen rows to process';

    // Snapshot every email-causing flag so we can restore exactly
    var snap = {
      SEND_ENABLED:              CFG.get('SEND_ENABLED'),
      SEND_ACKNOWLEDGMENT_EMAIL: CFG.get('SEND_ACKNOWLEDGMENT_EMAIL'),
      AUTO_BOOKING_ENABLED:      CFG.get('AUTO_BOOKING_ENABLED'),
      AUTO_REJECTION_ENABLED:    CFG.get('AUTO_REJECTION_ENABLED'),
      SEND_REJECTION_EMAIL:      CFG.get('SEND_REJECTION_EMAIL'),
      AI_GRADING_ENABLED:        CFG.get('AI_GRADING_ENABLED')
    };

    // Force everything off except AI grading (we still want scores)
    CFG.set('SEND_ENABLED',              'FALSE');
    CFG.set('SEND_ACKNOWLEDGMENT_EMAIL', 'FALSE');
    CFG.set('AUTO_BOOKING_ENABLED',      'FALSE');
    CFG.set('AUTO_REJECTION_ENABLED',    'FALSE');
    CFG.set('SEND_REJECTION_EMAIL',      'FALSE');
    CFG.reset();

    var MAX_PER_RUN = 30; // each row may call Gemini ~1-2s
    var summary = { scanned: 0, processed: 0, skipped: 0, errors: 0 };

    try {
      for (var r = 2; r <= last && summary.processed < MAX_PER_RUN; r++) {
        summary.scanned++;
        try {
          var cid = _processPreScreenRow_(r, /*fromTrigger=*/false);
          if (cid) summary.processed++; else summary.skipped++;
        } catch (e) {
          summary.errors++;
          logError_('BACKFILL_processPreScreensSafely:row' + r, e, '', 'WARN');
        }
      }
    } finally {
      // ALWAYS restore flags — even if something threw
      Object.keys(snap).forEach(function (k) {
        CFG.set(k, snap[k] || '');
      });
      CFG.reset();
    }

    // Belt-and-suspenders: cancel any email rows that might have leaked through
    var cancelled = _cancelAllBackfillBlockedRows_();

    var hitMax = (summary.processed >= MAX_PER_RUN);
    var msg = '[BACKFILL] processPreScreensSafely — ' + JSON.stringify(summary) +
              '  cancelledEmailRows=' + cancelled +
              (hitMax ? '  (HIT MAX — run again to continue)' : '');
    Logger.log(msg);
    toast_('Processed ' + summary.processed + ' pre-screens (no emails sent)' +
           (hitMax ? ' — run again for more' : ''), 'Recruiting OS', 8);
    logEvent_('BACKFILL_PRESCREEN_RUN', '', summary);
    return msg;
  });
}

/** Cancels any PENDING or BLOCKED queue row created in the last 10 minutes — safety net. */
function _cancelAllBackfillBlockedRows_() {
  var sh = getSheet_(SHEETS.EMAIL_QUEUE);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);
  var hStatus  = headers.indexOf('Status');
  var hQid     = headers.indexOf('Queue ID');
  var hCreated = headers.indexOf('Created At');
  if (hStatus === -1 || hQid === -1 || hCreated === -1) return 0;

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes ago
  var cancelled = 0;
  for (var i = 0; i < data.length; i++) {
    var st = String(data[i][hStatus]);
    if (st !== 'PENDING' && st !== 'BLOCKED') continue;
    var created = _coerceDate_(data[i][hCreated]).getTime();
    if (created < cutoff) continue;
    var qid = String(data[i][hQid]);
    if (cancelQueuedEmail_(qid, 'backfill cleanup — auto-cancel')) cancelled++;
  }
  return cancelled;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. BACKFILL REVIEW QUEUE + CANDIDATE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a row to the Backfill Review Queue (deduped by Source Sheet + Source
 * Row). Used whenever a source row cannot be resolved to exactly one candidate.
 */
function _queueBackfillReview_(entry) {
  var sh = getSheetOrNull_(SHEETS.BACKFILL_REVIEW);
  if (!sh) return false;
  // Dedupe: same Source Sheet + Source Row already queued (and unresolved)?
  var last = sh.getLastRow();
  if (last >= 2) {
    var headers = getHeaderRow_(sh);
    var hSheet = headers.indexOf('Source Sheet');
    var hRow   = headers.indexOf('Source Row');
    var hRes   = headers.indexOf('Resolved Candidate ID');
    if (hSheet !== -1 && hRow !== -1) {
      var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
      for (var i = 0; i < data.length; i++) {
        if (String(data[i][hSheet]) === String(entry.sourceSheet || '') &&
            String(data[i][hRow]) === String(entry.sourceRow || '') &&
            (hRes === -1 || !String(data[i][hRes] || '').trim())) {
          return false; // already queued and not yet resolved
        }
      }
    }
  }
  appendRowByHeader_(sh, {
    'Timestamp':            shopDateTime_(),
    'Source Sheet':         entry.sourceSheet || '',
    'Source Row':           entry.sourceRow || '',
    'Candidate Hint':       entry.hint || '',
    'Email':                entry.email || '',
    'Phone':                entry.phone || '',
    'Role':                 entry.role || '',
    'Issue':                entry.issue || '',
    'Possible Matches':     entry.possibleMatches || '',
    'Resolution Needed':    entry.resolutionNeeded || 'Identify the correct candidate',
    'Resolved Candidate ID': '',
    'Resolved By':          '',
    'Resolved At':          '',
    'Notes':                entry.notes || ''
  });
  return true;
}

/**
 * Resolve a candidate from a hint using the backfill matching rules, in order:
 *   1) Candidate ID  2) Email  3) Phone  4) Full Name + Role  5) Full Name (unique)
 * @return {object} { cid:string, matches:string[], method:string }
 *   cid is '' when zero or multiple matches were found (caller routes to review).
 */
function _resolveBackfillCandidate_(hint) {
  hint = hint || {};
  if (hint.candidateId) {
    var byId = _getCandidateRow_(String(hint.candidateId).trim());
    if (byId) return { cid: String(hint.candidateId).trim(), matches: [String(hint.candidateId).trim()], method: 'id' };
  }

  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return { cid: '', matches: [], method: 'none' };
  var last = ac.getLastRow();
  if (last < 2) return { cid: '', matches: [], method: 'none' };
  var headers = getHeaderRow_(ac);
  var hCid   = headers.indexOf('Candidate ID');
  var hEmail = headers.indexOf('Email');
  var hPhone = headers.indexOf('Phone');
  var hFirst = headers.indexOf('First Name');
  var hLast  = headers.indexOf('Last Name');
  var hRole  = headers.indexOf('Role');
  if (hCid === -1) return { cid: '', matches: [], method: 'none' };
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();

  function collect(predicate) {
    var ids = [];
    for (var i = 0; i < data.length; i++) {
      var cid = String(data[i][hCid] || '').trim();
      if (cid && predicate(data[i]) && ids.indexOf(cid) === -1) ids.push(cid);
    }
    return ids;
  }

  var email = normalizeEmail_(hint.email);
  if (email && hEmail !== -1) {
    var byEmail = collect(function (r) { return normalizeEmail_(r[hEmail]) === email; });
    if (byEmail.length === 1) return { cid: byEmail[0], matches: byEmail, method: 'email' };
    if (byEmail.length > 1)  return { cid: '', matches: byEmail, method: 'email' };
  }

  var phone = normalizePhone_(hint.phone);
  if (phone && hPhone !== -1) {
    var byPhone = collect(function (r) { return normalizePhone_(r[hPhone]) === phone; });
    if (byPhone.length === 1) return { cid: byPhone[0], matches: byPhone, method: 'phone' };
    if (byPhone.length > 1)  return { cid: '', matches: byPhone, method: 'phone' };
  }

  var name = String(hint.name || '').trim().toLowerCase();
  if (name && hFirst !== -1 && hLast !== -1) {
    var role = String(hint.role || '').trim().toLowerCase();
    function fullName(r) { return String((r[hFirst] || '') + ' ' + (r[hLast] || '')).trim().toLowerCase(); }
    if (role && hRole !== -1) {
      var byNameRole = collect(function (r) { return fullName(r) === name && String(r[hRole] || '').trim().toLowerCase() === role; });
      if (byNameRole.length === 1) return { cid: byNameRole[0], matches: byNameRole, method: 'name+role' };
      if (byNameRole.length > 1)  return { cid: '', matches: byNameRole, method: 'name+role' };
    }
    var byName = collect(function (r) { return fullName(r) === name; });
    if (byName.length === 1) return { cid: byName[0], matches: byName, method: 'name' };
    if (byName.length > 1)  return { cid: '', matches: byName, method: 'name' };
  }

  return { cid: '', matches: [], method: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. PUBLIC BACKFILL REPAIR API (canonical names used by the menu)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure every All Candidates row has a Candidate ID and a presence in the
 * Interview Pipeline. Rows that cannot be resolved (no email, no phone, no
 * unique name match) are routed to the Backfill Review Queue instead of being
 * scored with an undefined ID. Returns a summary object.
 */
function backfillCandidatesFromCurrentSheets() {
  return withLock_(function () {
    var summary = { idsAssigned: 0, promoted: 0, queuedForReview: 0 };

    // 1) Assign stable Candidate IDs wherever we have an email.
    var idMsg = (function () {
      var ac = getSheet_(SHEETS.ALL_CANDIDATES);
      var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
      var a = _assignIdsInSheet_(ac);
      var b = _assignIdsInSheet_(ip);
      summary.idsAssigned = (a.assigned || 0) + (b.assigned || 0);
      return { ac: a, ip: b };
    })();

    // 2) Promote non-terminal candidates into the pipeline.
    try { BACKFILL_bulkPromote(); } catch (e) { logError_('backfillCandidatesFromCurrentSheets:promote', e, '', 'WARN'); }

    // 3) Queue rows that still have no Candidate ID (could not be resolved).
    summary.queuedForReview = _queueUnresolvedCandidateRows_();

    var msg = '[BACKFILL] candidatesFromCurrentSheets — ' + JSON.stringify(summary) +
              '  (ids: ' + JSON.stringify(idMsg) + ')';
    Logger.log(msg);
    logEvent_('BACKFILL_CANDIDATES_REPAIR', '', summary);
    return summary;
  });
}

/** Scan All Candidates for rows with no Candidate ID; try to resolve, else queue. */
function _queueUnresolvedCandidateRows_() {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var last = ac.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(ac);
  var hCid   = headers.indexOf('Candidate ID');
  var hEmail = headers.indexOf('Email');
  var hPhone = headers.indexOf('Phone');
  var hFirst = headers.indexOf('First Name');
  var hLast  = headers.indexOf('Last Name');
  var hRole  = headers.indexOf('Role');
  if (hCid === -1) return 0;
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var queued = 0;

  for (var i = 0; i < data.length; i++) {
    var cid = String(data[i][hCid] || '').trim();
    if (cid) continue; // already identified
    var name = String((hFirst !== -1 ? data[i][hFirst] : '') + ' ' + (hLast !== -1 ? data[i][hLast] : '')).trim();
    var email = hEmail !== -1 ? String(data[i][hEmail] || '').trim() : '';
    var phone = hPhone !== -1 ? String(data[i][hPhone] || '').trim() : '';
    var role  = hRole !== -1 ? String(data[i][hRole] || '').trim() : '';

    var res = _resolveBackfillCandidate_({ email: email, phone: phone, name: name, role: role });
    if (res.cid) {
      ac.getRange(i + 2, hCid + 1).setValue(res.cid); // adopt the resolved ID
      continue;
    }
    var queuedNow = _queueBackfillReview_({
      sourceSheet: SHEETS.ALL_CANDIDATES,
      sourceRow:   i + 2,
      hint:        name,
      email:       email,
      phone:       phone,
      role:        role,
      issue:       res.matches.length > 1 ? 'Multiple possible matches' : 'No email/phone/unique-name to assign a Candidate ID',
      possibleMatches: res.matches.join(', '),
      resolutionNeeded: 'Set the correct Candidate ID, then re-run Run Full Backfill Repair'
    });
    if (queuedNow) queued++;
  }
  return queued;
}

/** Score every candidate that has a Pre-Screen response but no AI Score yet. */
function backfillMissingCandidateScores() {
  return BACKFILL_scoreAllPending();
}

/**
 * Re-grade candidates whose AI grade failed (pre-screen) and grade any
 * transcripts that are still missing an AI score.
 */
function backfillMissingAiGrades() {
  var out = [];
  try { out.push(retryFailedAiGrades()); }
  catch (e) { out.push('retryFailedAiGrades error: ' + e.message); logError_('backfillMissingAiGrades:prescreen', e, '', 'WARN'); }
  if (typeof gradePendingTranscripts === 'function') {
    try { out.push(gradePendingTranscripts()); }
    catch (e) { out.push('gradePendingTranscripts error: ' + e.message); logError_('backfillMissingAiGrades:transcripts', e, '', 'WARN'); }
  }
  var msg = '[BACKFILL] missingAiGrades — ' + out.join(' | ');
  Logger.log(msg);
  return msg;
}

/** Compute final recommendations for every candidate with score/risk data. */
function backfillMissingRecommendations() {
  return updateRecommendationEngineForAll();
}

/**
 * One-button repair. Runs the full backfill sequence in dependency order and
 * logs a single consolidated result. Safe to re-run; every step is idempotent.
 *
 * Order: headers/sheets → role normalization (if present) → Candidate IDs +
 * pipeline → pre-screen scores → AI grade recovery → recommendations.
 */
function runFullBackfillRepair() {
  var report = ['[BACKFILL] runFullBackfillRepair — ' + shopDateTime_()];
  var counts = {
    candidatesScanned: 0, candidatesRepaired: 0, candidatesScored: 0,
    candidatesAiGraded: 0, candidatesMissingData: 0, candidatesFailed: 0,
    candidatesQueuedForReview: 0
  };

  function step(label, fn) {
    try { var r = fn(); report.push('  ✓ ' + label + ' → ' + (typeof r === 'string' ? r : JSON.stringify(r))); return r; }
    catch (e) { report.push('  ✗ ' + label + ' FAILED: ' + e.message); logError_('runFullBackfillRepair:' + label, e, '', 'ERROR'); return null; }
  }

  // 1) Headers / sheets (creates Backfill Review Queue + any missing tabs/columns).
  if (typeof repairSystem === 'function') step('repairSystem (headers/validations)', function () { return repairSystem(); });

  // 2) Role normalization — only if Blocker 4 has landed.
  if (typeof runRoleNormalizationRepair === 'function') step('runRoleNormalizationRepair', function () { return runRoleNormalizationRepair(); });

  // 3) Candidate IDs + pipeline presence (+ review queue for unresolved rows).
  var candRepair = step('backfillCandidatesFromCurrentSheets', backfillCandidatesFromCurrentSheets);
  if (candRepair && typeof candRepair === 'object') {
    counts.candidatesRepaired += (candRepair.idsAssigned || 0) + (candRepair.promoted || 0);
    counts.candidatesQueuedForReview += (candRepair.queuedForReview || 0);
  }

  // 4) Pre-screen scores for candidates with data but no score.
  var scoreMsg = step('backfillMissingCandidateScores', backfillMissingCandidateScores);
  var scoreSummary = _extractJsonFromMsg_(scoreMsg);
  if (scoreSummary) {
    counts.candidatesScanned     += scoreSummary.scanned || 0;
    counts.candidatesScored      += scoreSummary.scored || 0;
    counts.candidatesMissingData += (scoreSummary.noPreScreen || 0) + (scoreSummary.noEmail || 0) + (scoreSummary.noId || 0);
    counts.candidatesFailed      += scoreSummary.errors || 0;
  }

  // 5) Recover failed AI grades + grade pending transcripts.
  var aiMsg = step('backfillMissingAiGrades', backfillMissingAiGrades);
  var aiSummary = _extractJsonFromMsg_(aiMsg);
  if (aiSummary) counts.candidatesAiGraded += (aiSummary.recovered || 0) + (aiSummary.graded || 0);

  // 6) Recommendations.
  step('backfillMissingRecommendations', backfillMissingRecommendations);

  report.push('  ── RESULTS ──');
  report.push('     candidates scanned        : ' + counts.candidatesScanned);
  report.push('     candidates repaired       : ' + counts.candidatesRepaired);
  report.push('     candidates scored         : ' + counts.candidatesScored);
  report.push('     candidates AI graded      : ' + counts.candidatesAiGraded);
  report.push('     candidates missing data   : ' + counts.candidatesMissingData);
  report.push('     candidates failed         : ' + counts.candidatesFailed);
  report.push('     candidates queued (review): ' + counts.candidatesQueuedForReview);

  var msg = report.join('\n');
  Logger.log(msg);
  logEvent_('BACKFILL_FULL_REPAIR', '', counts);
  toast_('Full backfill repair complete — see log + Backfill Review Queue', 'Recruiting OS', 8);
  return msg;
}

/** Pull the first balanced {...} JSON object out of a status string. */
function _extractJsonFromMsg_(msg) {
  if (!msg || typeof msg !== 'string') return null;
  var first = msg.indexOf('{');
  if (first === -1) return null;
  var depth = 0;
  for (var i = first; i < msg.length; i++) {
    if (msg[i] === '{') depth++;
    else if (msg[i] === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(msg.substring(first, i + 1)); } catch (e) { return null; }
    } }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. IMPORT PRE-SCREEN / PHONE-SCREEN TRANSCRIPTS FROM A SHEET TAB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-import interview transcripts pasted into a tab named "Backfill
 * Transcripts" with columns: Date, Name, Email, Transcript. For each row with
 * a real transcript it resolves the candidate (email → name), archives it to
 * the Master Transcript Archive (Phase=PhoneScreen, Source App=Fathom_Backfill)
 * and AI-grades it. Unmatched/ambiguous rows go to the Backfill Review Queue.
 *
 * Idempotent: a candidate + meeting-date already present in the archive is
 * skipped, so re-running does not create duplicates. Bounded to 40 per run.
 */
function BACKFILL_importPrescreenTranscripts() {
  return withLock_(function () {
    var TAB = 'Backfill Transcripts';
    var sh = getSheetOrNull_(TAB);
    if (!sh) {
      var hint = 'Create a tab named "' + TAB + '" with columns: Date, Name, Email, Transcript — ' +
                 'paste the transcript CSV into it, then run this again.';
      Logger.log('[BACKFILL] ' + hint);
      toast_(hint, 'Recruiting OS', 10);
      return '[BACKFILL] ' + hint;
    }
    var last = sh.getLastRow();
    if (last < 2) return '[BACKFILL] "' + TAB + '" has no rows';

    var headers = getHeaderRow_(sh);
    var hDate  = headers.indexOf('Date');
    var hName  = headers.indexOf('Name');
    var hEmail = headers.indexOf('Email');
    var hT     = headers.indexOf('Transcript');
    if (hName === -1 || hEmail === -1 || hT === -1) {
      throw new Error('"' + TAB + '" must have Name, Email, and Transcript columns');
    }

    var existing = _existingArchiveKeys_();
    var minChars = CFG.getInt('TRANSCRIPT_MIN_CHARACTERS_FOR_AI', 200);
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var sum = { scanned: 0, imported: 0, graded: 0, blankOrShort: 0, alreadyImported: 0, unmatched: 0, errors: 0 };

    for (var i = 0; i < data.length && sum.imported < 40; i++) {
      sum.scanned++;
      var text = String(data[i][hT] || '').trim();
      if (text.length < minChars) { sum.blankOrShort++; continue; }

      var name  = String(data[i][hName] || '').trim();
      var email = String(data[i][hEmail] || '').trim();
      // Truncated exports (e.g. "x@gm...") cannot match by email — fall back to name.
      var emailForMatch = email.indexOf('...') !== -1 ? '' : email;

      var res = _resolveBackfillCandidate_({ email: emailForMatch, name: name });
      if (!res.cid) {
        sum.unmatched++;
        _queueBackfillReview_({
          sourceSheet: TAB, sourceRow: i + 2, hint: name, email: email,
          issue: res.matches.length > 1 ? 'Multiple candidates match this transcript' : 'No candidate match for transcript',
          possibleMatches: res.matches.join(', '),
          resolutionNeeded: 'Confirm the candidate, set their Candidate ID, then re-run Import'
        });
        continue;
      }

      var dateStr = hDate !== -1 ? String(data[i][hDate] || '') : '';
      var meetingDate = dateStr ? shopDate_(_coerceDate_(dateStr)) : shopDate_();
      if (existing[res.cid + '|' + meetingDate]) { sum.alreadyImported++; continue; }

      try {
        var candidate = _getCandidateRow_(res.cid);
        var rowData = {
          'Otter Source ID': 'FATHOM-BACKFILL-' + Utilities.getUuid().substring(0, 8).toUpperCase(),
          'Meeting Title':   'Phone Screen — ' + name,
          'Meeting Date':    meetingDate,
          'Transcript Text': text,
          'Participants':    (candidate['Email'] || email) + ', ' + CFG.get('HIRING_MANAGER_EMAIL', ''),
          'Organizer Email': CFG.get('HIRING_MANAGER_EMAIL', ''),
          'Source App':      'Fathom_Backfill'
        };
        var archiveRow = _archiveTranscript_(rowData, res.cid, candidate, 'PhoneScreen', {
          method: MATCH_METHOD.MANUAL, confidence: res.method === 'email' ? 100 : 80
        });
        existing[res.cid + '|' + meetingDate] = true;
        sum.imported++;
        if (CFG.getBool('AI_GRADING_ENABLED', true) && typeof gradeTranscript_ === 'function') {
          if (gradeTranscript_(archiveRow)) sum.graded++;
        }
        logEvent_('BACKFILL_TRANSCRIPT_IMPORTED', res.cid, { archiveRow: archiveRow, chars: text.length, match: res.method });
      } catch (e) {
        sum.errors++;
        logError_('BACKFILL_importPrescreenTranscripts:row' + (i + 2), e, res.cid, 'WARN');
      }
    }

    var hitMax = (sum.imported >= 40);
    var msg = '[BACKFILL] importPrescreenTranscripts — ' + JSON.stringify(sum) + (hitMax ? '  (HIT MAX — run again)' : '');
    Logger.log(msg);
    toast_('Imported ' + sum.imported + ' transcripts (' + sum.graded + ' graded, ' + sum.unmatched + ' to review)', 'Recruiting OS', 8);
    logEvent_('BACKFILL_TRANSCRIPT_IMPORT_RUN', '', sum);
    return msg;
  });
}

/** Build a set of "CandidateID|MeetingDate" keys already in the archive (for dedup). */
function _existingArchiveKeys_() {
  var keys = {};
  var sh = getSheetOrNull_(SHEETS.TRANSCRIPT_ARCHIVE);
  if (!sh) return keys;
  var last = sh.getLastRow();
  if (last < 2) return keys;
  var headers = getHeaderRow_(sh);
  var hCid  = headers.indexOf('Candidate ID');
  var hDate = headers.indexOf('Meeting Date');
  if (hCid === -1 || hDate === -1) return keys;
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    var cid = String(data[i][hCid] || '').trim();
    if (cid) keys[cid + '|' + String(data[i][hDate] || '')] = true;
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. TIDY INTERVIEW PIPELINE — hide legacy/unused columns (reversible)
// ─────────────────────────────────────────────────────────────────────────────

// Genuinely-dead legacy columns from the old phone/full/Queendom workflow,
// now superseded by Status + the canonical score/date columns. These are HIDDEN
// (reversible) so the manager sees only meaningful columns.
//
// NOTE: the "Link Sent" and "Booked" date columns are intentionally NOT hidden —
// they ARE populated now (booking links stamp Link Sent; pollCalendarBookings
// stamps Booked) and the manager wants them visible.
var PIPELINE_LEGACY_HIDE_COLUMNS = [
  'Days in Stage', 'Phone Screen Done', 'Phone Screen Outcome',
  'Full Interview Done', 'Full Interview Score', 'Queendom Sent', 'Queendom Completed',
  'Final Decision', 'Contact Verified', 'Engagement Score', 'Score'
];

/**
 * Hide the legacy Interview Pipeline columns so the manager sees only the
 * columns that matter. Reversible: select the surrounding columns and
 * right-click → Unhide, or run showInterviewPipelineColumns().
 */
function tidyInterviewPipelineColumns() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var headers = getHeaderRow_(sh);
    var hidden = [];
    PIPELINE_LEGACY_HIDE_COLUMNS.forEach(function (name) {
      var idx = headers.indexOf(name);
      if (idx !== -1) { sh.hideColumns(idx + 1); hidden.push(name); }
    });
    var msg = '[PIPELINE] hid ' + hidden.length + ' legacy columns: ' + hidden.join(', ');
    Logger.log(msg);
    toast_('Hid ' + hidden.length + ' legacy Interview Pipeline columns', 'Recruiting OS', 6);
    return msg;
  });
}

/** Re-show every Interview Pipeline column (undo tidyInterviewPipelineColumns). */
function showInterviewPipelineColumns() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    sh.showColumns(1, sh.getMaxColumns());
    return '[PIPELINE] all columns shown';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAN "GM VIEW" — show ONLY the columns the General Manager needs, in their
// natural order (Final Recommendation sits immediately left of Manager
// Decision), and visually highlight the two columns the eye should land on.
// Reversible via showInterviewPipelineColumns(). Stronger than the legacy
// tidyInterviewPipelineColumns() (which only hides a handful of old columns).
// ─────────────────────────────────────────────────────────────────────────────

// The only columns a GM works with day to day. Everything else is hidden.
var GM_PIPELINE_KEEP_COLUMNS = [
  'First Name', 'Last Name', 'Role', 'Pre-Screen Score', 'Risk Score',
  'Final Recommendation', 'Manager Decision', 'Rejection Reason',
  'Status', 'Next Action Due', 'Last Updated', 'Notes'
];

/**
 * Apply the clean GM view to the Interview Pipeline: hide every column that is
 * not in GM_PIPELINE_KEEP_COLUMNS, freeze the header row, and (when
 * GM_PIPELINE_VIEW_HIGHLIGHT=TRUE) tint the AI Recommendation column green and
 * the Manager Decision column amber so the manager's eye lands on the decision.
 * Idempotent and reversible (showInterviewPipelineColumns()).
 */
function applyGmPipelineView() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var headers = getHeaderRow_(sh);
    var keep = {};
    GM_PIPELINE_KEEP_COLUMNS.forEach(function (n) { keep[n] = true; });

    // Start from a known state: show everything, then hide the non-keep columns.
    sh.showColumns(1, sh.getMaxColumns());
    var hidden = 0, shown = [];
    headers.forEach(function (name, i) {
      var col = i + 1;
      if (name && keep[name]) { shown.push(name); }
      else if (name) { sh.hideColumns(col); hidden++; }
    });

    sh.setFrozenRows(1);

    // Highlight the two columns that drive the workflow.
    if (CFG.getBool('GM_PIPELINE_VIEW_HIGHLIGHT', true)) {
      var lastRow = Math.max(sh.getLastRow(), 2);
      var recCol = headers.indexOf('Final Recommendation') + 1;
      var decCol = headers.indexOf('Manager Decision') + 1;
      if (recCol > 0) sh.getRange(2, recCol, lastRow - 1, 1).setBackground('#e6f4ea');
      if (decCol > 0) sh.getRange(2, decCol, lastRow - 1, 1).setBackground('#fff3cd');
    }

    var msg = '[PIPELINE] GM view applied — showing ' + shown.length + ' columns, hid ' + hidden +
              '. Visible: ' + shown.join(', ');
    Logger.log(msg);
    toast_('Clean GM view applied — ' + shown.length + ' columns shown, ' + hidden + ' hidden', 'Recruiting OS', 6);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. BULK-ARCHIVE STALE BACKFILL ROWS — clears the MANUAL_REVIEW backlog
// ─────────────────────────────────────────────────────────────────────────────

// A candidate is a bulk-archive candidate when ALL of these are true:
//   • Interview Pipeline Stage = "Backfilled — review"  (i.e. came in via backfill)
//   • Status = MANUAL_REVIEW                            (never triaged)
//   • No Phone Score AND no Full Score                  (never interviewed)
//   • No Working Interview Date                         (no working-interview booked)
//   • Pre-Screen Score (or Score) ≤ BACKFILL_ARCHIVE_MAX_SCORE
//
// Anything missing one of these stays visible for manual triage.
var BACKFILL_ARCHIVE_MAX_SCORE = 65;   // keep Recommend/Highly Recommend tier visible
var BACKFILL_ARCHIVE_STAGE_TAG = 'Backfilled — review';

/** Read-only preview: what bulkArchiveBacklog would do. Safe to run any time. */
function previewBulkArchiveBacklog() {
  var r = _bulkArchiveBacklog_({ dryRun: true });
  Logger.log(r.report);
  return r.report;
}

/** Actually archive the rows the preview lists. Idempotent (re-running re-targets nothing). */
function bulkArchiveBacklog() {
  var r = _bulkArchiveBacklog_({ dryRun: false });
  Logger.log(r.report);
  toast_('Bulk archive — ' + r.archived + ' candidate(s) archived', 'Recruiting OS', 8);
  return r.report;
}

function _bulkArchiveBacklog_(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false; // safer default: dry run

  var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var last = ip.getLastRow();
  if (last < 2) return { archived: 0, report: '[BACKFILL_ARCHIVE] pipeline empty' };

  var headers = getHeaderRow_(ip);
  var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
  var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
  var maxScore = BACKFILL_ARCHIVE_MAX_SCORE;
  var targets = [], skipped = { notBackfill: 0, notManualReview: 0, hasInterview: 0, highScore: 0 };

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var stage  = String(r[idx['Stage']]  || '').trim();
    var status = String(r[idx['Status']] || '').trim().toUpperCase();
    if (stage !== BACKFILL_ARCHIVE_STAGE_TAG)    { skipped.notBackfill++; continue; }
    if (status !== 'MANUAL_REVIEW')              { skipped.notManualReview++; continue; }

    var phone = parseFloat(r[idx['Phone Score']]); if (isNaN(phone)) phone = 0;
    var full  = parseFloat(r[idx['Full Score']]);  if (isNaN(full))  full  = 0;
    var working = r[idx['Working Interview Date']];
    if (phone > 0 || full > 0 || (working && String(working).trim())) { skipped.hasInterview++; continue; }

    var pre = parseFloat(r[idx['Pre-Screen Score']]);
    if (isNaN(pre)) pre = parseFloat(r[idx['Score']]);
    if (isNaN(pre)) pre = 0;
    if (pre > maxScore) { skipped.highScore++; continue; }

    targets.push({
      rowNum: i + 2,
      cid:    String(r[idx['Candidate ID']] || ''),
      name:   String(r[idx['Full Name']] || ((r[idx['First Name']] || '') + ' ' + (r[idx['Last Name']] || ''))).trim(),
      role:   String(r[idx['Role']] || ''),
      score:  pre
    });
  }

  var report = [
    '[BACKFILL_ARCHIVE] ' + (dryRun ? 'PREVIEW' : 'EXECUTE') + ' — max pre-screen score for archive: ' + maxScore,
    '  candidates to archive : ' + targets.length,
    '  skipped notBackfill   : ' + skipped.notBackfill,
    '  skipped notManualReview: ' + skipped.notManualReview,
    '  skipped hasInterview  : ' + skipped.hasInterview + ' (kept visible — they have a phone/full score or working-interview date)',
    '  skipped highScore     : ' + skipped.highScore + ' (kept visible — pre-screen > ' + maxScore + ')'
  ];

  if (!targets.length) {
    report.push('  ─ nothing matches the bulk-archive criteria.');
    return { archived: 0, report: report.join('\n'), targets: targets };
  }

  report.push('  ─ targets:');
  targets.forEach(function (t) {
    report.push('     ' + (t.score + '').padEnd(3, ' ') + '  ' + t.role.padEnd(28, ' ') + '  ' + t.name + '  (' + t.cid + ')');
  });

  if (dryRun) {
    report.push('');
    report.push('  Dry run — nothing written. Run bulkArchiveBacklog() to execute.');
    return { archived: 0, report: report.join('\n'), targets: targets };
  }

  // Execute
  var stamp = shopDateTime_();
  var note = 'Bulk-archived from backfill backlog ' + shopDate_() + ' — no interview on file, pre-screen ≤ ' + maxScore;
  var archived = 0;
  targets.forEach(function (t) {
    try {
      updateRowWhere_(ip, 'Candidate ID', t.cid, { 'Status': STATUS.ARCHIVED, 'Last Updated': stamp, 'Notes / Next Action': note });
      updateRowWhere_(ac, 'Candidate ID', t.cid, { 'Status': STATUS.ARCHIVED, 'Last Updated': stamp, 'Notes': note });
      archived++;
    } catch (e) { logError_('bulkArchiveBacklog:' + t.cid, e, t.cid, 'WARN'); }
  });
  report.push('');
  report.push('  ✓ archived ' + archived + ' / ' + targets.length);
  logEvent_('BACKFILL_BULK_ARCHIVE', '', { archived: archived, targets: targets.length, maxScore: maxScore });
  return { archived: archived, report: report.join('\n'), targets: targets };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function BACKFILL_selfTest() {
  var out = ['[BACKFILL] selfTest (read-only)…'];
  out.push('  ─ Function presence:');
  ['BACKFILL_assignCandidateIds', 'BACKFILL_promoteToPipeline', 'BACKFILL_bulkPromote',
   'BACKFILL_pasteFathomTranscript', 'BACKFILL_scoreAllPending', 'BACKFILL_scoreCandidate',
   'BACKFILL_processPreScreensSafely', 'BACKFILL_dryRun'].forEach(function (n) {
    out.push('       ' + (typeof globalThis[n] === 'function' || typeof this[n] === 'function' ? '✓' : '✗') + ' ' + n);
  });
  out.push('  ─ Dependencies:');
  out.push('       ' + (typeof _archiveTranscript_       === 'function' ? '✓' : '✗') + ' _archiveTranscript_ (08_Otter_Transcripts)');
  out.push('       ' + (typeof _findCandidateByEmail_    === 'function' ? '✓' : '✗') + ' _findCandidateByEmail_ (08_Otter_Transcripts)');
  out.push('       ' + (typeof gradeTranscript_          === 'function' ? '✓' : '✗') + ' gradeTranscript_ (09_AI_Grading)');
  out.push('       ' + (typeof candidateIdFromEmail_     === 'function' ? '✓' : '✗') + ' candidateIdFromEmail_ (01_Utils)');
  out.push('[BACKFILL] selfTest done. Run BACKFILL_dryRun() to see what live operations would do.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
