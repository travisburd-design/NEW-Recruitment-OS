/**
 * 12_Culture_Fit.gs
 * Frank's European Service — Recruiting OS
 *
 * Culture Fit form workflow:
 *   - Manager (via dropdown) or scoring system queues a culture_fit_invite
 *     email to candidate.
 *   - Candidate completes the CULTURE_FIT form.
 *   - onCultureSubmit fires → match candidate → AI score responses → write
 *     Culture Score on Interview Pipeline.
 *
 * Public functions:
 *   onCultureSubmit(e)
 *   sendCultureInvite_(candidateId)
 *   regradeCultureFor(candidateId)
 *   CULTURE_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEND INVITE
// ─────────────────────────────────────────────────────────────────────────────

function sendCultureInvite_(candidateId) {
  var c = _getCandidateRow_(candidateId);
  if (!c) { logError_('sendCultureInvite_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return ''; }
  if (!c['Email']) { logError_('sendCultureInvite_', 'no email', candidateId, 'WARN'); return ''; }
  return sendTemplatedEmail_('culture_fit_invite', c['Email'], candidateId, {
    CultureFormLink: _resolveCultureLink_(c['Role'])
  }, {
    reason: 'culture fit invite'
  });
}

function _resolveCultureLink_(role) {
  // Role Rules row may have a role-specific Culture Fit Form Link
  if (role) {
    var rr = _getRoleRule_(role);
    if (rr && rr['Culture Fit Form Link']) return rr['Culture Fit Form Link'];
  }
  return CFG.get('CULTURE_FIT_FORM_URL') || getFormUrl_('CULTURE_FIT');
}

// ─────────────────────────────────────────────────────────────────────────────
// FORM SUBMIT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function onCultureSubmit(e) {
  return safeRun_('onCultureSubmit', function () {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var rowNum = e.range.getRow();
    var rowData = readRowAsObject_(sh, rowNum);

    var candidateEmail = normalizeEmail_(rowData['Email Address'] || rowData['Email'] || '');
    var candidateName  = String(rowData['Full Name'] || rowData['Name'] || '').trim();
    var candidateId = candidateEmail ? _findCandidateByEmail_(candidateEmail) : '';
    if (!candidateId && candidateName) candidateId = _findCandidateByFullName_(candidateName);
    if (!candidateId) {
      logError_('culture:noMatch', 'no candidate match for culture submission (email=' + candidateEmail + ', name=' + candidateName + ')', '', 'WARN');
      return;
    }

    logEvent_('CULTURE_SUBMITTED', candidateId, { row: rowNum });
    _scoreCultureResponses_(candidateId, rowData);
  });
}

function regradeCultureFor(candidateId) {
  return withLock_(function () {
    var c = _getCandidateRow_(candidateId);
    if (!c) throw new Error('regradeCultureFor: candidate not found: ' + candidateId);
    // Find latest culture row by email
    var sh = getSheetOrNull_(SHEETS.CULTURE_FIT);
    if (!sh) throw new Error('Culture Fit response sheet missing');
    var headers = getHeaderRow_(sh);
    var emailCol = -1;
    headers.forEach(function (h, i) {
      if (emailCol === -1 && String(h || '').toLowerCase().indexOf('email') !== -1) emailCol = i;
    });
    if (emailCol === -1) throw new Error('culture sheet has no Email column');
    var last = sh.getLastRow();
    if (last < 2) throw new Error('no culture submissions');
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var target = normalizeEmail_(c['Email']);
    for (var i = data.length - 1; i >= 0; i--) {
      if (normalizeEmail_(data[i][emailCol]) === target) {
        var obj = {};
        headers.forEach(function (h, j) { if (h) obj[h] = data[i][j]; });
        return _scoreCultureResponses_(candidateId, obj);
      }
    }
    throw new Error('no culture submission for ' + target);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AI SCORE
// ─────────────────────────────────────────────────────────────────────────────

function _scoreCultureResponses_(candidateId, rowData) {
  var prompt = _loadAiPrompt_('culture_fit');
  if (!prompt) { logError_('culture:score', 'culture_fit prompt missing', candidateId); return null; }

  // Build payload — non-blank fields only
  var payload = {};
  Object.keys(rowData).forEach(function (k) {
    var v = String(rowData[k] == null ? '' : rowData[k]).trim();
    if (v) payload[k] = v;
  });

  var promptText = renderMerge_(prompt['Prompt Body'], {
    CulturePayload: JSON.stringify(payload, null, 2),
    Provider:       CFG.get('AI_PROVIDER', 'gemini'),
    Model:          CFG.get('GEMINI_MODEL')
  });
  var result = _geminiGradeJson_('culture_fit', candidateId, promptText);
  if (!result.ok) { logError_('culture:score:aiFailed', result.error, candidateId, 'ERROR'); return null; }

  var ai = result.data || {};
  var score = parseInt(ai.ai_score, 10); if (isNaN(score)) score = 0;

  // Write Culture Score column if present, else fall back to Notes
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    var updates = { 'Last Updated': shopDateTime_() };
    if (getColIndex_(ip, 'Culture Score')) updates['Culture Score'] = score;
    if (getColIndex_(ip, 'Culture Summary')) updates['Culture Summary'] = truncate_(String(ai.summary || ''), 1000);
    if (getColIndex_(ip, 'Notes / Next Action')) {
      updates['Notes / Next Action'] = truncate_('Culture: ' + (ai.summary || '') + ' [score=' + score + ']', 300);
    }
    updateRowWhere_(ip, 'Candidate ID', candidateId, updates);
  }
  logEvent_('CULTURE_SCORED', candidateId, { score: score });

  // Fold the AI-graded culture score into the grand-total recommendation, then
  // (if references are also complete) emit the leadership report card.
  safeRun_('culture:recompute', function () {
    if (typeof computeFinalRecommendation_ === 'function') computeFinalRecommendation_(candidateId);
  });
  safeRun_('culture:reportCard', function () {
    if (typeof maybeSendCandidateReportCard_ === 'function') maybeSendCandidateReportCard_(candidateId, 'culture');
  });

  return { score: score, data: ai };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function CULTURE_selfTest() {
  var out = ['[CULTURE] selfTest (read-only)…'];
  out.push('  ─ Culture Fit form URL    : ' + truncate_(getFormUrl_('CULTURE_FIT'), 70));
  out.push('  ─ Culture Fit response tab: ' + getFormResponseTab_('CULTURE_FIT'));
  var p = _loadAiPrompt_('culture_fit');
  out.push('  ' + (p ? '✓' : '✗') + ' culture_fit prompt loaded');
  var sh = getSheetOrNull_(SHEETS.CULTURE_FIT);
  out.push('  ─ Submitted rows          : ' + (sh ? Math.max(0, sh.getLastRow() - 1) : 'sheet missing'));
  out.push('[CULTURE] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
