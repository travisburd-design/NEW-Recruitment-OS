/**
 * 09_AI_Grading.gs
 * Frank's European Service — Recruiting OS
 *
 * AI grading for interview transcripts (phone screen + full interview).
 * Called by 08_Otter_Transcripts after a transcript is archived.
 *
 *   gradeTranscript_(archiveRowNum)
 *     1) load Master Transcript Archive row
 *     2) pick prompt by Phase:
 *          PhoneScreen      → 'phone_screen'
 *          FullInterview    → 'full_interview'
 *          WorkingInterview → 'full_interview' (same rubric for now)
 *     3) call Gemini (reuses _geminiGradeJson_ from 06_Scoring_Risk.gs)
 *     4) write back to archive: AI Score, AI Risk Score, Summary, Strengths,
 *        Concerns, Confidence Level
 *     5) update candidate row with phase-specific score (Phone Score or
 *        Full Score) and status (PHONE_DONE or FULL_DONE)
 *
 *   gradePendingTranscripts()
 *     Bulk: re-grade any archive row whose AI Score is blank. Safe to
 *     re-run; only touches blank rows. Used on a daily trigger.
 *
 * Note: 06_Scoring_Risk.gs owns the actual Gemini HTTP call. This file
 * focuses on transcript-specific orchestration and writeback.
 *
 * Public functions:
 *   gradeTranscript_(archiveRowNum)   — called by 08
 *   gradePendingTranscripts()         — daily bulk grader
 *   regradeArchiveRow(archiveRowNum)  — manual re-grade entry
 *   AI_GRADE_selfTest()               — read-only sanity check
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: gradeTranscript_  (single archive row)
// ─────────────────────────────────────────────────────────────────────────────

function gradeTranscript_(archiveRowNum) {
  if (!CFG.getBool('AI_GRADING_ENABLED', true)) {
    logEvent_('TRANSCRIPT_GRADING_SKIPPED', '', 'AI_GRADING_ENABLED is FALSE');
    return null;
  }
  var sh = getSheet_(SHEETS.TRANSCRIPT_ARCHIVE);
  if (archiveRowNum < 2 || archiveRowNum > sh.getLastRow()) {
    throw new Error('gradeTranscript_: invalid archive row ' + archiveRowNum);
  }

  var row = readRowAsObject_(sh, archiveRowNum);
  var candidateId = String(row['Candidate ID'] || '');
  var phase = String(row['Phase'] || 'FullInterview');
  var transcript = String(row['Transcript Text'] || '');

  if (!candidateId) {
    logError_('gradeTranscript_', 'no Candidate ID in archive row ' + archiveRowNum, '', 'WARN');
    return null;
  }

  var summaryMode = _isInterviewSummaryMode_();
  var minChars = summaryMode ? CFG.getInt('AI_SUMMARY_MIN_CHARACTERS', 80)
                             : CFG.getInt('TRANSCRIPT_MIN_CHARACTERS_FOR_AI', 200);
  if (transcript.length < minChars) {
    logError_('gradeTranscript_', (summaryMode ? 'summary' : 'transcript') + ' too short (' + transcript.length + ' < ' + minChars + ')',
              candidateId, 'WARN');
    return null;
  }

  var promptKey = _phaseToPromptKey_(phase);
  var prompt = _loadAiPrompt_(promptKey);
  if (!prompt) {
    logError_('gradeTranscript_', 'AI prompt not found for key: ' + promptKey, candidateId, 'ERROR');
    return null;
  }

  var promptText = renderMerge_(prompt['Prompt Body'], {
    RoleName:       row['Role'] || '',
    InterviewDate:  row['Meeting Date'] || '',
    TranscriptText: transcript,
    Provider:       CFG.get('AI_PROVIDER', 'gemini'),
    Model:          CFG.get('GEMINI_MODEL')
  });

  // Reuse the Gemini caller from 06_Scoring_Risk.gs
  var result = _geminiGradeJson_(promptKey, candidateId, promptText);
  if (!result.ok) {
    logError_('gradeTranscript_:aiFailed', result.error || 'unknown', candidateId, 'ERROR');
    batchUpdateRow_(sh, archiveRowNum, {
      'Notes': truncate_('AI grading failed: ' + (result.error || ''), 300)
    });
    return null;
  }

  var ai = result.data || {};
  var score = parseInt(ai.ai_score, 10);     if (isNaN(score)) score = 0;
  var risk  = parseInt(ai.ai_risk_score, 10); if (isNaN(risk))  risk  = 0;

  // 1) Write back to Master Transcript Archive
  batchUpdateRow_(sh, archiveRowNum, {
    'AI Score':         score,
    'AI Risk Score':    risk,
    'Summary':          truncate_(ai.summary || '', 1000),
    'Strengths':        _joinArr_(ai.strengths),
    'Concerns':         _joinArr_(ai.concerns),
    'Confidence Level': String(ai.confidence_level || '')
  });

  // 2) Write phase-specific score to Interview Pipeline + status update
  _updateCandidateWithTranscriptScore_(candidateId, phase, score, risk, ai.summary || '');

  // 2b) Thank-you to candidate — fires once transcript is graded, sets SLA expectation.
  //     Wraps in safeRun_ so a missing email address can never break the grading flow.
  safeRun_('gradeTranscript_:thankyou', function () {
    if (CFG.getBool('POST_INTERVIEW_THANKYOU_ENABLED', true)) {
      var c = _getCandidateRow_(candidateId);
      if (c && c['Email']) {
        sendTemplatedEmail_('post_interview_thankyou', c['Email'], candidateId, null, {
          reason: 'post-interview thankyou — ' + phase + ' transcript graded'
        });
      }
    }
  });

  // 3) Refresh the Final Recommendation now that an interview score exists —
  //    otherwise the recommendation stays frozen at the pre-screen value.
  if (typeof computeFinalRecommendation_ === 'function') {
    try { computeFinalRecommendation_(candidateId); }
    catch (e) { logError_('gradeTranscript_:recommendation', e, candidateId, 'WARN'); }
  }

  logEvent_('TRANSCRIPT_GRADED', candidateId, {
    archiveRow: archiveRowNum, phase: phase, score: score, risk: risk,
    confidence: ai.confidence_level || ''
  });

  return { candidateId: candidateId, phase: phase, score: score, risk: risk };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: gradePendingTranscripts — bulk daily grader
// ─────────────────────────────────────────────────────────────────────────────

function gradePendingTranscripts() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('gradePendingTranscripts', 'OK');
  return withLockOrSkip_('gradePendingTranscripts', function () {
    var sh = getSheet_(SHEETS.TRANSCRIPT_ARCHIVE);
    var last = sh.getLastRow();
    if (last < 2) return '[AI_GRADE] no archive rows';

    var headers = getHeaderRow_(sh);
    var hScore = headers.indexOf('AI Score');
    if (hScore === -1) throw new Error('gradePendingTranscripts: AI Score column missing');

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, graded: 0, skipped: 0, errors: 0 };
    var MAX_PER_RUN = 25;

    for (var i = 0; i < data.length && (summary.graded + summary.errors) < MAX_PER_RUN; i++) {
      summary.scanned++;
      var s = data[i][hScore];
      if (s !== '' && s !== null && s !== undefined && String(s) !== '') {
        summary.skipped++;
        continue;
      }
      var rowNum = i + 2;
      try {
        var r = gradeTranscript_(rowNum);
        if (r) summary.graded++; else summary.skipped++;
      } catch (e) {
        summary.errors++;
        logError_('gradePendingTranscripts:row' + rowNum, e, '', 'ERROR');
      }
    }

    var msg = '[AI_GRADE] gradePendingTranscripts — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('AI_GRADING_RUN', '', summary);
    return msg;
  });
}

/** Public manual re-grade for a specific archive row. Overwrites prior grade. */
function regradeArchiveRow(archiveRowNum) {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.TRANSCRIPT_ARCHIVE);
    // Wipe prior score so gradeTranscript_ runs even if previously graded
    batchUpdateRow_(sh, archiveRowNum, { 'AI Score': '' });
    return gradeTranscript_(archiveRowNum);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _phaseToPromptKey_(phase) {
  // When the shop pipes Otter structured summaries into the archive instead of
  // raw transcripts, grade with the evidence-based summary prompt (if seeded).
  if (_isInterviewSummaryMode_() && _loadAiPrompt_('interview_summary')) return 'interview_summary';
  var p = String(phase || '').trim();
  if (p === 'PhoneScreen')      return 'phone_screen';
  if (p === 'WorkingInterview') return 'full_interview';
  return 'full_interview';
}

function _isInterviewSummaryMode_() {
  return String(CFG.get('AI_INTERVIEW_INPUT_MODE', 'transcript')).toLowerCase() === 'summary';
}

function _joinArr_(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(function (x) { return String(x || ''); }).filter(Boolean).join('; ');
  return String(v);
}

function _updateCandidateWithTranscriptScore_(candidateId, phase, score, risk, summary) {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  var stamp = shopDateTime_();
  var phaseStatus = '';
  var phaseScoreCol = '';
  if (phase === 'PhoneScreen')    { phaseStatus = STATUS.PHONE_DONE; phaseScoreCol = 'Phone Score'; }
  else if (phase === 'WorkingInterview') { phaseStatus = STATUS.WORKING_SCHEDULED; phaseScoreCol = 'Full Score'; }
  else                            { phaseStatus = STATUS.FULL_DONE;  phaseScoreCol = 'Full Score'; }

  if (ip) {
    var updates = { 'Status': phaseStatus, 'Last Updated': stamp };
    if (phaseScoreCol)            updates[phaseScoreCol] = score;
    if (getColIndex_(ip, 'Risk Score')) updates['Risk Score'] = risk;
    if (getColIndex_(ip, 'Notes / Next Action')) {
      updates['Notes / Next Action'] = truncate_('Transcript graded: ' + summary, 300);
    }
    updateRowWhere_(ip, 'Candidate ID', candidateId, updates);
  }
  if (ac) {
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       phaseStatus,
      'Last Updated': stamp
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only sanity check
// ─────────────────────────────────────────────────────────────────────────────
function AI_GRADE_selfTest() {
  var out = ['[AI_GRADE] selfTest (read-only)…'];
  out.push('  ─ AI_GRADING_ENABLED       : ' + CFG.getBool('AI_GRADING_ENABLED'));
  out.push('  ─ GEMINI_API_KEY set       : ' + hasSecret_(SECRETS.GEMINI_API_KEY));
  out.push('  ─ TRANSCRIPT_MIN_CHARS_AI  : ' + CFG.getInt('TRANSCRIPT_MIN_CHARACTERS_FOR_AI'));

  ['phone_screen', 'full_interview'].forEach(function (k) {
    var p = _loadAiPrompt_(k);
    out.push('  ' + (p ? '✓' : '✗') + ' prompt loaded: ' + k +
             (p ? ' (' + String(p['Prompt Body'] || '').length + ' chars)' : ' — MISSING'));
  });

  var arch = getSheetOrNull_(SHEETS.TRANSCRIPT_ARCHIVE);
  out.push('  ─ Transcript Archive rows  : ' + (arch ? Math.max(0, arch.getLastRow() - 1) : 'sheet missing'));

  // Count rows with blank AI Score (pending grading)
  if (arch && arch.getLastRow() >= 2) {
    var headers = getHeaderRow_(arch);
    var hScore = headers.indexOf('AI Score');
    if (hScore !== -1) {
      var data = arch.getRange(2, 1, arch.getLastRow() - 1, headers.length).getValues();
      var pending = 0;
      data.forEach(function (r) { if (r[hScore] === '' || r[hScore] === null) pending++; });
      out.push('  ─ Archive rows pending AI : ' + pending);
    }
  }

  // Phase mapping demo
  out.push('  ─ Phase mapping:');
  out.push('       PhoneScreen      → ' + _phaseToPromptKey_('PhoneScreen'));
  out.push('       FullInterview    → ' + _phaseToPromptKey_('FullInterview'));
  out.push('       WorkingInterview → ' + _phaseToPromptKey_('WorkingInterview'));

  out.push('[AI_GRADE] selfTest done. Use gradePendingTranscripts() to grade any blank rows.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
