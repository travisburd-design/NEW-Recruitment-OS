 /**
 * 45_Grading_Runner.gs
 * Frank's European Service — Recruiting OS
 *
 * V2 SCORING RUNNER — writes the grade, routes the candidate, sends the email.
 *
 * This is the write-side companion to 44_Grading_V2.gs. It is a drop-in
 * replacement for the body of scorePreScreen_ and fixes four routing defects
 * found in the audit:
 *
 *   D1  The risk ceiling was never enforced. Role Rules set
 *       "Max Risk Score For Auto Booking" = 4, yet 14 of 16 AUTO_BOOK_SENT rows
 *       carry risk 3–5 (one at 5, above even the role's own ceiling). V2 gates
 *       auto-booking on risk and logs every candidate the ceiling stops.
 *   D2  "Minimum Score" was read from Role Rules into a variable and never used
 *       (dead code in _routeCandidate_). V2 uses it as the review floor.
 *   D3  Hard disqualifiers (experience below the role minimum, no licence when
 *       required) could not block an auto-book. They now do — the candidate is
 *       routed to review or declined, never silently booked.
 *   D4  Score Tier was computed from GLOBAL config thresholds while routing used
 *       ROLE thresholds, so a Service Advisor at 65 displayed "Strong" and
 *       routed to MANUAL_REVIEW. V2 tiers against the role's own bands.
 *
 * Public functions:
 *   scorePreScreenV2(candidateId)         — score + route + email one candidate
 *   RESCORE_openRoles()                   — batch: Technician + Service Advisor
 *   RESCORE_unscored()                    — batch: every candidate with no score
 *   RESCORE_role(roleName)                — batch: one role
 */

var RESCORE_MAX_PER_RUN = 20;   // Apps Script 6-min ceiling; ~8-12s per Gemini call

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE CANDIDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade, route, write and dispatch for one candidate using the V2 engine.
 * @return {object} { candidateId, score, risk, tier, action, status, reason }
 */
function scorePreScreenV2(candidateId, opts) {
  opts = opts || {};
  if (!candidateId) return { ok: false, error: 'no candidateId' };
  if (!CFG.getBool('GRADING_V2_ENABLED', true)) {
    return (typeof scorePreScreen_ === 'function') ? scorePreScreen_(candidateId) : { ok: false, error: 'V2 disabled' };
  }

  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var candidate = _getCandidateRow_(candidateId);
  if (!candidate) return { ok: false, error: 'candidate not found' };

  // PEOPLE GATE (52_People): registry people are held, not scored/routed/emailed.
  if (typeof PEOPLE_registryMatchForCandidate_ === 'function') {
    var _rec = PEOPLE_registryMatchForCandidate_(candidate);
    if (_rec) {
      PEOPLE_holdCandidate_(candidateId, _rec, candidate['Role']);
      return { candidateId: candidateId, score: null, action: 'REGISTRY_HOLD', reason: _rec.flag };
    }
  }
  // A candidate the manager is already handling (Interview Booked, Full Booked,
  // Offer, Hired…) is scored for information only — status, pipeline and emails untouched.
  var _protected = (typeof PEOPLE_isProtectedStatus_ === 'function') && PEOPLE_isProtectedStatus_(candidate['Status']);
  if (_protected) opts.suppressEmails = true;

  var g = GRADE_prescreenV2_(candidateId);

  // ── Could not grade → MANUAL_REVIEW. Never reject on a failed grade. ──
  if (!g.ok) {
    logError_('scorePreScreenV2', g.error, candidateId, 'WARN');
    updateRowWhere_(ac, 'Candidate ID', candidateId, {
      'Status':       STATUS.MANUAL_REVIEW,
      'Notes':        truncate_('Not scored — ' + g.error, 500),
      'Last Updated': shopDateTime_()
    });
    logEvent_('V2_GRADE_FAILED', candidateId, { error: g.error });
    return { candidateId: candidateId, score: null, action: 'MANUAL_REVIEW', reason: g.error };
  }

  var roleRule = _getRoleRule_(candidate['Role']);
  var routing  = ROUTE_v2_(g.score, g.risk, roleRule, g.gates);
  // FIX 9/25/26: silent re-scores (old, previously dropped submissions) never
  // auto-book or email. A would-be auto-book lands in MANUAL_REVIEW instead.
  if (opts.suppressEmails && routing.status === STATUS.AUTO_BOOK_SENT) {
    routing = { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW,
                reason: 'Late-graded (submission was dropped) — would have auto-booked: ' + routing.reason };
  }
  var tier     = TIER_v2_(g.score, roleRule);

  // ── Write the grade + everything V1 discarded ──
  var updates = {
    'AI Score':               g.score,
    'Risk Score':             g.risk,
    'Total Score':            g.score,
    'Score Tier':             tier,
    'Status':                 routing.status,
    'Notes':                  truncate_(g.ai.summary, 500),
    'AI-Authored Likelihood': g.ai.ai_authored_likelihood,
    'AI-Authored Reasoning':  truncate_(g.ai.ai_authored_reasoning, 300),
    'Last Updated':           shopDateTime_()
  };
  // Optional columns — written only if the header exists (appendRowByHeader_
  // semantics: updateRowWhere_ ignores unknown keys, so this is safe either way).
  updates['Strengths']             = truncate_(g.ai.strengths.join(' | '), 400);
  updates['Concerns']              = truncate_(g.ai.concerns.join(' | '), 400);
  updates['Credibility Score']     = g.ai.credibility_score;
  updates['Confidence']            = g.ai.confidence_level;
  updates['Recommended Next Step'] = g.ai.recommended_next_step;

  if (_protected) { delete updates['Status']; delete updates['Notes']; }
  updateRowWhere_(ac, 'Candidate ID', candidateId, updates);
  GRADE_writeDetail_(candidateId, candidate, g);

  logEvent_('CANDIDATE_SCORED_V2', candidateId, {
    score: g.score, risk: g.risk, tier: tier, action: routing.action,
    coverage: g.coverage, gates: g.gates.reasons, role: candidate['Role'], source: g.sourceTab
  });

  // ── Pipeline row for anything still live ──
  if (_protected) {
    var _ipP = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (_ipP) updateRowWhere_(_ipP, 'Candidate ID', candidateId, {
      'Score': g.score, 'Pre-Screen Score': g.score, 'Risk Score': g.risk, 'Last Updated': shopDateTime_() });
  } else if (routing.status !== STATUS.REJECTED && !CFG.getBool('HIRING_PAUSE_MODE', false)) {
    safeRun_('v2:pipelineRow', function () {
      _ensureInterviewPipelineRow_(candidateId, {
        status: routing.status, stage: 'Pre-screen scored (V2)', via: 'scoring_v2'
      });
      var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
      if (ip) updateRowWhere_(ip, 'Candidate ID', candidateId, {
        'Status': routing.status, 'Score': g.score, 'Pre-Screen Score': g.score,
        'Risk Score': g.risk, 'Last Updated': shopDateTime_()
      });
    });
  }

  // ── Email dispatch (reuses the V1 dispatcher: queue, TEST reroute, once-only) ──
  if (!opts.suppressEmails) {
    safeRun_('v2:dispatch', function () {
      _dispatchPostScoringEmails_(candidateId, candidate, g.score, g.risk, routing);
    });
  } else {
    logEvent_('V2_DISPATCH_SUPPRESSED', candidateId, { score: g.score, action: routing.action });
  }

  // ── Role assessment (scores + logs only; auto-decision stays gated off) ──
  if (routing.status !== STATUS.REJECTED &&
      CFG.getBool('ASSESSMENT_AUTO_RUN_ENABLED', true) &&
      typeof runAssessmentForCandidate === 'function') {
    safeRun_('v2:assessment', function () { runAssessmentForCandidate(candidateId); });
  }

  return {
    candidateId: candidateId, score: g.score, risk: g.risk, tier: tier,
    action: routing.action, status: routing.status, reason: routing.reason,
    coverage: g.coverage, gates: g.gates.reasons
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING V2
// ─────────────────────────────────────────────────────────────────────────────

function ROUTE_num_(v, dflt) { var x = parseFloat(v); return isNaN(x) ? dflt : x; }

/**
 * Role-aware routing with the risk ceiling and hard gates actually enforced.
 * @return {{action:string, status:string, reason:string}}
 */
function ROUTE_v2_(score, risk, roleRule, gates) {
  var autoMin    = roleRule ? ROUTE_num_(roleRule['Auto Booking Minimum Score'],      CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD', 80)) : CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD', 80);
  var minScore   = roleRule ? ROUTE_num_(roleRule['Minimum Score'],                   CFG.getInt('MIN_PRESCREEN_SCORE', 60))       : CFG.getInt('MIN_PRESCREEN_SCORE', 60);
  var hardReject = roleRule ? ROUTE_num_(roleRule['Hard Reject Score'],               CFG.getInt('HARD_REJECT_SCORE_THRESHOLD', 40)) : CFG.getInt('HARD_REJECT_SCORE_THRESHOLD', 40);
  var maxRisk    = roleRule ? ROUTE_num_(roleRule['Max Risk Score For Auto Booking'], CFG.getInt('MAX_RISK_SCORE_AUTOBOOK', 4))    : CFG.getInt('MAX_RISK_SCORE_AUTOBOOK', 4);
  var autoBookOK = !roleRule || String(roleRule['Auto Send Booking']).trim().toUpperCase() === 'TRUE';

  // D3 — a hard gate can never be auto-booked past.
  if (gates && gates.failed) {
    if (score < hardReject) {
      return { action: 'HARD_REJECT', status: STATUS.REJECTED, reason: 'Below floor (' + score + '<' + hardReject + ') + hard gate: ' + gates.reasons.join('; ') };
    }
    return { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW, reason: 'Hard gate: ' + gates.reasons.join('; ') };
  }

  // 1) Auto-book — score high enough AND risk under the role ceiling.
  if (score >= autoMin && autoBookOK) {
    if (risk <= maxRisk) {
      return { action: 'AUTO_BOOK', status: STATUS.AUTO_BOOK_SENT, reason: 'Score ' + score + ' >= ' + autoMin + ', risk ' + risk + ' <= ' + maxRisk };
    }
    // D1 — the ceiling stops the booking and says so out loud.
    logEvent_('AUTOBOOK_BLOCKED_BY_RISK', '', { score: score, risk: risk, maxRisk: maxRisk });
    return { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW, reason: 'Score ' + score + ' clears ' + autoMin + ' but risk ' + risk + ' exceeds ceiling ' + maxRisk };
  }

  // 2) Hard reject — below the role's floor.
  if (score < hardReject) {
    return { action: 'HARD_REJECT', status: STATUS.REJECTED, reason: 'Score ' + score + ' below hard-reject floor ' + hardReject };
  }

  // 3) Everything between the floor and the auto-book bar.
  var band = (score >= minScore) ? 'at/above role minimum ' + minScore : 'below role minimum ' + minScore;
  return { action: 'MANUAL_REVIEW', status: STATUS.MANUAL_REVIEW, reason: 'Score ' + score + ' ' + band + ', under auto-book bar ' + autoMin };
}

/** D4 — tier against the ROLE's bands so the label matches the decision. */
function TIER_v2_(score, roleRule) {
  var autoMin    = roleRule ? ROUTE_num_(roleRule['Auto Booking Minimum Score'], 80) : 80;
  var minScore   = roleRule ? ROUTE_num_(roleRule['Minimum Score'],             70) : 70;
  var hardReject = roleRule ? ROUTE_num_(roleRule['Hard Reject Score'],         40) : 40;
  if (score >= autoMin + 10) return 'Priority';
  if (score >= autoMin)      return 'Strong';
  if (score >= minScore)     return 'Qualified';
  if (score >= hardReject)   return 'Review';
  return 'Hard Reject';
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH RE-SCORING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-score every Technician and Service Advisor candidate through V2.
 * Capped per run; re-run until it reports 0 remaining.
 */
function RESCORE_openRoles() {
  return RESCORE_batch_(function (row) {
    var role = String(row.role || '').toLowerCase();
    return role.indexOf('technician') !== -1 || role.indexOf('advisor') !== -1;
  }, 'open roles (Technician + Service Advisor)');
}

/** Re-score every candidate that currently has no AI Score. */
function RESCORE_unscored() {
  return RESCORE_batch_(function (row) { return row.score === '' || row.score === null; }, 'unscored candidates');
}

/** Re-score one named role. */
function RESCORE_role(roleName) {
  var target = String(roleName || '').toLowerCase();
  return RESCORE_batch_(function (row) {
    return String(row.role || '').toLowerCase().indexOf(target) !== -1;
  }, 'role "' + roleName + '"');
}

/**
 * Shared batch driver. Skips ARCHIVED and HIRED rows, skips candidates with no
 * pre-screen response, and stops at RESCORE_MAX_PER_RUN so the run cannot time
 * out mid-write.
 */
function RESCORE_batch_(filterFn, label) {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var last = ac.getLastRow();
  if (last < 2) return '[RESCORE] no candidates';

  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var cId = headers.indexOf('Candidate ID'), cRole = headers.indexOf('Role'),
      cScore = headers.indexOf('AI Score'), cStatus = headers.indexOf('Status'),
      cEmail = headers.indexOf('Email');

  var queue = [];
  data.forEach(function (r) {
    var status = String(r[cStatus] || '').toUpperCase();
    if (status === 'ARCHIVED' || status === 'HIRED' || status === 'WITHDRAWN') return;
    var row = {
      id: String(r[cId] || ''), role: cRole >= 0 ? r[cRole] : '',
      score: cScore >= 0 ? r[cScore] : '', email: cEmail >= 0 ? String(r[cEmail] || '') : ''
    };
    if (!row.id || !row.email) return;
    if (!filterFn(row)) return;
    queue.push(row);
  });

  var summary = { matched: queue.length, processed: 0, autoBook: 0, review: 0, rejected: 0,
                  noPreScreen: 0, errors: 0, remaining: 0 };

  for (var i = 0; i < queue.length; i++) {
    if (summary.processed >= RESCORE_MAX_PER_RUN) { summary.remaining = queue.length - i; break; }
    try {
      var res = withLock_(function () { return scorePreScreenV2(queue[i].id); });
      summary.processed++;
      if (!res || res.score === null) {
        if (res && /no pre-screen/i.test(res.reason || '')) summary.noPreScreen++;
        else summary.review++;
        continue;
      }
      if (res.action === 'AUTO_BOOK')         summary.autoBook++;
      else if (res.action === 'HARD_REJECT')  summary.rejected++;
      else                                    summary.review++;
    } catch (e) {
      summary.errors++;
      logError_('RESCORE_batch_:' + queue[i].id, e, queue[i].id, 'WARN');
    }
  }

  var msg = '[RESCORE] ' + label + ' — ' + JSON.stringify(summary) +
            (summary.remaining ? '  ← run again for the remaining ' + summary.remaining : '  ← complete');
  Logger.log(msg);
  logEvent_('RESCORE_BATCH', '', summary);
  try { toast_(msg, 'Recruiting OS', 12); } catch (e) {}
  return msg;
}