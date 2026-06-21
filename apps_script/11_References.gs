/**
 * 11_References.gs
 * Frank's European Service — Recruiting OS
 *
 * Two-stage reference workflow:
 *
 *   Stage A — Candidate submits up to 3 references via REFERENCE_SUBMISSION form
 *     onCandidateReferenceSubmit(e)
 *       → match candidate by email
 *       → for each (ref name, ref email): queue reference_check_reference email
 *       → set candidate Status = REFS_PENDING
 *
 *   Stage B — Each referee completes REFERENCE_CHECK form
 *     onRefereeFormSubmit(e)
 *       → match by candidate-name field on form
 *       → write response to internal tracking
 *       → if all expected refs are complete: AI-summarize → Reference Score → Status REFS_COMPLETE
 *
 * Public functions:
 *   onCandidateReferenceSubmit(e)
 *   onRefereeFormSubmit(e)
 *   summarizeReferencesNow(candidateId)   — manual trigger
 *   REFS_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// STAGE A — Candidate submits references
// ─────────────────────────────────────────────────────────────────────────────

function onCandidateReferenceSubmit(e) {
  return safeRun_('onCandidateReferenceSubmit', function () {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var rowNum = e.range.getRow();
    var rowData = readRowAsObject_(sh, rowNum);

    var candidateEmail = normalizeEmail_(rowData['Email Address'] || rowData['Email'] || rowData['Candidate Email']);
    if (!candidateEmail) {
      logError_('refs:noEmail', 'reference-submission row ' + rowNum + ' has no candidate email', '', 'WARN');
      return;
    }
    var candidateId = _findCandidateByEmail_(candidateEmail);
    if (!candidateId) {
      logError_('refs:noCandidate', 'no candidate match for ' + candidateEmail, '', 'WARN');
      return;
    }

    // Extract reference triplets — flexible header detection
    var refs = _extractReferenceTriplets_(rowData);
    if (!refs.length) {
      logError_('refs:noRefs', 'no references parsed from row ' + rowNum, candidateId, 'WARN');
      return;
    }

    dispatchReferenceForms_(candidateId, refs);
    _setCandidateStatus_(candidateId, STATUS.REFS_PENDING,
      refs.length + ' reference request(s) sent: ' + shopDateTime_());

    // Acknowledge to the candidate that their references were received and set timeline expectation
    safeRun_('refs:receivedConfirmation', function () {
      var c = _getCandidateRow_(candidateId);
      if (c && c['Email']) {
        sendTemplatedEmail_('reference_received_confirmation', c['Email'], candidateId, null, {
          reason: 'reference submission received — ' + refs.length + ' ref(s)'
        });
      }
    });

    logEvent_('REFS_REQUESTED', candidateId, { count: refs.length });
  });
}

/** Send the REFERENCE_CHECK form invite to each referee. */
function dispatchReferenceForms_(candidateId, references) {
  var c = _getCandidateRow_(candidateId);
  if (!c) return 0;
  var candidateName = String((c['First Name'] || '') + ' ' + (c['Last Name'] || '')).trim() || c['Full Name'] || '';
  var sent = 0;
  references.forEach(function (r) {
    if (!r.email) return;
    // Prefer a prefilled link that carries Candidate ID/Name so the referee's
    // response ties back deterministically (falls back to the plain form URL).
    var link = buildPrefilledReferenceCheckUrl_({
      candidateId:       candidateId,
      candidateName:     candidateName,
      referenceName:     r.name || '',
      referenceEmail:    r.email,
      role:              c['Role'] || '',
      hiringManagerName: c['Hiring Manager'] || ''
    });
    sendTemplatedEmail_('reference_check_reference', r.email, candidateId, {
      ReferenceName:    r.name || 'Reference',
      CandidateName:    candidateName,
      RoleName:         c['Role'] || '',
      RefCheckFormLink: link
    }, {
      reason: 'reference check request'
    });
    sent++;
  });
  return sent;
}

/**
 * Build a prefilled REFERENCE_CHECK form URL carrying candidate identity, so the
 * referee's submission can be matched by Candidate ID instead of fuzzy name.
 * Opens the form by Edit ID (per A's registry model) and maps item titles to
 * values. Returns the plain form URL on any failure or if nothing prefilled.
 * (Ported from recruiting_os/04_forms.gs:buildPrefilledReferenceCheckUrl_.)
 */
function buildPrefilledReferenceCheckUrl_(args) {
  var fallback = CFG.get('REF_CHECK_FORM_URL') || CFG.get('REFERENCE_FORM_URL') || '';
  try {
    var editId = getFormEditId_('REFERENCE_CHECK');
    if (!editId) return fallback;
    var form = FormApp.openById(editId);
    var prefill = form.createResponse();
    var map = {
      'Candidate ID':        args.candidateId,
      'Candidate Name':      args.candidateName,
      'Name of candidate':   args.candidateName,
      'Applicant Name':      args.candidateName,
      'Reference Name':      args.referenceName,
      'Reference Email':     args.referenceEmail,
      'Role Applied For':    args.role,
      'Role':                args.role,
      'Hiring Manager Name': args.hiringManagerName
    };
    var any = false;
    form.getItems().forEach(function (item) {
      var v = map[item.getTitle()];
      if (v === undefined || v === null || v === '') return;
      try { prefill.withItemResponse(item.asTextItem().createResponse(String(v))); any = true; }
      catch (e) { /* not a text item — skip */ }
    });
    return any ? prefill.toPrefilledUrl() : fallback;
  } catch (e) {
    logError_('buildPrefilledReferenceCheckUrl_', String(e && e.message || e), '', 'WARN');
    return fallback;
  }
}

function _extractReferenceTriplets_(rowData) {
  // Look for "Reference 1 Name", "Reference 1 Email", "Reference 1 Phone" (and 2, 3)
  var refs = [];
  for (var n = 1; n <= 5; n++) {
    var prefix = 'Reference ' + n;
    var name  = rowData[prefix + ' Name']  || rowData[prefix + ' Full Name']  || '';
    var email = rowData[prefix + ' Email'] || rowData[prefix + ' Email Address'] || '';
    var phone = rowData[prefix + ' Phone'] || '';
    if (email || name) refs.push({ name: String(name).trim(), email: normalizeEmail_(email), phone: String(phone).trim() });
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE B — Referee submits the reference check form
// ─────────────────────────────────────────────────────────────────────────────

function onRefereeFormSubmit(e) {
  return safeRun_('onRefereeFormSubmit', function () {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var rowNum = e.range.getRow();
    var rowData = readRowAsObject_(sh, rowNum);

    // Candidate identification — prefer the Candidate ID the prefilled referee
    // link carries (exact, unambiguous); only fall back to EXACT name match.
    // Never substring-match a name (it cross-attributes "Jon Smith" → "Jon Smithson").
    var candidateId = String(rowData['Candidate ID'] || rowData['Candidate Key'] || '').trim();
    var candidateName = String(rowData['Candidate Name'] || rowData['Name of candidate'] || rowData['Applicant Name'] || '').trim();
    if (!candidateId && candidateName) candidateId = _findCandidateByFullName_(candidateName);
    if (!candidateId) {
      logError_('refs:refereeNoMatch', 'no candidate match for reference about: ' + candidateName, '', 'WARN');
      return;
    }

    logEvent_('REF_CHECK_RECEIVED', candidateId, { row: rowNum, refereeName: rowData['Your Name'] || '' });

    // Check if all expected refs are in → trigger summary
    _checkAllRefsComplete_(candidateId);
  });
}

/** Index of a Candidate ID / Candidate Key column on a referee tab, or -1. */
function _refIdColIndex_(headers) {
  for (var i = 0; i < headers.length; i++) {
    var lc = String(headers[i] || '').toLowerCase().trim();
    if (lc === 'candidate id' || lc === 'candidate key') return i;
  }
  return -1;
}

/**
 * True if a Reference Checks row belongs to candidateId. Prefers the row's
 * Candidate ID/Key (exact); else EXACT normalized candidate-name equality.
 * Never substring — that cross-attributes references to the wrong candidate.
 */
function _refRowMatchesCandidate_(rowVals, idCol, nameCol, candidateId, targetName) {
  if (idCol !== -1) {
    var rid = String(rowVals[idCol] || '').trim();
    if (rid) return rid === candidateId;
  }
  if (nameCol === -1) return false;
  var nm = String(rowVals[nameCol] || '').toLowerCase().trim().replace(/\s+/g, ' ');
  return !!nm && nm === targetName;
}

/** Count of submitted reference checks for a candidate. */
function _countReferenceChecksFor_(candidateId) {
  var sh = getSheetOrNull_(SHEETS.REFERENCE_CHECKS);
  if (!sh) return 0;
  var c = _getCandidateRow_(candidateId);
  if (!c) return 0;
  var fullName = String((c['First Name'] || '') + ' ' + (c['Last Name'] || '')).trim();
  if (!fullName) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);
  // Find a "candidate name" column
  var nameCol = -1;
  headers.forEach(function (h, i) {
    var lc = String(h || '').toLowerCase();
    if (nameCol === -1 && (lc.indexOf('candidate name') !== -1 || lc.indexOf('applicant') !== -1)) nameCol = i;
  });
  var idCol = _refIdColIndex_(headers);
  if (nameCol === -1 && idCol === -1) return 0;
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var count = 0;
  var target = fullName.toLowerCase().replace(/\s+/g, ' ');
  data.forEach(function (r) { if (_refRowMatchesCandidate_(r, idCol, nameCol, candidateId, target)) count++; });
  return count;
}

function _checkAllRefsComplete_(candidateId) {
  var count = _countReferenceChecksFor_(candidateId);
  // Heuristic threshold: 2+ references received is enough to summarize
  if (count >= 2) {
    safeRun_('refs:summarize', function () { _aiSummarizeReferences_(candidateId); });
  } else {
    logEvent_('REF_COUNT_UPDATE', candidateId, { count: count });
  }
}

/** Trigger summary right now even if fewer than threshold received. */
function summarizeReferencesNow(candidateId) {
  return withLock_(function () { return _aiSummarizeReferences_(candidateId); });
}

function _aiSummarizeReferences_(candidateId) {
  var c = _getCandidateRow_(candidateId);
  if (!c) return null;
  var fullName = String((c['First Name'] || '') + ' ' + (c['Last Name'] || '')).trim();
  var sh = getSheetOrNull_(SHEETS.REFERENCE_CHECKS);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;

  var headers = getHeaderRow_(sh);
  var nameCol = -1;
  headers.forEach(function (h, i) {
    var lc = String(h || '').toLowerCase();
    if (nameCol === -1 && (lc.indexOf('candidate name') !== -1 || lc.indexOf('applicant') !== -1)) nameCol = i;
  });
  var idCol = _refIdColIndex_(headers);
  if (nameCol === -1 && idCol === -1) {
    logError_('refs:summary', 'cannot find candidate-name or Candidate ID column on Reference Checks tab', candidateId, 'WARN');
    return null;
  }

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var target = fullName.toLowerCase().replace(/\s+/g, ' ');
  var refs = [];
  data.forEach(function (r) {
    if (!_refRowMatchesCandidate_(r, idCol, nameCol, candidateId, target)) return;
    var obj = {};
    headers.forEach(function (h, j) {
      var v = String(r[j] == null ? '' : r[j]).trim();
      if (v && h) obj[h] = v;
    });
    refs.push(obj);
  });
  if (!refs.length) return null;

  var prompt = _loadAiPrompt_('reference_summary');
  if (!prompt) { logError_('refs:summary', 'reference_summary prompt missing', candidateId); return null; }

  var promptText = renderMerge_(prompt['Prompt Body'], {
    ReferencesPayload: JSON.stringify(refs, null, 2),
    Provider:          CFG.get('AI_PROVIDER', 'gemini'),
    Model:             CFG.get('GEMINI_MODEL')
  });
  var result = _geminiGradeJson_('reference_summary', candidateId, promptText);
  if (!result.ok) {
    logError_('refs:summary:aiFailed', result.error, candidateId, 'ERROR');
    return null;
  }
  var ai = result.data || {};
  var avgScore = parseInt(ai.reference_average_score, 10);
  if (isNaN(avgScore)) avgScore = 0;

  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    var updates = {
      'Status':       STATUS.REFS_COMPLETE,
      'Last Updated': shopDateTime_()
    };
    if (getColIndex_(ip, 'Reference Score'))   updates['Reference Score']   = avgScore;
    if (getColIndex_(ip, 'Reference Average')) updates['Reference Average'] = avgScore;
    if (getColIndex_(ip, 'Reference Summary')) updates['Reference Summary'] = truncate_(String(ai.summary || ai.reference_summary || ''), 1000);
    updateRowWhere_(ip, 'Candidate ID', candidateId, updates);
  }
  _setCandidateStatus_(candidateId, STATUS.REFS_COMPLETE,
    'Refs summarized: avg=' + avgScore + ' (' + refs.length + ' refs)');
  logEvent_('REFS_SUMMARIZED', candidateId, { count: refs.length, average: avgScore });

  // Fold the AI-graded reference average into the grand-total recommendation.
  safeRun_('refs:recompute', function () {
    if (typeof computeFinalRecommendation_ === 'function') computeFinalRecommendation_(candidateId);
  });

  // Once references are complete, emit the leadership report card (fires only
  // when the culture-fit score is also present; otherwise it no-ops and the
  // culture handler will fire it). Falls back to a plain manager alert if the
  // report-card module is unavailable.
  var reportSent = false;
  safeRun_('refs:reportCard', function () {
    if (typeof maybeSendCandidateReportCard_ === 'function') {
      reportSent = !!maybeSendCandidateReportCard_(candidateId, 'references');
    }
  });
  if (!reportSent) {
    safeRun_('refs:refsCompleteManagerAlert', function () {
      var role = c['Role'] || '';
      queueEmail_({
        to:          CFG.get('HIRING_MANAGER_EMAIL'),
        subject:     'References complete — ' + fullName + (role ? ' (' + role + ')' : ''),
        body:
'Reference checks are complete for ' + fullName + '.\n\n' +
'Average reference score : ' + avgScore + '/100\n' +
'References received     : ' + refs.length + '\n\n' +
'Waiting on the culture-fit assessment before the full report card is generated.\n' +
'Open the Interview Pipeline to review the summary.\n\n— Recruiting OS',
        candidateId: candidateId,
        templateKey: '__refs_complete_manager_alert__',
        reason:      'refs complete — manager alert (awaiting culture fit)'
      });
    });
  }

  return { count: refs.length, average: avgScore, data: ai };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _findCandidateByFullName_(fullName) {
  var target = String(fullName || '').toLowerCase().trim();
  if (!target) return '';
  function scan(sheetName) {
    var sh = getSheetOrNull_(sheetName);
    if (!sh) return '';
    var last = sh.getLastRow();
    if (last < 2) return '';
    var headers = getHeaderRow_(sh);
    var iF = headers.indexOf('First Name');
    var iL = headers.indexOf('Last Name');
    var iC = headers.indexOf('Candidate ID');
    if (iF === -1 || iL === -1 || iC === -1) return '';
    var tgt = target.replace(/\s+/g, ' ');
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {
      var full = (String(data[i][iF] || '') + ' ' + String(data[i][iL] || '')).toLowerCase().trim().replace(/\s+/g, ' ');
      // EXACT match only — substring matching cross-attributes references to the
      // wrong candidate (e.g. "Jon Smith" matching "Jon Smithson").
      if (full && full === tgt) return String(data[i][iC] || '');
    }
    return '';
  }
  return scan(SHEETS.ALL_CANDIDATES) || scan(SHEETS.INTERVIEW_PIPELINE);
}

function _setCandidateStatus_(candidateId, status, note) {
  var stamp = shopDateTime_();
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) updateRowWhere_(ip, 'Candidate ID', candidateId, {
    'Status': status, 'Last Updated': stamp, 'Notes / Next Action': note || ''
  });
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (ac) updateRowWhere_(ac, 'Candidate ID', candidateId, {
    'Status': status, 'Last Updated': stamp
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function REFS_selfTest() {
  var out = ['[REFS] selfTest (read-only)…'];
  out.push('  ─ REFERENCE_CHECK_ENABLED : ' + CFG.getBool('REFERENCE_CHECK_ENABLED'));
  out.push('  ─ REFERENCE_FORM_URL      : ' + truncate_(CFG.get('REFERENCE_FORM_URL'), 70));
  out.push('  ─ REF_CHECK_FORM_URL      : ' + truncate_(CFG.get('REF_CHECK_FORM_URL'), 70));
  var p = _loadAiPrompt_('reference_summary');
  out.push('  ' + (p ? '✓' : '✗') + ' reference_summary prompt loaded');
  var rr = getSheetOrNull_(SHEETS.REFERENCE_REQUESTS);
  var rc = getSheetOrNull_(SHEETS.REFERENCE_CHECKS);
  out.push('  ─ Reference Requests rows : ' + (rr ? Math.max(0, rr.getLastRow() - 1) : 'sheet missing'));
  out.push('  ─ Reference Checks rows   : ' + (rc ? Math.max(0, rc.getLastRow() - 1) : 'sheet missing'));
  out.push('[REFS] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
