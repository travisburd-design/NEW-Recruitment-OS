/**
 * 35_Assessments.gs
 * Frank's European Service — Recruiting OS
 *
 * Role-based AI Assessment Engine. Consumes the (previously dormant)
 * "Assessment Registry" tab and turns the role a candidate selected on the
 * Pre-Screen Form into:
 *
 *   1. A role-specific question set   (Assessment Question Bank, by Section Key)
 *   2. A role-specific rubric         (Assessment Rubrics, by Rubric Key)
 *   3. A role-specific AI evaluation  (AI Assessment Results)
 *   4. A captured answer trail        (Assessment Responses)
 *   5. A decision recommendation routed against the operator's Registry
 *      thresholds — fully auditable in "Assessment Audit Log".
 *
 * DEFENSE RULES (ported faithfully from the retiring build):
 *   - AI never silently eliminates a candidate. Every assessment-driven
 *     decision carries a human-readable reason recorded in Assessment Audit
 *     Log, whether or not a status actually changed.
 *   - ASSESSMENT_AUTO_DECISION_ENABLED defaults FALSE — by default the engine
 *     only LOGS a recommended decision (fail-closed to human review).
 *   - ASSESSMENT_FAIL_CLOSED defaults TRUE — an AI parse failure routes the
 *     candidate to MANUAL_REVIEW rather than letting them slip through scored.
 *   - A status only changes if it is in A's STATUS map AND actually differs
 *     from the current status.
 *
 * Reuses A's helpers throughout: getSheet_/getSheetOrNull_, getOrCreateSheet_,
 * findRowsByColumnValue_, appendRowByHeader_, readRowAsObject_, withLock_,
 * safeRun_, renderMerge_, _loadAiPrompt_, _geminiGradeJson_, safeParseAiJson_,
 * _getCandidateRow_, _getRoleRule_, _findPreScreenRow_, _buildPreScreenPayload_,
 * _setBothStatuses_, logEvent_, logError_.
 *
 * Sheets this file owns/creates (via getOrCreateSheet_ on demand; the spec also
 * adds them to the bootstrap manifest):
 *   Assessment Question Bank, Assessment Rubrics, Assessment Responses,
 *   AI Assessment Results, Assessment Audit Log.
 *   (Assessment Registry already exists in A — never re-seeded here.)
 *
 * Public functions:
 *   runAssessmentForCandidate(candidateId)
 *   menuRunAssessmentForCandidate()
 *   seedAssessmentFramework_()
 *   getAssessmentRegistryRowForRole_(role)
 *   loadAssessmentRubric_(rubricKey)
 *   loadAssessmentQuestions_(sectionKey)
 *   getLatestAssessmentResult_(candidateId)
 *   logAssessmentEvent_(args)
 *   ASSESSMENT_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHEET NAMES (local — these are not yet in the canonical SHEETS map in
// 00_Config.gs; the integration spec asks Travis to add them there + to the
// bootstrap manifest. Until then, getOrCreateSheet_ makes them self-healing.)
// ─────────────────────────────────────────────────────────────────────────────
var ASSESS_SHEETS = Object.freeze({
  QUESTION_BANK: 'Assessment Question Bank',
  RUBRICS:       'Assessment Rubrics',
  RESPONSES:     'Assessment Responses',
  RESULTS:       'AI Assessment Results',
  AUDIT_LOG:     'Assessment Audit Log'
});

var ASSESS_HEADERS = Object.freeze({
  QUESTION_BANK: ['Active', 'Section Key', 'Order', 'Question', 'Question Type', 'Required', 'Choices', 'Scoring Weight', 'Notes'],
  RUBRICS:       ['Active', 'Rubric Key', 'Category', 'Weight', 'Criteria', 'Pass Threshold', 'Notes'],
  RESPONSES:     ['Timestamp', 'Candidate ID', 'Role', 'Section Key', 'Question Order', 'Question', 'Answer'],
  RESULTS: [
    'Timestamp', 'Candidate ID', 'Role', 'Section Key', 'Rubric Key',
    'Candidate Fit Score', 'Culture Fit Score', 'Role Skill Score',
    'Communication Score', 'Experience Alignment Score', 'Risk Level',
    'Recommendation', 'Strengths', 'Concerns', 'Clarification Needed',
    'Suggested Interview Questions', 'Summary For Worksheet', 'AI Model Used',
    'Decision Status', 'Decision Reason', 'Status'
  ],
  AUDIT_LOG: ['Timestamp', 'Actor', 'Candidate ID', 'Event', 'Previous Value', 'New Value', 'Reason', 'Details']
});

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUPS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the active Assessment Registry row object for a role, or null. */
function getAssessmentRegistryRowForRole_(role) {
  if (!role) return null;
  var sh = getSheetOrNull_(SHEETS.ASSESSMENT_REGISTRY);
  if (!sh) return null;
  var target = String(role).trim().toLowerCase();
  var hits = findRowsByColumnValue_(sh, 'Role', role);
  // Prefer the exact-cased match if Active; otherwise do a case-insensitive scan.
  for (var i = 0; i < hits.length; i++) {
    if (_assessBool_(hits[i].data['Active'])) return hits[i].data;
  }
  var last = sh.getLastRow();
  if (last < 2) return null;
  var headers = getHeaderRow_(sh);
  var roleCol = headers.indexOf('Role');
  if (roleCol === -1) return null;
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var r = 0; r < data.length; r++) {
    if (String(data[r][roleCol]).trim().toLowerCase() !== target) continue;
    var obj = {};
    headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = data[r][j]; });
    if (_assessBool_(obj['Active'])) return obj;
  }
  return null;
}

/** Returns active rubric rows for a Rubric Key, in sheet order. */
function loadAssessmentRubric_(rubricKey) {
  if (!rubricKey) return [];
  var sh = getSheetOrNull_(ASSESS_SHEETS.RUBRICS);
  if (!sh) return [];
  return findRowsByColumnValue_(sh, 'Rubric Key', rubricKey)
    .map(function (h) { return h.data; })
    .filter(function (r) { return _assessBool_(r['Active']); });
}

/** Returns active question rows for a Section Key, sorted by Order. */
function loadAssessmentQuestions_(sectionKey) {
  if (!sectionKey) return [];
  var sh = getSheetOrNull_(ASSESS_SHEETS.QUESTION_BANK);
  if (!sh) return [];
  var rows = findRowsByColumnValue_(sh, 'Section Key', sectionKey)
    .map(function (h) { return h.data; })
    .filter(function (r) { return _assessBool_(r['Active']); });
  rows.sort(function (a, b) { return Number(a['Order'] || 0) - Number(b['Order'] || 0); });
  return rows;
}

/**
 * Returns the most recent AI Assessment Results row for a candidate, or null.
 * FIX vs. the retiring build: selects the latest by TIMESTAMP, not by physical
 * last row (re-runs / out-of-order appends used to return the wrong row).
 */
function getLatestAssessmentResult_(candidateId) {
  if (!candidateId) return null;
  var sh = getSheetOrNull_(ASSESS_SHEETS.RESULTS);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Candidate ID', candidateId);
  if (!hits.length) return null;
  hits.sort(function (a, b) {
    return _coerceDate_(b.data['Timestamp']).getTime() - _coerceDate_(a.data['Timestamp']).getTime();
  });
  return hits[0].data;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGGING — every assessment-driven action goes through here. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

function logAssessmentEvent_(args) {
  try {
    args = args || {};
    var event = String(args.event || '');
    var prev = args.previousValue == null ? '' : String(args.previousValue);
    var next = args.newValue == null ? '' : String(args.newValue);
    // Lean architecture: assessment audit events fold into the unified System Log
    // (Type=ASSESSMENT). This audit was write-only (nothing reads it), so the
    // dedicated tab is removed. Falls back to the old tab only pre-migration.
    var sys = getSheetOrNull_(SHEETS.SYSTEM_LOG);
    if (sys) {
      var detail = [(prev || next) ? (prev + ' → ' + next) : '', String(args.details || '')]
                     .filter(function (s) { return s; }).join(' | ');
      appendRowByHeader_(sys, {
        'Timestamp':         shopDateTime_(),
        'Type':              'ASSESSMENT',
        'Severity':          /error|fail|invalid/i.test(event) ? 'WARN' : 'INFO',
        'Label / Event':     event,
        'Candidate ID':      args.candidateId || '',
        'Function':          args.actor || 'system',
        'Message / Details': detail,
        'Notes':             args.reason || ''
      });
      return;
    }
    var sh = getOrCreateSheet_(ASSESS_SHEETS.AUDIT_LOG, ASSESS_HEADERS.AUDIT_LOG);
    appendRowByHeader_(sh, {
      'Timestamp':      shopDateTime_(),
      'Actor':          args.actor || 'system',
      'Candidate ID':   args.candidateId || '',
      'Event':          event,
      'Previous Value': prev,
      'New Value':      next,
      'Reason':         args.reason || '',
      'Details':        args.details || ''
    });
  } catch (e) {
    try { Logger.log('logAssessmentEvent_ failed: ' + e); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — RUN ASSESSMENT FOR ONE CANDIDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full role-based assessment for one candidate. Wrapped in safeRun_ (never
 * throws) and the write phases are guarded by withLock_.
 * Returns { candidateId, status, decisionApplied, decision } or null.
 */
function runAssessmentForCandidate(candidateId) {
  return safeRun_('runAssessmentForCandidate', function () {
    if (!candidateId) return null;

    if (!CFG.getBool('ASSESSMENT_AI_ENABLED', true)) {
      logAssessmentEvent_({ candidateId: candidateId, event: 'skipped', reason: 'ASSESSMENT_AI_ENABLED=FALSE' });
      return { candidateId: candidateId, status: 'skipped' };
    }

    var cand = _getCandidateRow_(candidateId);
    if (!cand) {
      logAssessmentEvent_({ candidateId: candidateId, event: 'error',
        reason: 'Candidate not found in Interview Pipeline / All Candidates' });
      return null;
    }

    var role = cand['Role'] || cand['Role Applied'] || '';
    var registry = getAssessmentRegistryRowForRole_(role);
    if (!registry) {
      logAssessmentEvent_({ candidateId: candidateId, event: 'no_registry',
        reason: 'No active Assessment Registry row for role: ' + role,
        details: 'Add/enable a row in the Assessment Registry tab (Active=TRUE).' });
      return { candidateId: candidateId, status: 'no_registry' };
    }

    var sectionKey = registry['Assessment Section Key'];
    var rubricKey  = registry['Rubric Key'];

    // Pre-screen answers (reuse A's pre-screen payload helpers from 06).
    var raw = {};
    var psRow = _findPreScreenRow_(cand['Email'] || '');
    if (psRow) raw = _buildPreScreenPayload_(psRow) || {};

    var rubric        = loadAssessmentRubric_(rubricKey);
    var roleQuestions = loadAssessmentQuestions_(sectionKey);

    // Capture the answer trail (batched single write — see writeAssessmentResponses_).
    withLock_(function () {
      writeAssessmentResponses_(candidateId, role, sectionKey, raw, roleQuestions);
    });

    // Build payload + call A's Gemini path with the role_assessment prompt.
    var aiPayload = buildAssessmentAiPayload_(cand, raw, role, registry, rubric, roleQuestions);
    var promptKey = String(CFG.get('ASSESSMENT_PROMPT_KEY', 'role_assessment'));
    var prompt = _loadAiPrompt_(promptKey);

    var parsed = null, modelUsed = '';
    if (!prompt || !prompt['Prompt Body']) {
      logAssessmentEvent_({ candidateId: candidateId, event: 'prompt_missing',
        reason: 'AI Prompt Templates row "' + promptKey + '" not found',
        details: 'Run seedAssessmentFramework_() to install it.' });
    } else {
      var promptText = renderMerge_(prompt['Prompt Body'], {
        CandidateId: candidateId,
        RoleName:    role,
        SectionKey:  sectionKey,
        RubricKey:   rubricKey,
        Payload:     JSON.stringify(aiPayload, null, 2),
        RubricJson:  JSON.stringify(rubric),
        RoleRules:   JSON.stringify(_getRoleRule_(role) || {}),
        Provider:    CFG.get('AI_PROVIDER', 'gemini'),
        Model:       CFG.get('GEMINI_MODEL')
      });
      modelUsed = CFG.get('GEMINI_MODEL');
      var gr = _geminiGradeJson_(promptKey, candidateId, promptText);
      if (gr.ok && gr.data) parsed = _validateAssessmentJson_(gr.data);
      else logAssessmentEvent_({ candidateId: candidateId, event: 'ai_error',
        reason: 'Gemini call failed', details: truncate_(String(gr.error || ''), 300) });
    }

    // ── AI parse failure path — fail closed to human review by default. ──
    if (!parsed) {
      withLock_(function () {
        writeAssessmentResultsRow_(candidateId, role, registry, null, modelUsed, 'PARSE_FAIL', null);
      });
      logAssessmentEvent_({ candidateId: candidateId, event: 'ai_parse_fail',
        reason: 'AI returned no parsable JSON', details: 'Recorded a PARSE_FAIL result row.' });
      if (CFG.getBool('ASSESSMENT_FAIL_CLOSED', true)) {
        applyAssessmentStatus_(candidateId, STATUS.MANUAL_REVIEW, 'AI assessment parse failure; failing closed.');
      }
      _recomputeRecommendation_(candidateId);
      return { candidateId: candidateId, status: 'ai_parse_fail' };
    }

    var decision = decideFromAssessment_(parsed, registry);

    withLock_(function () {
      writeAssessmentResultsRow_(candidateId, role, registry, parsed, modelUsed, 'OK', decision);
    });

    // ── Decision application — gated by ASSESSMENT_AUTO_DECISION_ENABLED. ──
    var applied = false;
    if (CFG.getBool('ASSESSMENT_AUTO_DECISION_ENABLED', false)) {
      applyAssessmentStatus_(candidateId, decision.status, decision.reason);
      applied = true;
    } else {
      logAssessmentEvent_({ candidateId: candidateId, event: 'decision_logged_only',
        previousValue: cand['Status'], newValue: decision.status,
        reason: 'ASSESSMENT_AUTO_DECISION_ENABLED=FALSE — status not changed.',
        details: decision.reason });
    }

    _recomputeRecommendation_(candidateId);

    logAssessmentEvent_({ candidateId: candidateId, event: 'assessment_complete',
      newValue: decision.status, reason: decision.reason,
      details: 'overall=' + parsed.candidateFitScore + ' culture=' + parsed.cultureFitScore +
               ' skill=' + parsed.roleSkillScore + ' risk=' + parsed.riskLevel });

    return { candidateId: candidateId, status: 'ok', decisionApplied: applied, decision: decision };
  });
}

/**
 * Recompute hook. The assessment-blend math is added by Travis to
 * 10_Recommendation.gs; here we just call A's existing single-candidate
 * recompute if it exists. Never throws.
 */
function _recomputeRecommendation_(candidateId) {
  try {
    if (typeof computeFinalRecommendation_ === 'function') computeFinalRecommendation_(candidateId);
  } catch (e) {
    logError_('runAssessmentForCandidate.recommendation', e, candidateId, 'WARN');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture the answer trail as Assessment Responses rows. Collapsed into a
 * SINGLE batched setValues write (vs. the retiring build's per-question
 * appendRow loop) for performance.
 */
function writeAssessmentResponses_(candidateId, role, sectionKey, raw, roleQuestions) {
  var sh = getOrCreateSheet_(ASSESS_SHEETS.RESPONSES, ASSESS_HEADERS.RESPONSES);
  var headers = getHeaderRow_(sh);
  var stamp = shopDateTime_();
  var rows = []; // array of header-ordered value arrays

  function pushRow(secKey, order, question, answer) {
    var obj = {
      'Timestamp':      stamp,
      'Candidate ID':   candidateId,
      'Role':           role || '',
      'Section Key':    secKey,
      'Question Order': order,
      'Question':       question,
      'Answer':         answer == null ? '' : String(answer)
    };
    rows.push(headers.map(function (h) {
      var k = String(h).trim();
      return (k in obj) ? obj[k] : '';
    }));
  }

  // General pre-screen answers (recorded when present).
  var general = [
    'Why Interested', 'Difficult Customer Story', 'Mistake Story', 'Ownership Meaning',
    'Manager Style', 'Pay Expectations', 'Anything Else'
  ];
  var order = 0;
  general.forEach(function (q) {
    if (raw && raw[q]) { order++; pushRow('GENERAL', order, q, raw[q]); }
  });

  // Role-specific questions — record the question text + any matching answer.
  (roleQuestions || []).forEach(function (q, idx) {
    var qText = String(q['Question'] || '');
    if (!qText) return;
    var ans = String((raw && raw[qText]) || '').trim();
    pushRow(String(sectionKey || ''), Number(q['Order'] || idx + 1), qText, ans);
  });

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }
}

function buildAssessmentAiPayload_(cand, raw, role, registry, rubric, roleQuestions) {
  raw = raw || {};
  var generalAnswers = {
    why_interested:     raw['Why Interested'],
    difficult_customer: raw['Difficult Customer Story'],
    mistake:            raw['Mistake Story'],
    ownership_meaning:  raw['Ownership Meaning'],
    manager_style:      raw['Manager Style'],
    pay_expectations:   raw['Pay Expectations'],
    anything_else:      raw['Anything Else'],
    resume_link:        raw['Resume Link'] || raw['Resume Text Or Link']
  };
  var roleAnswers = {};
  (roleQuestions || []).forEach(function (q) {
    var qText = String(q['Question'] || '');
    if (qText) roleAnswers[qText] = String(raw[qText] || '').trim();
  });
  return {
    candidate_id:   cand['Candidate ID'] || '',
    candidate_name: cand['Full Name'] || ((cand['First Name'] || '') + ' ' + (cand['Last Name'] || '')).trim(),
    role:           role,
    section_key:    registry['Assessment Section Key'],
    rubric_key:     registry['Rubric Key'],
    role_thresholds: {
      culture_min:        Number(registry['Culture Min'] || 0),
      skill_min:          Number(registry['Skill Min'] || 0),
      overall_min:        Number(registry['Overall Min'] || 0),
      auto_decline_below: Number(registry['Auto Decline Below'] || 0),
      manual_review_band: String(registry['Manual Review Band'] || ''),
      auto_booking:       _assessBool_(registry['Auto Booking'])
    },
    general_answers:       generalAnswers,
    role_specific_answers: roleAnswers
  };
}

function writeAssessmentResultsRow_(candidateId, role, registry, parsed, modelUsed, status, decision) {
  var sh = getOrCreateSheet_(ASSESS_SHEETS.RESULTS, ASSESS_HEADERS.RESULTS);
  var p = parsed || {};
  appendRowByHeader_(sh, {
    'Timestamp':                     shopDateTime_(),
    'Candidate ID':                  candidateId,
    'Role':                          role || '',
    'Section Key':                   registry['Assessment Section Key'] || '',
    'Rubric Key':                    registry['Rubric Key'] || '',
    'Candidate Fit Score':           _numberOrBlank_(p.candidateFitScore),
    'Culture Fit Score':             _numberOrBlank_(p.cultureFitScore),
    'Role Skill Score':              _numberOrBlank_(p.roleSkillScore),
    'Communication Score':           _numberOrBlank_(p.communicationScore),
    'Experience Alignment Score':    _numberOrBlank_(p.experienceAlignmentScore),
    'Risk Level':                    p.riskLevel || '',
    'Recommendation':                p.recommendation || '',
    'Strengths':                     _arrayToPipe_(p.strengths),
    'Concerns':                      _arrayToPipe_(p.concerns),
    'Clarification Needed':          _arrayToPipe_(p.clarificationNeeded),
    'Suggested Interview Questions': _arrayToPipe_(p.suggestedInterviewQuestions),
    'Summary For Worksheet':         p.summaryForInterviewWorksheet || '',
    'AI Model Used':                 modelUsed || '',
    'Decision Status':               decision ? decision.status : '',
    'Decision Reason':               decision ? decision.reason : '',
    'Status':                        status || ''
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DECISION ROUTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps AI scores + Assessment Registry thresholds to one of A's STATUS values
 * plus a human-readable reason. AI never silently eliminates: a "do not
 * advance" outcome routes to MANUAL_REVIEW (A has no dedicated do-not-advance
 * status) so a human makes the final call.
 *
 * STATUS mapping (B → A):
 *   QUALIFIED_BOOKING_SENT      → STATUS.AUTO_BOOK_SENT
 *   NOT_SELECTED_PRESCREEN      → STATUS.REJECTED
 *   MANUAL_REVIEW_REQUIRED      → STATUS.MANUAL_REVIEW
 *   ASSESSMENT_REVIEW_REQUIRED  → STATUS.MANUAL_REVIEW
 *   DO_NOT_ADVANCE_CULTURE/ROLE → STATUS.MANUAL_REVIEW (human decides)
 */
function decideFromAssessment_(parsed, registry) {
  var culture      = Number(parsed.cultureFitScore || 0);
  var skill        = Number(parsed.roleSkillScore || 0);
  var overall      = Number(parsed.candidateFitScore || 0);
  var risk         = String(parsed.riskLevel || '').toUpperCase();
  var cultureMin   = Number(registry['Culture Min'] || 0);
  var skillMin     = Number(registry['Skill Min'] || 0);
  var overallMin   = Number(registry['Overall Min'] || 0);
  var declineBelow = Number(registry['Auto Decline Below'] || 0);
  var bookingOk    = _assessBool_(registry['Booking Eligible']) && _assessBool_(registry['Auto Booking']);

  if (declineBelow > 0 && overall < declineBelow) {
    return { status: STATUS.REJECTED,
      reason: 'Overall score ' + overall + ' below Auto Decline threshold ' + declineBelow + '.' };
  }
  if (risk === 'HIGH' || risk === 'CRITICAL') {
    return { status: STATUS.MANUAL_REVIEW,
      reason: 'AI risk level ' + risk + ' requires human review (overall=' + overall + ').' };
  }

  var cultureOk = culture >= cultureMin;
  var skillOk   = skill   >= skillMin;
  var overallOk = overall >= overallMin;

  if (cultureOk && skillOk && overallOk && bookingOk) {
    return { status: STATUS.AUTO_BOOK_SENT,
      reason: 'Meets all role thresholds (culture=' + culture + '/' + cultureMin +
              ', skill=' + skill + '/' + skillMin + ', overall=' + overall + '/' + overallMin +
              ') and Booking Eligible=TRUE.' };
  }
  if (!cultureOk && skillOk) {
    return { status: STATUS.MANUAL_REVIEW,
      reason: 'Culture score ' + culture + ' below threshold ' + cultureMin +
              ' (skill=' + skill + ' OK) — human review before any advance.' };
  }
  if (!skillOk && cultureOk) {
    return { status: STATUS.MANUAL_REVIEW,
      reason: 'Role skill score ' + skill + ' below threshold ' + skillMin +
              ' (culture=' + culture + ' OK) — human review before any advance.' };
  }
  return { status: STATUS.MANUAL_REVIEW,
    reason: 'Mixed results — culture=' + culture + '/' + cultureMin +
            ', skill=' + skill + '/' + skillMin + ', overall=' + overall + '/' + overallMin +
            '. Human review required.' };
}

/**
 * Apply a status change driven by the assessment. ALWAYS audited — even when
 * the status is invalid or unchanged. Uses A's _setBothStatuses_ so Interview
 * Pipeline and All Candidates stay in sync.
 */
function applyAssessmentStatus_(candidateId, newStatus, reason) {
  var cand = _getCandidateRow_(candidateId);
  var previous = cand ? cand['Status'] : '';

  var inMap = false;
  Object.keys(STATUS).forEach(function (k) { if (STATUS[k] === newStatus) inMap = true; });
  if (!inMap) {
    logAssessmentEvent_({ candidateId: candidateId, event: 'invalid_status',
      previousValue: previous, newValue: newStatus, reason: reason,
      details: 'Status not in STATUS map. No change applied.' });
    return;
  }
  if (previous === newStatus) {
    logAssessmentEvent_({ candidateId: candidateId, event: 'status_unchanged',
      previousValue: previous, newValue: newStatus, reason: reason });
    return;
  }
  _setBothStatuses_(candidateId, newStatus, 'ASSESSMENT: ' + reason);
  logAssessmentEvent_({ candidateId: candidateId, event: 'status_applied',
    previousValue: previous, newValue: newStatus, reason: reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _assessBool_(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === '1';
}

function _numberOrBlank_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function _arrayToPipe_(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(function (x) { return String(x); }).join(' | ');
  return String(v);
}

/** Normalize the AI JSON to the canonical assessment contract (never throws). */
function _validateAssessmentJson_(obj) {
  var o = (obj && typeof obj === 'object') ? obj : {};
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var k = arguments[i];
      if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    }
    return undefined;
  }
  function toNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function toArr(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x || ''); }).filter(Boolean);
    if (v === undefined || v === null || v === '') return [];
    return String(v).split(/\s*[;|\n]\s*/).filter(Boolean);
  }
  return {
    candidateFitScore:           toNum(pick('candidateFitScore', 'candidate_fit_score', 'overallScore', 'overall_score')),
    cultureFitScore:             toNum(pick('cultureFitScore', 'culture_fit_score', 'cultureScore')),
    roleSkillScore:              toNum(pick('roleSkillScore', 'role_skill_score', 'skillScore')),
    communicationScore:          toNum(pick('communicationScore', 'communication_score')),
    experienceAlignmentScore:    toNum(pick('experienceAlignmentScore', 'experience_alignment_score')),
    riskLevel:                   String(pick('riskLevel', 'risk_level', 'risk') || ''),
    recommendation:              String(pick('recommendation', 'recommended_next_step') || ''),
    strengths:                   toArr(pick('strengths', 'top_strengths')),
    concerns:                    toArr(pick('concerns', 'top_concerns')),
    clarificationNeeded:         toArr(pick('clarificationNeeded', 'clarification_needed')),
    suggestedInterviewQuestions: toArr(pick('suggestedInterviewQuestions', 'suggested_interview_questions')),
    summaryForInterviewWorksheet: String(pick('summaryForInterviewWorksheet', 'summary_for_interview_worksheet', 'summary') || '')
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MENU ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

function menuRunAssessmentForCandidate() {
  return safeRun_('menuRunAssessmentForCandidate', function () {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.prompt('Run Role Assessment', 'Candidate ID:', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    var id = resp.getResponseText().trim();
    if (!id) return;
    var r = runAssessmentForCandidate(id);
    ui.alert('Assessment result:\n\n' + JSON.stringify(r, null, 2));
    return r;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SEEDING — question bank + rubrics + AI prompt. (Registry is NOT re-seeded;
// A already owns it via SEED_ASSESSMENT_REGISTRY in 03_Seed_Templates.gs.)
// Keys here MUST match A's Assessment Registry values:
//   Section Keys: ASSESS_SERVICE_ADVISOR, ASSESS_TECHNICIAN, ASSESS_LUBE_TECH,
//                 ASSESS_VALET_PORTER, ASSESS_PARTS, ASSESS_CX, ASSESS_ADMIN,
//                 ASSESS_SHOP_FOREMAN
//   Rubric Keys:  RUBRIC_<role> (same suffixes)
// ─────────────────────────────────────────────────────────────────────────────

function seedAssessmentFramework_() {
  return withLock_(function () {
    var q = seedAssessmentQuestionBankDefaults_();
    var r = seedAssessmentRubricsDefaults_();
    var p = seedAssessmentAiPrompt_();
    var msg = '[ASSESS] seedAssessmentFramework_ — questions:' + q + ' rubricRows:' + r + ' prompt:' + p;
    Logger.log(msg);
    toast_('Assessment framework seeds refreshed.', 'Recruiting OS', 5);
    return msg;
  });
}

/** Idempotent: key = Section Key + '||' + Order. Returns # rows added. */
function seedAssessmentQuestionBankDefaults_() {
  var sh = getOrCreateSheet_(ASSESS_SHEETS.QUESTION_BANK, ASSESS_HEADERS.QUESTION_BANK);
  var existing = {};
  if (sh.getLastRow() >= 2) {
    var hdr = getHeaderRow_(sh);
    var sc = hdr.indexOf('Section Key'), oc = hdr.indexOf('Order');
    sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues().forEach(function (row) {
      existing[String(row[sc]).trim() + '||' + String(row[oc]).trim()] = true;
    });
  }
  var rows = [];
  function add(section, order, q, type, required, choices, weight) {
    rows.push(['TRUE', section, order, q, type, required ? 'TRUE' : 'FALSE', choices || '', weight, '']);
  }

  // SERVICE ADVISOR
  add('ASSESS_SERVICE_ADVISOR', 1, 'Why are you interested in the Service Advisor role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_SERVICE_ADVISOR', 2, 'How would you explain diagnostic time to a customer who wants an answer immediately?', 'Paragraph', true, '', 15);
  add('ASSESS_SERVICE_ADVISOR', 3, 'A customer says, "That is way more than I expected." How would you respond?', 'Paragraph', true, '', 15);
  add('ASSESS_SERVICE_ADVISOR', 4, 'A technician finds additional safety concerns after the customer already approved work. What do you do next?', 'Paragraph', true, '', 15);
  add('ASSESS_SERVICE_ADVISOR', 5, 'How do you create urgency without pressure?', 'Paragraph', true, '', 10);
  // TECHNICIAN
  add('ASSESS_TECHNICIAN', 1, 'Why are you interested in working as a Technician at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_TECHNICIAN', 2, 'Describe your diagnostic process for an intermittent no-start concern.', 'Paragraph', true, '', 15);
  add('ASSESS_TECHNICIAN', 3, 'What information should be documented before recommending a repair?', 'Paragraph', true, '', 15);
  add('ASSESS_TECHNICIAN', 4, 'What diagnostic steps would you take before replacing a control module?', 'Paragraph', true, '', 15);
  add('ASSESS_TECHNICIAN', 5, 'A vehicle returns with the same concern after repair. What do you do first?', 'Paragraph', true, '', 15);
  // LUBE TECH
  add('ASSESS_LUBE_TECH', 1, 'Why are you interested in the Lube Tech role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_LUBE_TECH', 2, 'What steps should be followed before, during, and after an oil service?', 'Paragraph', true, '', 15);
  add('ASSESS_LUBE_TECH', 3, 'How would you inspect a vehicle and document visible concerns without exaggerating or guessing?', 'Paragraph', true, '', 15);
  add('ASSESS_LUBE_TECH', 4, 'What would you do if you made a mistake during a service?', 'Paragraph', true, '', 15);
  add('ASSESS_LUBE_TECH', 5, 'What does safety mean when working around customer vehicles?', 'Paragraph', true, '', 10);
  // VALET / PORTER
  add('ASSESS_VALET_PORTER', 1, 'Why are you interested in the Valet / Porter role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_VALET_PORTER', 2, 'What steps should you take before moving a customer vehicle?', 'Paragraph', true, '', 15);
  add('ASSESS_VALET_PORTER', 3, 'A customer’s vehicle is not ready when they arrive. How would you handle the interaction?', 'Paragraph', true, '', 15);
  add('ASSESS_VALET_PORTER', 4, 'What would you do if you noticed damage on a vehicle before moving it?', 'Paragraph', true, '', 15);
  add('ASSESS_VALET_PORTER', 5, 'What does professionalism look like when interacting with customers?', 'Paragraph', true, '', 10);
  // PARTS
  add('ASSESS_PARTS', 1, 'Why are you interested in the Parts role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_PARTS', 2, 'What information do you need before ordering a European vehicle part?', 'Paragraph', true, '', 15);
  add('ASSESS_PARTS', 3, 'A part arrives incorrect and the vehicle is promised today. What do you do?', 'Paragraph', true, '', 15);
  add('ASSESS_PARTS', 4, 'How would you track vendor invoice numbers, warranty information, ETAs, and part availability?', 'Paragraph', true, '', 15);
  add('ASSESS_PARTS', 5, 'How do you balance speed and accuracy in a parts department?', 'Paragraph', true, '', 10);
  // CX
  add('ASSESS_CX', 1, 'Why are you interested in the Customer Experience role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_CX', 2, 'What does an excellent customer experience feel like to the customer?', 'Paragraph', true, '', 15);
  add('ASSESS_CX', 3, 'A customer is frustrated because they expected faster communication. What do you do?', 'Paragraph', true, '', 15);
  add('ASSESS_CX', 4, 'How would you follow up with a customer after service to make sure they felt taken care of?', 'Paragraph', true, '', 15);
  add('ASSESS_CX', 5, 'How do you stay positive and professional during a busy or stressful day?', 'Paragraph', true, '', 10);
  // ADMIN
  add('ASSESS_ADMIN', 1, 'Why are you interested in the Admin role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_ADMIN', 2, 'How do you stay organized when managing several tasks, deadlines, or requests at once?', 'Paragraph', true, '', 15);
  add('ASSESS_ADMIN', 3, 'What would you do if you found an error in a report, form, or spreadsheet that had already been shared?', 'Paragraph', true, '', 15);
  add('ASSESS_ADMIN', 4, 'How do you handle confidential employee, customer, or business information?', 'Paragraph', true, '', 15);
  add('ASSESS_ADMIN', 5, 'Describe your process for completing repetitive work accurately.', 'Paragraph', true, '', 10);
  // SHOP FOREMAN
  add('ASSESS_SHOP_FOREMAN', 1, 'Why are you interested in the Shop Foreman role at Frank’s European Service?', 'Paragraph', true, '', 5);
  add('ASSESS_SHOP_FOREMAN', 2, 'A technician repeatedly submits incomplete diagnostic notes. How do you address it?', 'Paragraph', true, '', 15);
  add('ASSESS_SHOP_FOREMAN', 3, 'How do you decide whether a vehicle is ready to move forward in the workflow?', 'Paragraph', true, '', 15);
  add('ASSESS_SHOP_FOREMAN', 4, 'Two technicians disagree about the cause of a failure. How do you handle it?', 'Paragraph', true, '', 15);
  add('ASSESS_SHOP_FOREMAN', 5, 'How do you prevent comebacks and rechecks from becoming repeated patterns?', 'Paragraph', true, '', 10);

  var toAppend = rows.filter(function (r) {
    return !existing[String(r[1]).trim() + '||' + String(r[2]).trim()];
  });
  if (toAppend.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, ASSESS_HEADERS.QUESTION_BANK.length).setValues(toAppend);
  }
  return toAppend.length;
}

/**
 * 6 rubric keys, weighting 30/35/15/10/10 across the five canonical categories.
 * Idempotent: key = Rubric Key + '||' + Category. Returns # rows added.
 * (RUBRIC_LUBE_TECH and RUBRIC_VALET_PORTER are also covered so all 8 roles
 * resolve to a rubric — only 6 unique weighting profiles per the brief.)
 */
function seedAssessmentRubricsDefaults_() {
  var sh = getOrCreateSheet_(ASSESS_SHEETS.RUBRICS, ASSESS_HEADERS.RUBRICS);
  var existing = {};
  if (sh.getLastRow() >= 2) {
    var hdr = getHeaderRow_(sh);
    var rc = hdr.indexOf('Rubric Key'), cc = hdr.indexOf('Category');
    sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues().forEach(function (row) {
      existing[String(row[rc]).trim() + '||' + String(row[cc]).trim()] = true;
    });
  }
  function rowsFor(rubricKey, cultureThresh) {
    return [
      ['TRUE', rubricKey, 'Culture Fit',           30, 'Ownership, coachability, communication, dependability, team fit. Penalize blame.', cultureThresh, ''],
      ['TRUE', rubricKey, 'Role Skill Fit',         35, 'Depth and accuracy of role-specific answers (Assessment Question Bank).',          75, ''],
      ['TRUE', rubricKey, 'Communication Quality',  15, 'Clarity, structure, professionalism.',                                              75, ''],
      ['TRUE', rubricKey, 'Experience Alignment',   10, 'Stated experience matches resume and role requirements.',                           65, ''],
      ['TRUE', rubricKey, 'Risk Review',            10, 'Inconsistencies, evasiveness, AI-style polish without voice.',                      75, '']
    ];
  }
  var all = [];
  [
    ['RUBRIC_SERVICE_ADVISOR', 80], ['RUBRIC_TECHNICIAN', 75], ['RUBRIC_LUBE_TECH', 75],
    ['RUBRIC_VALET_PORTER', 80], ['RUBRIC_PARTS', 75], ['RUBRIC_CX', 82],
    ['RUBRIC_ADMIN', 78], ['RUBRIC_SHOP_FOREMAN', 85]
  ].forEach(function (pair) {
    rowsFor(pair[0], pair[1]).forEach(function (r) { all.push(r); });
  });
  var toAppend = all.filter(function (r) {
    return !existing[String(r[1]).trim() + '||' + String(r[2]).trim()];
  });
  if (toAppend.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, ASSESS_HEADERS.RUBRICS.length).setValues(toAppend);
  }
  return toAppend.length;
}

/** Upsert the role_assessment AI prompt into A's AI Prompt Templates. Returns 'added'|'exists'|'no-sheet'. */
function seedAssessmentAiPrompt_() {
  var sh = getSheetOrNull_(SHEETS.AI_PROMPTS);
  if (!sh) return 'no-sheet';
  var key = String(CFG.get('ASSESSMENT_PROMPT_KEY', 'role_assessment'));
  if (findRowsByColumnValue_(sh, 'Prompt Key', key).length) return 'exists';
  appendRowByHeader_(sh, {
    'Prompt Key':  key,
    'Phase':       'Assessment',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body': _buildAssessmentPromptBody_(),
    'Notes':       'Role-based pre-screen assessment prompt — strict JSON. AI scores and flags; humans hold final authority.'
  });
  return 'added';
}

function _buildAssessmentPromptBody_() {
  return [
    'You are scoring a job candidate for an automotive shop. The candidate selected a role, and you are given',
    '(a) their pre-screen answers, (b) any role-specific answers, (c) the role\'s rubric with weights, and',
    '(d) the role\'s thresholds.',
    '',
    'ROLE: {{RoleName}}',
    'SECTION KEY: {{SectionKey}}',
    'RUBRIC KEY: {{RubricKey}}',
    '',
    'PAYLOAD:',
    '{{Payload}}',
    '',
    'RUBRIC:',
    '{{RubricJson}}',
    '',
    'ROLE RULES:',
    '{{RoleRules}}',
    '',
    'Do NOT eliminate the candidate yourself. Your job is to score, summarize, and flag — humans hold final',
    'authority. Reward specificity, ownership, and realism. Penalize blame, evasiveness, and over-polished',
    'AI-style answers without voice.',
    '',
    'Return STRICT JSON only. No prose outside JSON. Your entire response must start with "{" and end with "}".',
    'Schema:',
    '{',
    '  "candidateFitScore": number,        // 0-100 weighted composite per rubric',
    '  "cultureFitScore": number,          // 0-100',
    '  "roleSkillScore": number,           // 0-100',
    '  "communicationScore": number,       // 0-100',
    '  "experienceAlignmentScore": number, // 0-100',
    '  "riskLevel": "Low" | "Medium" | "High" | "Critical",',
    '  "recommendation": string,',
    '  "strengths": [string, string, string],',
    '  "concerns": [string, string, string],',
    '  "clarificationNeeded": [string],',
    '  "suggestedInterviewQuestions": [string, string, string],',
    '  "summaryForInterviewWorksheet": string',
    '}'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — exercises decideFromAssessment_ threshold edge cases (read-only).
// ─────────────────────────────────────────────────────────────────────────────

function ASSESSMENT_selfTest() {
  var out = ['[ASSESSMENT] selfTest (read-only)…'];

  // A representative Technician-style registry row.
  var reg = {
    'Active': 'TRUE', 'Role': 'Technician', 'Assessment Section Key': 'ASSESS_TECHNICIAN',
    'Rubric Key': 'RUBRIC_TECHNICIAN', 'Culture Min': 75, 'Skill Min': 78, 'Overall Min': 78,
    'Auto Decline Below': 55, 'Manual Review Band': '56-77', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE'
  };

  function check(label, parsed, expected) {
    var d = decideFromAssessment_(parsed, reg);
    var ok = d.status === expected;
    out.push('  ' + (ok ? '✓' : '✗') + ' ' + label + ' → ' + d.status +
             (ok ? '' : ' (expected ' + expected + ')'));
    return ok;
  }

  var allOk = true;
  // 1) Auto Decline Below: overall under 55 → REJECTED.
  allOk &= check('overall 40 < AutoDeclineBelow 55', { candidateFitScore: 40, cultureFitScore: 90, roleSkillScore: 90, riskLevel: 'Low' }, STATUS.REJECTED);
  // 2) Booking Eligible && Auto Booking && all thresholds met → AUTO_BOOK_SENT.
  allOk &= check('all thresholds met + booking eligible', { candidateFitScore: 90, cultureFitScore: 90, roleSkillScore: 90, riskLevel: 'Low' }, STATUS.AUTO_BOOK_SENT);
  // 3) High risk → MANUAL_REVIEW even with strong scores.
  allOk &= check('high risk overrides', { candidateFitScore: 95, cultureFitScore: 95, roleSkillScore: 95, riskLevel: 'High' }, STATUS.MANUAL_REVIEW);
  // 4) Culture below threshold → MANUAL_REVIEW (AI never auto-eliminates on culture).
  allOk &= check('culture below threshold', { candidateFitScore: 80, cultureFitScore: 60, roleSkillScore: 90, riskLevel: 'Low' }, STATUS.MANUAL_REVIEW);
  // 5) Skill below threshold → MANUAL_REVIEW.
  allOk &= check('skill below threshold', { candidateFitScore: 80, cultureFitScore: 90, roleSkillScore: 60, riskLevel: 'Low' }, STATUS.MANUAL_REVIEW);

  // Fail-closed config sanity (default FALSE auto-decision, TRUE fail-closed).
  out.push('  ─ ASSESSMENT_AI_ENABLED            : ' + CFG.getBool('ASSESSMENT_AI_ENABLED', true));
  out.push('  ─ ASSESSMENT_AUTO_DECISION_ENABLED : ' + CFG.getBool('ASSESSMENT_AUTO_DECISION_ENABLED', false) + ' (default FALSE = log-only)');
  out.push('  ─ ASSESSMENT_FAIL_CLOSED           : ' + CFG.getBool('ASSESSMENT_FAIL_CLOSED', true));

  // Fail-closed when AI parse fails: a null/empty parse must yield MANUAL_REVIEW intent.
  var failParse = _validateAssessmentJson_(null); // all zeros, blank risk
  var failDecision = decideFromAssessment_(failParse, reg);
  // overall 0 < declineBelow 55 → REJECTED would be auto-decline, but runAssessmentForCandidate
  // routes parse failures to MANUAL_REVIEW directly (fail-closed) and never reaches decide.
  out.push('  ─ parse-fail handling: runAssessmentForCandidate routes to STATUS.MANUAL_REVIEW (fail-closed); ' +
           'decideFromAssessment_ on zeros → ' + failDecision.status);

  // Prompt presence.
  var prompt = _loadAiPrompt_(String(CFG.get('ASSESSMENT_PROMPT_KEY', 'role_assessment')));
  out.push('  ' + (prompt ? '✓' : '✗') + ' role_assessment prompt ' + (prompt ? 'present' : 'MISSING — run seedAssessmentFramework_()'));

  out.push('[ASSESSMENT] selfTest ' + (allOk ? 'PASS' : 'FAIL'));
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
