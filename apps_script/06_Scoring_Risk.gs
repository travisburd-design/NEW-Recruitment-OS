/**
 * 06_Scoring_Risk.gs
 * Frank's European Service — Recruiting OS
 *
 * AI-powered Pre-Screen scoring and post-score routing.
 *
 *   scorePreScreen_(candidateId)
 *     → load candidate + matching Pre-Screen response row
 *     → load 'prescreen' AI prompt + role rule
 *     → call Gemini with JSON-only response format
 *     → write AI Score / Risk Score / Total Score / Score Tier / Status
 *     → dispatch follow-up emails per routing decision:
 *         AUTO_BOOK     → phone_screen_booking (or technician_post_prescreen)
 *         MANUAL_REVIEW → no candidate email; manager triages via dropdown
 *         HARD_REJECT   → gracious_decline (delayed by REJECTION_EMAIL_DELAY_DAYS,
 *                         cancellable until send moment)
 *
 *   Routing is role-aware: thresholds come from Role Rules row, falling
 *   back to Config defaults. Manual review band catches the diamond-in-rough
 *   zone when DIAMOND_IN_ROUGH_ENABLED=TRUE.
 *
 *   Gemini call is the temporary home for callGemini_-style logic; when
 *   09_AI_Grading.gs lands it will export the canonical engine used by
 *   transcript grading too. The function names here are underscore-prefixed
 *   so they will not collide.
 *
 * Public functions:
 *   scorePreScreen_(candidateId)
 *   rescoreCandidate(candidateId)   — manual repair entry
 *   SCORING_selfTest()              — read-only sanity check
 *   SCORING_pingGemini()            — live single-call connectivity test
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: scorePreScreen_
// ─────────────────────────────────────────────────────────────────────────────

function scorePreScreen_(candidateId) {
  if (!candidateId) { logError_('scorePreScreen_', 'no candidateId provided', '', 'WARN'); return null; }
  if (!CFG.getBool('AI_GRADING_ENABLED', true)) {
    logEvent_('SCORING_SKIPPED', candidateId, 'AI_GRADING_ENABLED is FALSE');
    return null;
  }

  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var candidate = _getCandidateRow_(candidateId); // defined in 14_Email_Queue.gs
  if (!candidate) {
    logError_('scorePreScreen_', 'candidate not found: ' + candidateId, candidateId, 'ERROR');
    return null;
  }

  var psRow = _findPreScreenRow_(candidate['Email']);
  if (!psRow) {
    logError_('scorePreScreen_', 'no Pre-Screen response found for ' + candidate['Email'], candidateId, 'WARN');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.MANUAL_REVIEW,
      'Notes':        'No matching Pre-Screen response found — manual review',
      'Last Updated': shopDateTime_()
    });
    return null;
  }

  var payload = _buildPreScreenPayload_(psRow);
  var keyCount = Object.keys(payload).length;
  if (keyCount < 3) {
    logError_('scorePreScreen_', 'payload too sparse (' + keyCount + ' fields)', candidateId, 'WARN');
    return null;
  }

  var prompt = _loadAiPrompt_('prescreen');
  if (!prompt) {
    logError_('scorePreScreen_', 'AI Prompt Templates row for "prescreen" not found', candidateId, 'ERROR');
    return null;
  }

  var roleRule = _getRoleRule_(candidate['Role']);
  var promptText = renderMerge_(prompt['Prompt Body'], {
    Payload:          JSON.stringify(payload, null, 2),
    RoleName:         candidate['Role'],
    RoleRequirements: (roleRule && roleRule['Notes']) || '(see Role Rules)',
    Provider:         CFG.get('AI_PROVIDER', 'gemini'),
    Model:            CFG.get('GEMINI_MODEL')
  });

  var result = _geminiGradeJson_('prescreen', candidateId, promptText);
  if (!result.ok) {
    logError_('scorePreScreen_:aiFailed', result.error || 'unknown', candidateId, 'ERROR');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.MANUAL_REVIEW,
      'Notes':        truncate_('AI scoring failed: ' + (result.error || ''), 300),
      'Last Updated': shopDateTime_()
    });
    return null;
  }

  var ai = validatePreScreenGradeJson_(result.data);
  var risk  = ai.ai_risk_score;

  // SAFETY GATE: the AI returned valid JSON but no usable numeric score. Do NOT
  // route this through scoring (a missing score reads as 0 → below every
  // hard-reject floor → a qualified candidate is silently declined). Park in
  // MANUAL_REVIEW with a blank score so a human decides. Never auto-reject here.
  if (!ai.ai_score_present) {
    logError_('scorePreScreen_:noScore',
      'AI returned no numeric ai_score — routed to MANUAL_REVIEW (not rejected)', candidateId, 'WARN');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'AI Score':                '',
      'Risk Score':              risk,
      'Total Score':             '',
      'Score Tier':              'Review',
      'Status':                  STATUS.MANUAL_REVIEW,
      'Notes':                   truncate_('AI returned no numeric score — MANUAL REVIEW (not rejected). ' + (ai.summary || ''), 500),
      'AI-Authored Likelihood':  ai.ai_authored_likelihood || 0,
      'AI-Authored Reasoning':   truncate_(ai.ai_authored_reasoning || '', 300),
      'Last Updated':            shopDateTime_()
    });
    logEvent_('CANDIDATE_SCORE_MISSING', candidateId, { risk: risk, role: candidate['Role'] });
    // F4: still write the Risk Flags audit row for review-routed candidates.
    if (CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true) &&
        typeof applyDeterministicBackstop_ === 'function') {
      safeRun_('scoring:riskFlagsAudit:noScore', function () { applyDeterministicBackstop_(candidateId); });
    }
    if (!CFG.getBool('HIRING_PAUSE_MODE', false)) {
      safeRun_('scoring:pipelineRow:noScore', function () {
        _ensureInterviewPipelineRow_(candidateId, {
          status: STATUS.MANUAL_REVIEW, stage: 'Pre-screen — AI score missing, needs review', via: 'scoring'
        });
        var ipn = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
        if (ipn) updateRowWhere_(ipn, 'Candidate ID', candidateId, {
          'Status': STATUS.MANUAL_REVIEW, 'Risk Score': risk, 'Last Updated': shopDateTime_()
        });
      });
    }
    return { candidateId: candidateId, score: null, risk: risk, tier: 'Review', action: 'MANUAL_REVIEW', scoreMissing: true };
  }

  var score = ai.ai_score;
  var tier    = _scoreToTier_(score);
  var routing = _routeCandidate_(score, risk, roleRule);

  // ── Deterministic backstop (advisory unless DETERMINISTIC_BACKSTOP_ENFORCE) ──
  // Cheap, explainable, LLM-independent cross-check (33_Deterministic_Risk.gs).
  // Never rejects; at most it escalates an AI AUTO_BOOK to MANUAL_REVIEW when a
  // hard disqualifier / high deterministic risk was present but the AI did not
  // already route to review/rejection. The full audit row is written by the
  // standalone applyDeterministicBackstop_/runDeterministicRiskReview paths.
  if (CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true) &&
      typeof getDeterministicSignals_ === 'function') {
    var det = getDeterministicSignals_(payload, roleRule);
    var alreadyFlagged = (routing.status === STATUS.MANUAL_REVIEW || routing.status === STATUS.REJECTED);
    if ((det.hardDq || det.highRisk) && !alreadyFlagged) {
      logEvent_('DET_BACKSTOP_DISAGREE', candidateId, {
        aiAction: routing.action, aiStatus: routing.status,
        hardDq: det.hardDq, detRisk: det.risk, flags: det.flags, dqReasons: det.dqReasons
      });
      if (CFG.getBool('DETERMINISTIC_BACKSTOP_ENFORCE', false)) {
        routing = { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW }; // never REJECT
      }
    }
  }

  updateRowWhere_(ac, 'Candidate ID', candidateId, {
    'AI Score':                score,
    'Risk Score':              risk,
    'Total Score':             score,
    'Score Tier':              tier,
    'Status':                  routing.status,
    'Notes':                   truncate_(ai.summary || '', 500),
    'AI-Authored Likelihood':  ai.ai_authored_likelihood || 0,
    'AI-Authored Reasoning':   truncate_(ai.ai_authored_reasoning || '', 300),
    'Last Updated':            shopDateTime_()
  });

  logEvent_('CANDIDATE_SCORED', candidateId, {
    score: score, risk: risk, tier: tier, action: routing.action, status: routing.status,
    role: candidate['Role']
  });

  // F4: write the deterministic Risk Flags audit row inline on the live scoring
  // path so the "Risk Flags" tab actually fills for every scored candidate
  // (previously its only writer was a manual menu item, so the tab was always
  // empty). applyDeterministicBackstop_ is advisory by default — it records the
  // audit row and never auto-rejects.
  if (CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true) &&
      typeof applyDeterministicBackstop_ === 'function') {
    safeRun_('scoring:riskFlagsAudit', function () { applyDeterministicBackstop_(candidateId); });
  }

  // Surface the candidate in the manager-facing Interview Pipeline. Intake (05)
  // writes only to All Candidates, but the dropdown decisions, booking poll,
  // transcript grading, recommendation engine, daily-digest action list, and
  // worksheets all read/update the pipeline by existing row — so a candidate
  // with no pipeline row is invisible and unactionable. Hard rejects are done;
  // paused candidates park in the drawer (All Candidates only, by design). Every
  // live route (AUTO_BOOK / MANUAL_REVIEW) gets a pipeline row + synced scores.
  if (routing.status !== STATUS.REJECTED && !CFG.getBool('HIRING_PAUSE_MODE', false)) {
    safeRun_('scoring:pipelineRow', function () {
      _ensureInterviewPipelineRow_(candidateId, {
        status: routing.status, stage: 'Pre-screen scored — review', via: 'scoring'
      });
      var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
      if (ip) updateRowWhere_(ip, 'Candidate ID', candidateId, {
        'Status':           routing.status,
        'Score':            score,
        'Pre-Screen Score': score,
        'Risk Score':       risk,
        'Last Updated':     shopDateTime_()
      });
    });
  }

  // Dispatch follow-up emails per routing
  safeRun_('scoring:dispatchEmails', function () {
    _dispatchPostScoringEmails_(candidateId, candidate, score, risk, routing);
  });

  // Auto-run the role assessment for candidates who are not hard-rejected, so the
  // Assessment Responses / AI Assessment Results / Assessment Audit Log tabs
  // collect. Safe: assessment auto-DECISION is separately gated (default off), so
  // this only scores and logs — it never changes status or rejects a candidate.
  if (routing.status !== STATUS.REJECTED &&
      CFG.getBool('ASSESSMENT_AUTO_RUN_ENABLED', true) &&
      typeof runAssessmentForCandidate === 'function') {
    safeRun_('scoring:assessment', function () { runAssessmentForCandidate(candidateId); });
  }

  return { candidateId: candidateId, score: score, risk: risk, tier: tier, action: routing.action };
}

/** Manual re-score (e.g., after candidate updates info or AI was previously off). */
function rescoreCandidate(candidateId) {
  return withLock_(function () { return scorePreScreen_(candidateId); });
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY: find & re-score candidates that the old "missing score → 0" bug
// may have auto-rejected. A genuine hard-reject scores 1–19; the bug's signature
// is a REJECTED row whose AI Score is blank or exactly 0. These tools are safe to
// run repeatedly. SCORING_auditAutoRejects is read-only; SCORING_recoverAutoRejects
// re-scores the suspects through the now-fixed path (which can no longer reject on
// a missing score).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only. Scans All Candidates for REJECTED rows whose AI Score is blank or 0
 * (the fingerprint of the missing-score auto-reject bug). Logs + toasts a summary
 * and returns { suspects:[{candidateId,name,role,score,hasPreScreen}], total }.
 */
function SCORING_auditAutoRejects() {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var idC = getColIndex_(ac, 'Candidate ID');
  if (!idC) {
    toast_('All Candidates has no "Candidate ID" column — run Bootstrap / Repair first.', 'Audit blocked', 8);
    return { suspects: [], total: 0, blocked: true };
  }
  var last = ac.getLastRow();
  if (last < 2) return { suspects: [], total: 0 };
  var headers = getHeaderRow_(ac);
  var rows = ac.getRange(2, 1, last - 1, headers.length).getValues();
  function col(name) { return getColIndex_(ac, name) - 1; }
  var cStatus = col('Status'), cScore = col('AI Score'), cTotal = col('Total Score'),
      cId = col('Candidate ID'), cFn = col('First Name'), cLn = col('Last Name'),
      cEmail = col('Email'), cRole = col('Role');
  var suspects = [];
  rows.forEach(function (r) {
    var status = String(r[cStatus] || '').trim().toUpperCase();
    if (status !== String(STATUS.REJECTED).toUpperCase()) return;
    var rawScore = cScore >= 0 ? r[cScore] : '';
    if (rawScore === '' && cTotal >= 0) rawScore = r[cTotal];
    var blank = (rawScore === '' || rawScore === null || rawScore === undefined);
    var zero = !blank && parseInt(rawScore, 10) === 0;
    if (!(blank || zero)) return; // a real hard-reject (1–19) is left alone
    var email = cEmail >= 0 ? String(r[cEmail] || '') : '';
    suspects.push({
      candidateId: String(r[cId] || ''),
      name: ((cFn >= 0 ? r[cFn] : '') + ' ' + (cLn >= 0 ? r[cLn] : '')).trim(),
      role: cRole >= 0 ? String(r[cRole] || '') : '',
      score: blank ? '(blank)' : 0,
      hasPreScreen: email ? !!_findPreScreenRow_(email) : false
    });
  });
  logEvent_('AUTOREJECT_AUDIT', '', { total: suspects.length, withPreScreen: suspects.filter(function (s) { return s.hasPreScreen; }).length });
  toast_(suspects.length + ' rejected candidate(s) have a blank/0 AI score (possible wrongful auto-reject). ' +
    'Run "Recover Wrongly Auto-Rejected" to re-score them.', 'Auto-reject audit', 10);
  return { suspects: suspects, total: suspects.length };
}

/**
 * Re-scores every suspect from SCORING_auditAutoRejects through the fixed path.
 * Legitimately weak candidates may re-reject; those wrongly rejected on a missing
 * score now land in MANUAL_REVIEW. Honors SYSTEM_MODE (TEST reroutes all email to
 * the test recipient), so it is safe to run while in TEST. Returns a tally.
 */
function SCORING_recoverAutoRejects() {
  var audit = SCORING_auditAutoRejects();
  if (audit.blocked) return audit;
  var recovered = 0, stillRejected = 0, errors = 0;
  audit.suspects.forEach(function (s) {
    if (!s.candidateId) return;
    try {
      var res = withLock_(function () { return scorePreScreen_(s.candidateId); });
      if (res && (res.action === 'MANUAL_REVIEW' || res.action === 'AUTO_BOOK' || res.scoreMissing)) recovered++;
      else if (res && res.action === 'HARD_REJECT') stillRejected++;
    } catch (e) {
      errors++;
      logError_('SCORING_recoverAutoRejects', String(e), s.candidateId, 'WARN');
    }
  });
  logEvent_('AUTOREJECT_RECOVERY', '', { suspects: audit.total, recovered: recovered, stillRejected: stillRejected, errors: errors });
  toast_('Re-scored ' + audit.total + ' suspect(s): ' + recovered + ' recovered to review/auto-book, ' +
    stillRejected + ' genuinely below floor, ' + errors + ' errors.', 'Recovery complete', 12);
  return { suspects: audit.total, recovered: recovered, stillRejected: stillRejected, errors: errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING
// ─────────────────────────────────────────────────────────────────────────────

function _scoreToTier_(score) {
  if (score >= CFG.getInt('PRIORITY_CANDIDATE_THRESHOLD', 80)) return 'Priority';
  if (score >= CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD',    60)) return 'Strong';
  if (score >= CFG.getInt('BELOW_MIN_SCORE_THRESHOLD',    40)) return 'Review';
  if (score >= CFG.getInt('HARD_REJECT_SCORE_THRESHOLD',  20)) return 'Weak';
  return 'Hard Reject';
}

/**
 * Returns { action, status } given (score, risk, roleRule).
 * Thresholds: Role Rules row first; Config defaults as fallback.
 */
function _routeCandidate_(score, risk, roleRule) {
  function n(v, dflt) { var x = parseInt(v, 10); return isNaN(x) ? dflt : x; }

  var minScore   = roleRule ? n(roleRule['Minimum Score'],                  CFG.getInt('MIN_PRESCREEN_SCORE',           60))
                            : CFG.getInt('MIN_PRESCREEN_SCORE', 60);
  var autoMin    = roleRule ? n(roleRule['Auto Booking Minimum Score'],     CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD',     60))
                            : CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD', 60);
  var hardReject = roleRule ? n(roleRule['Hard Reject Score'],              CFG.getInt('HARD_REJECT_SCORE_THRESHOLD',   20))
                            : CFG.getInt('HARD_REJECT_SCORE_THRESHOLD', 20);
  var maxRisk    = roleRule ? n(roleRule['Max Risk Score For Auto Booking'],CFG.getInt('MAX_RISK_SCORE_AUTOBOOK',        2))
                            : CFG.getInt('MAX_RISK_SCORE_AUTOBOOK', 2);
  var autoBookOK = !roleRule || String(roleRule['Auto Send Booking']).trim().toUpperCase() === 'TRUE';

  // 1) AUTO_BOOK: high score + low risk + role allows it
  if (score >= autoMin && risk <= maxRisk && autoBookOK) {
    return { action: 'AUTO_BOOK', status: STATUS.AUTO_BOOK_SENT };
  }
  // 2) HARD_REJECT: below the floor
  if (score < hardReject) {
    return { action: 'HARD_REJECT', status: STATUS.REJECTED };
  }
  // 3) MANUAL_REVIEW: in the role's review band OR the diamond zone
  return { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW };
}

function _dispatchPostScoringEmails_(candidateId, candidate, score, risk, routing) {
  // Pause Mode: candidate completed the pre-screen but we are not actively hiring.
  // Send a warm "not currently hiring" response and park them in the drawer.
  if (CFG.getBool('HIRING_PAUSE_MODE', false)) {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.IN_DRAWER,
      'Notes':        truncate_('Pause mode active at scoring time — pre-screen scored ' + score + ', parked in drawer with not-hiring response', 500),
      'Last Updated': shopDateTime_()
    });
    sendTemplatedEmail_('not_currently_hiring', candidate['Email'], candidateId, null, {
      reason: 'hiring pause mode — score=' + score
    });
    logEvent_('CANDIDATE_PAUSED', candidateId, { score: score, risk: risk, role: candidate['Role'] });
    return;
  }

  if (routing.action === 'AUTO_BOOK') {
    if (!CFG.getBool('AUTO_BOOKING_ENABLED', true)) {
      // F15: a candidate who should get a booking link gets nothing — record WHY
      // so the skip is visible in the Event Log / digest, not a silent failure.
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'AUTO_BOOKING_ENABLED=FALSE', wouldHaveSent: 'booking', score: score });
      return;
    }
    var role = candidate['Role'];
    if (role === 'Technician' && score >= CFG.getInt('TECH_SKILL_TEST_MIN_SCORE', 60)) {
      // Combined: book phone screen + send skill test
      sendTemplatedEmail_('technician_post_prescreen', candidate['Email'], candidateId, null, {
        reason: 'auto-book + skill test (technician, score=' + score + ')'
      });
    } else {
      sendTemplatedEmail_('phone_screen_booking', candidate['Email'], candidateId, null, {
        reason: 'auto-book (score=' + score + ', risk=' + risk + ')'
      });
    }
  } else if (routing.action === 'HARD_REJECT') {
    if (!CFG.getBool('AUTO_REJECTION_ENABLED', true)) {
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'AUTO_REJECTION_ENABLED=FALSE', wouldHaveSent: 'gracious_decline', score: score });
      return;
    }
    if (!CFG.getBool('SEND_REJECTION_EMAIL', true)) {
      logEvent_('EMAIL_SKIPPED', candidateId, { reason: 'SEND_REJECTION_EMAIL=FALSE', wouldHaveSent: 'gracious_decline', score: score });
      return;
    }
    var delayDays = CFG.getInt('REJECTION_EMAIL_DELAY_DAYS', 5);
    var sendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000);
    sendTemplatedEmail_('gracious_decline', candidate['Email'], candidateId, null, {
      sendAt:           sendAt,
      cancellableUntil: sendAt,
      reason:           'auto-reject after hard-reject scoring (score=' + score + ')'
    });
  } else if (routing.action === 'MANUAL_REVIEW') {
    // Candidate scored in the review zone — let them know we received their
    // application and are actively reviewing. Manager still triages via
    // dropdown; this email just sets a professional expectation on the
    // candidate's end. Disable via SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW=FALSE.
    if (CFG.getBool('SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW', true)) {
      sendTemplatedEmail_('we_are_reviewing', candidate['Email'], candidateId, null, {
        reason: 'auto-review notice — scored ' + score + ', routed to manual review'
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SCREEN LOOKUP & PAYLOAD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Latest Pre-Screen response row number for a candidate email, walking
 * from newest to oldest. Returns 0 if not found. Tolerates two "Email"
 * columns (Google Forms collected + asked).
 */
function _findPreScreenRow_(email) {
  var sh = getSheetOrNull_(SHEETS.RAW_PRESCREEN);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var headers = getHeaderRow_(sh);

  var emailCols = [];
  headers.forEach(function (h, i) {
    if (String(h || '').toLowerCase().indexOf('email') !== -1) emailCols.push(i);
  });
  if (!emailCols.length) return 0;

  var target = normalizeEmail_(email);
  if (!target) return 0;

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    for (var j = 0; j < emailCols.length; j++) {
      if (normalizeEmail_(data[i][emailCols[j]]) === target) return i + 2;
    }
  }
  return 0;
}

/**
 * Build {questionText: answer} dict from a Pre-Screen response row.
 * Drops blank fields. Drops duplicate headers (keeps first occurrence).
 */
function _buildPreScreenPayload_(formRow) {
  var sh = getSheet_(SHEETS.RAW_PRESCREEN);
  var headers = getHeaderRow_(sh);
  var values = sh.getRange(formRow, 1, 1, headers.length).getValues()[0];
  var payload = {};
  headers.forEach(function (h, i) {
    var key = String(h || '').trim();
    if (!key) return;
    if (key in payload) return; // first occurrence wins
    var v = String(values[i] == null ? '' : values[i]).trim();
    if (v) payload[key] = v;
  });
  return payload;
}

function _loadAiPrompt_(promptKey) {
  var sh = getSheetOrNull_(SHEETS.AI_PROMPTS);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Prompt Key', promptKey);
  return hits.length ? hits[0].data : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CALLER (temporary home — canonical version moves to 09_AI_Grading.gs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-grading JSON parser. Wraps safeParseJson_ (which strips code fences and
 * extracts the first {...} block from surrounding prose) and returns a
 * uniform contract with a raw preview for failure logging.
 * @return {object} { ok:boolean, json:object|null, error:string, rawPreview:string }
 */
function safeParseAiJson_(rawText, context) {
  var raw = String(rawText == null ? '' : rawText);
  var preview = truncate_(raw.replace(/\s+/g, ' ').trim(), 500);
  if (!raw.trim()) {
    return { ok: false, json: null, error: 'empty AI response' + (context ? ' [' + context + ']' : ''), rawPreview: preview };
  }
  var parsed = safeParseJson_(raw); // 01_Utils.gs — fences + prose + first {...}
  if (parsed.ok) return { ok: true, json: parsed.data, error: '', rawPreview: preview };
  return {
    ok: false, json: null,
    error: (parsed.error || 'parse failed') + (context ? ' [' + context + ']' : ''),
    rawPreview: preview
  };
}

/**
 * Normalize and validate a pre-screen grade object. Maps camelCase / alternate
 * field names to the canonical snake_case contract and fills SAFE defaults for
 * non-critical fields so a partially-shaped response never breaks downstream
 * writes. Returns the normalized object (never throws).
 *
 * Required fields: ai_score, ai_risk_score, summary, strengths, concerns,
 * credibility_score, possible_misrepresentation, recommended_next_step,
 * confidence_level.
 */
function validatePreScreenGradeJson_(obj) {
  var o = obj && typeof obj === 'object' ? obj : {};
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var k = arguments[i];
      if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    }
    return undefined;
  }
  function toInt(v, dflt) { var n = parseInt(v, 10); return isNaN(n) ? dflt : n; }
  function isNum(v) { return v !== undefined && v !== null && v !== '' && !isNaN(parseInt(v, 10)); }
  function toArr(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x || ''); }).filter(Boolean);
    if (v === undefined || v === null || v === '') return [];
    return String(v).split(/\s*[;|\n]\s*/).filter(Boolean);
  }
  // CRITICAL: distinguish "AI returned no usable score" from a real numeric 0.
  // A parseable-but-incomplete response (valid JSON missing ai_score) must NEVER
  // be treated as score 0 — that silently auto-rejects qualified candidates.
  // Callers gate on ai_score_present and route a missing score to MANUAL_REVIEW.
  var rawScore = pick('ai_score', 'aiScore', 'score', 'overall_score');
  return {
    ai_score_present:          isNum(rawScore),
    ai_score:                  toInt(rawScore, 0),
    ai_risk_score:             toInt(pick('ai_risk_score', 'aiRiskScore', 'risk_score', 'riskScore', 'risk'), 0),
    summary:                   String(pick('summary', 'ai_summary', 'overview') || ''),
    strengths:                 toArr(pick('strengths', 'top_strengths', 'topStrengths', 'pros')),
    concerns:                  toArr(pick('concerns', 'top_concerns', 'topConcerns', 'risks', 'cons')),
    credibility_score:         toInt(pick('credibility_score', 'credibilityScore', 'credibility'), 0),
    possible_misrepresentation: String(pick('possible_misrepresentation', 'possibleMisrepresentation', 'misrepresentation') || 'No'),
    recommended_next_step:     String(pick('recommended_next_step', 'recommendedNextStep', 'next_step', 'recommendation') || 'Manual Review'),
    confidence_level:          String(pick('confidence_level', 'confidenceLevel', 'confidence') || 'Low'),
    ai_authored_likelihood:    toInt(pick('ai_authored_likelihood', 'aiAuthoredLikelihood', 'ai_generated_likelihood', 'aiGeneratedLikelihood'), 0),
    ai_authored_reasoning:     String(pick('ai_authored_reasoning', 'aiAuthoredReasoning', 'ai_generated_reasoning') || '')
  };
}

/**
 * Call Gemini with a prompt and return parsed JSON. Hardened against the
 * dominant production failure ("JSON parse: no JSON object found"):
 *   • thinking is disabled (thinkingConfig.thinkingBudget=0) so 2.5 models
 *     spend their output budget on the answer instead of hidden reasoning,
 *   • finishReason (MAX_TOKENS / SAFETY / RECITATION) is surfaced explicitly,
 *   • tolerant parsing (code fences + surrounding prose) via safeParseAiJson_,
 *   • one automatic repair retry with a strict JSON-only reminder,
 *   • the raw response preview is logged on every parse failure.
 * @return {object} { ok, data?, error?, rawText? }
 */
function _geminiGradeJson_(phaseLabel, candidateId, promptText) {
  var apiKey = getSecret_(SECRETS.GEMINI_API_KEY);
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set in Script Properties' };

  var first = _geminiCallOnce_(phaseLabel, candidateId, promptText, apiKey);
  if (first.ok) return first;

  // Retry once with a deterministic repair prompt when the first attempt did
  // not yield parseable JSON (empty / truncated / prose-wrapped response).
  if (first.retryable) {
    var repairPrompt = promptText +
      '\n\n----------\nIMPORTANT: Respond with ONE valid JSON object ONLY. ' +
      'No markdown, no code fences, no commentary. ' +
      'Your entire response must start with "{" and end with "}".';
    var second = _geminiCallOnce_(phaseLabel + '_retry', candidateId, repairPrompt, apiKey);
    if (second.ok) return second;
    return second;
  }
  return first;
}

/** Single Gemini round-trip. Sets result.retryable when a repair retry may help. */
function _geminiCallOnce_(phaseLabel, candidateId, promptText, apiKey) {
  var model  = CFG.get('GEMINI_MODEL', 'gemini-2.5-flash');
  var temp   = CFG.getFloat('AI_GRADING_TEMPERATURE',      0.2);
  var maxTok = CFG.getInt('AI_GRADING_MAX_OUTPUT_TOKENS', 4096);

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  var generationConfig = {
    temperature:      temp,
    maxOutputTokens:  maxTok,
    responseMimeType: 'application/json'
  };
  // Disable "thinking" on Gemini 2.5 models so output tokens are spent on the
  // answer (otherwise the model can return an empty text part -> no JSON).
  if (/2\.5/.test(String(model))) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  var payload = { contents: [{ parts: [{ text: promptText }] }], generationConfig: generationConfig };

  var startMs = Date.now();
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
  } catch (e) {
    _logAiGrading_(phaseLabel, candidateId, promptText.length, 0, false, null, null, Date.now() - startMs, 'fetch: ' + e.message, '');
    return { ok: false, error: 'fetch failed: ' + e.message, retryable: true };
  }

  var elapsed = Date.now() - startMs;
  var code    = resp.getResponseCode();
  var text    = resp.getContentText();

  // Some models reject thinkingConfig with HTTP 400 — retry once without it.
  if (code === 400 && generationConfig.thinkingConfig && /thinking/i.test(text || '')) {
    delete generationConfig.thinkingConfig;
    try {
      resp = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ contents: payload.contents, generationConfig: generationConfig }),
        muteHttpExceptions: true
      });
      code = resp.getResponseCode();
      text = resp.getContentText();
    } catch (e) { /* fall through to error handling below */ }
  }

  if (code !== 200) {
    _logAiGrading_(phaseLabel, candidateId, promptText.length, (text || '').length, false, null, null, elapsed, 'HTTP ' + code, truncate_(text, 500));
    // 429 / 5xx are transient; 4xx (bad request/auth) are not worth a repair retry.
    var retryable = code === 429 || code >= 500;
    return { ok: false, error: 'HTTP ' + code + ': ' + truncate_(text, 200), retryable: retryable };
  }

  var apiResp;
  try { apiResp = JSON.parse(text); }
  catch (e) {
    _logAiGrading_(phaseLabel, candidateId, promptText.length, (text || '').length, false, null, null, elapsed, 'API envelope not JSON', truncate_(text, 500));
    return { ok: false, error: 'API response not JSON', retryable: true };
  }

  // Surface block / truncation reasons clearly rather than as a bare parse fail.
  var cand0 = apiResp.candidates && apiResp.candidates[0];
  var finishReason = cand0 && cand0.finishReason;
  if (apiResp.promptFeedback && apiResp.promptFeedback.blockReason) {
    var br = apiResp.promptFeedback.blockReason;
    _logAiGrading_(phaseLabel, candidateId, promptText.length, 0, false, null, null, elapsed, 'blocked: ' + br, '');
    return { ok: false, error: 'AI request blocked: ' + br, retryable: false };
  }

  var rawText = '';
  try {
    rawText = cand0.content.parts.map(function (p) { return p && p.text ? p.text : ''; }).join('');
  } catch (e) { rawText = ''; }

  var parsed = safeParseAiJson_(rawText, phaseLabel);
  if (!parsed.ok) {
    var note = parsed.error + (finishReason ? ' (finishReason=' + finishReason + ')' : '');
    _logAiGrading_(phaseLabel, candidateId, promptText.length, rawText.length, false, null, null, elapsed, note, parsed.rawPreview);
    return { ok: false, error: 'JSON parse: ' + note, rawText: rawText, retryable: true };
  }

  var s = parseInt(parsed.json.ai_score, 10);
  var r = parseInt(parsed.json.ai_risk_score, 10);
  _logAiGrading_(phaseLabel, candidateId, promptText.length, rawText.length, true,
                 isNaN(s) ? null : s, isNaN(r) ? null : r, elapsed, '', '');
  return { ok: true, data: parsed.json };
}

function _logAiGrading_(phase, candidateId, inputChars, outputChars, parseOk, score, risk, durationMs, error, rawPreview) {
  if (!CFG.getBool('AI_GRADING_LOGGING_ENABLED', true)) return;
  var sh = getSheetOrNull_(SHEETS.AI_GRADING_LOGS);
  if (!sh) return;
  try {
    appendRowByHeader_(sh, {
      'Timestamp':       shopDateTime_(),
      'Phase':           phase,
      'Prompt Key':      phase,
      'Candidate ID':    candidateId || '',
      'Otter Source ID': '',
      'Input Chars':     inputChars,
      'Model':           CFG.get('GEMINI_MODEL'),
      'Temperature':     CFG.getFloat('AI_GRADING_TEMPERATURE', 0.2),
      'Output Chars':    outputChars,
      'Parse OK':        parseOk ? 'TRUE' : 'FALSE',
      'AI Score':        score == null ? '' : score,
      'Risk Score':      risk  == null ? '' : risk,
      'Duration ms':     durationMs,
      'Error':           error || '',
      'Raw Preview':     rawPreview || ''
    });
  } catch (e) { Logger.log('_logAiGrading_ failed: ' + e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TESTS — one read-only, one live single-shot Gemini ping
// ─────────────────────────────────────────────────────────────────────────────

function SCORING_selfTest() {
  var out = ['[SCORING] selfTest (read-only)…'];
  out.push('  ─ AI_GRADING_ENABLED      : ' + CFG.getBool('AI_GRADING_ENABLED'));
  out.push('  ─ GEMINI_MODEL            : ' + CFG.get('GEMINI_MODEL'));
  out.push('  ─ GEMINI_API_KEY set      : ' + hasSecret_(SECRETS.GEMINI_API_KEY));
  out.push('  ─ AUTO_BOOKING_ENABLED    : ' + CFG.getBool('AUTO_BOOKING_ENABLED'));
  out.push('  ─ AUTO_REJECTION_ENABLED  : ' + CFG.getBool('AUTO_REJECTION_ENABLED'));
  out.push('  ─ DIAMOND_IN_ROUGH_ENABLED: ' + CFG.getBool('DIAMOND_IN_ROUGH_ENABLED'));

  var p = _loadAiPrompt_('prescreen');
  out.push('  ' + (p ? '✓' : '✗') + ' prescreen prompt loaded' +
           (p ? ' (' + String(p['Prompt Body'] || '').length + ' chars)' : ' — MISSING'));

  out.push('  ─ Tier mapping :');
  [95, 82, 65, 45, 25, 5].forEach(function (s) {
    out.push('       score=' + String(s).padEnd(3, ' ') + ' → ' + _scoreToTier_(s));
  });

  out.push('  ─ Role routing (uses Role Rules row when present) :');
  ['Technician', 'Service Advisor', 'Lube Tech', 'Shop Foreman'].forEach(function (r) {
    var rr = _getRoleRule_(r);
    if (!rr) { out.push('       ' + r + ' — Role Rules row MISSING'); return; }
    var hi = _routeCandidate_(85, 1, rr);
    var mid = _routeCandidate_(60, 1, rr);
    var lo = _routeCandidate_(15, 1, rr);
    out.push('       ' + r.padEnd(20, ' ') + '  85/1→' + hi.action + '   60/1→' + mid.action + '   15/1→' + lo.action);
  });

  out.push('[SCORING] selfTest done. Run SCORING_pingGemini() to make ONE real Gemini call.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/** Single live Gemini call to verify API connectivity. Tiny prompt, tiny response. */
function SCORING_pingGemini() {
  var msg;
  if (!hasSecret_(SECRETS.GEMINI_API_KEY)) {
    msg = '[SCORING] GEMINI_API_KEY not set in Script Properties — cannot ping';
    Logger.log(msg); return msg;
  }
  var t0 = Date.now();
  var result = _geminiGradeJson_('ping', '',
    'You are a JSON-only responder. Respond with: {"ok": true, "message": "pong"}');
  var ms = Date.now() - t0;
  if (result.ok) {
    msg = '[SCORING] Gemini OK in ' + ms + 'ms — response: ' + JSON.stringify(result.data);
  } else {
    msg = '[SCORING] Gemini FAIL in ' + ms + 'ms — ' + result.error +
          (result.rawText ? '\n  rawText: ' + truncate_(result.rawText, 300) : '');
  }
  Logger.log(msg);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI JSON CONTRACT TEST — verifies the parser AND a live provider round-trip.
// Used by productionReadinessCheck() to block go-live if AI JSON is broken.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirms the system can (a) parse the four JSON shapes the AI may return and
 * (b) get parseable JSON back from a live provider call. Returns a report
 * string and throws nothing.
 */
function testAiJsonContract() {
  var r = testAiJsonContractResult_();
  Logger.log(r.report);
  return r.report;
}

/** Programmatic variant: returns { ok:boolean, report:string }. */
function testAiJsonContractResult_() {
  var out = ['[AI_CONTRACT] testAiJsonContract…'];
  var allOk = true;

  // 1) Parser contract — the four shapes the AI may emit.
  var cases = [
    { name: 'clean JSON',         text: '{"ai_score":80,"ai_risk_score":1}',                     expect: true },
    { name: 'fenced JSON',        text: '```json\n{"ai_score":80,"ai_risk_score":1}\n```',        expect: true },
    { name: 'prose around JSON',  text: 'Here is the grade: {"ai_score":80} — done.',             expect: true },
    { name: 'invalid response',   text: 'sorry, I cannot help with that',                         expect: false }
  ];
  cases.forEach(function (c) {
    var p = safeParseAiJson_(c.text, 'contract');
    var pass = (p.ok === c.expect);
    if (!pass) allOk = false;
    out.push('  ' + (pass ? '✓' : '✗') + ' parser: ' + c.name + ' → ok=' + p.ok);
  });

  // 2) Validator fills safe defaults and normalizes camelCase.
  var v = validatePreScreenGradeJson_({ aiScore: '77', riskScore: 2, topStrengths: 'a; b' });
  var vOk = (v.ai_score === 77 && v.ai_risk_score === 2 && v.strengths.length === 2 &&
             v.confidence_level === 'Low' && v.recommended_next_step === 'Manual Review');
  if (!vOk) allOk = false;
  out.push('  ' + (vOk ? '✓' : '✗') + ' validator normalizes camelCase + fills defaults');

  // 3) Live provider round-trip — must come back as parseable JSON.
  if (!hasSecret_(SECRETS.GEMINI_API_KEY)) {
    allOk = false;
    out.push('  ✗ live call skipped — GEMINI_API_KEY not set in Script Properties');
  } else {
    var live = _geminiGradeJson_('contract_test', '',
      'Return ONLY this JSON object: {"ai_score": 50, "ai_risk_score": 0, "summary": "contract test"}');
    if (live.ok && live.data && String(live.data.ai_score) !== '') {
      out.push('  ✓ live Gemini call returned parseable JSON: ' + JSON.stringify(live.data));
    } else {
      allOk = false;
      out.push('  ✗ live Gemini call failed: ' + (live.error || 'unknown') +
               (live.rawText ? '\n      raw: ' + truncate_(live.rawText, 200) : ''));
    }
  }

  out.push('[AI_CONTRACT] ' + (allOk ? 'PASS' : 'FAIL'));
  return { ok: allOk, report: out.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY FAILED AI GRADES — re-score candidates flagged "AI scoring failed".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds candidates whose AI grade previously failed (Notes begins with
 * "AI scoring failed") and re-scores them through the hardened engine. Safe to
 * re-run; candidates that grade successfully drop out of the failed set.
 * @return {string} summary
 */
function retryFailedAiGrades() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.ALL_CANDIDATES);
    var last = sh.getLastRow();
    if (last < 2) return '[AI_RETRY] no candidates';

    var headers = getHeaderRow_(sh);
    var hId    = headers.indexOf('Candidate ID');
    var hNotes = headers.indexOf('Notes');
    if (hId === -1) throw new Error('retryFailedAiGrades: Candidate ID column missing');

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, retried: 0, recovered: 0, stillFailing: 0 };
    var MAX_PER_RUN = 25;

    for (var i = 0; i < data.length && summary.retried < MAX_PER_RUN; i++) {
      summary.scanned++;
      var notes = hNotes === -1 ? '' : String(data[i][hNotes] || '');
      if (notes.indexOf('AI scoring failed') !== 0) continue;
      var cid = String(data[i][hId] || '');
      if (!cid) continue;

      summary.retried++;
      try {
        var res = scorePreScreen_(cid);
        if (res && res.score !== undefined) summary.recovered++;
        else summary.stillFailing++;
      } catch (e) {
        summary.stillFailing++;
        logError_('retryFailedAiGrades:' + cid, e, cid, 'WARN');
      }
    }

    var msg = '[AI_RETRY] retryFailedAiGrades — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('AI_RETRY_RUN', '', summary);
    toast_(msg, 'Recruiting OS', 6);
    return msg;
  });
}
