/**
 * 10_Recommendation.gs
 * Frank's European Service — Recruiting OS
 *
 * Composite recommendation engine. Combines every score we have for a
 * candidate into a single "Final Recommendation" string the hiring manager
 * sees on the Interview Pipeline:
 *
 *   Inputs (each 0-100, optional):
 *     Pre-Screen Score   (from 06_Scoring_Risk)
 *     Phone Score        (from 09_AI_Grading on PhoneScreen transcripts)
 *     Full Score         (from 09_AI_Grading on FullInterview transcripts)
 *     Culture Score      (from 12_Culture_Fit)
 *     Reference Avg      (from 11_References)
 *
 *   Plus Risk Score (0-10, lower is better) from pre-screen or transcripts.
 *
 * Weighting (defaults; manual override per candidate by editing Notes):
 *     Pre-Screen 20% · Phone 20% · Full 25% · Culture 15% · References 20%
 *   When a score is missing, weights of present scores are renormalized.
 *
 * Output labels:
 *     ≥85          → "Highly Recommend"
 *     70-84        → "Recommend"
 *     55-69        → "Manual Review"
 *     <55          → "Do Not Recommend"
 *   Risk Score ≥ 7 forces "Manual Review" regardless of composite.
 *
 * Public functions:
 *   computeFinalRecommendation_(candidateId)
 *   updateRecommendationEngineForAll()
 *   RECOMMEND_selfTest()
 */

var REC_WEIGHTS = Object.freeze({
  preScreen:  0.15,
  phone:      0.25,
  full:       0.35,
  culture:    0.10,
  references: 0.15
});

// An interview score below this caps the recommendation (a weak interview
// must not be masked by a strong written pre-screen).
var REC_INTERVIEW_OK_MIN   = 60;
var REC_INTERVIEW_POOR_MAX = 45;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: compute + write the recommendation for one candidate
// ─────────────────────────────────────────────────────────────────────────────

function computeFinalRecommendation_(candidateId) {
  if (!candidateId) { logError_('computeFinalRecommendation_', 'no candidateId', '', 'WARN'); return null; }
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) { logError_('computeFinalRecommendation_', 'Interview Pipeline missing'); return null; }
  var hits = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
  if (!hits.length) {
    logError_('computeFinalRecommendation_', 'candidate not in pipeline: ' + candidateId, candidateId, 'WARN');
    return null;
  }
  var c = hits[0].data;

  var scores = {
    preScreen:  _num_(c['Pre-Screen Score'] || c['AI Score'] || c['Total Score']),
    phone:      _num_(c['Phone Score']),
    full:       _num_(c['Full Score']),
    culture:    _num_(c['Culture Score']),
    references: _num_(c['Reference Score'] || c['Reference Average'])
  };

  // Assessment blend: fold the latest role-based AI assessment overall score in
  // as its own weighted input (35_Assessments.gs). Absent → simply not counted
  // (the composite is self-renormalizing over present scores).
  var assess = (typeof getLatestAssessmentResult_ === 'function')
    ? getLatestAssessmentResult_(candidateId) : null;
  if (assess) {
    scores.assessment = _num_(assess['Candidate Fit Score']);
  }

  var risk = _num_(c['Risk Score']);

  var composite = _weightedComposite_(scores);
  var label = _compositeToLabel_(composite, risk, scores);

  updateRowWhere_(ip, 'Candidate ID', candidateId, {
    'Final Recommendation': label + ' (' + Math.round(composite) + ')',
    'Last Updated':         shopDateTime_()
  });

  logEvent_('RECOMMENDATION_COMPUTED', candidateId, {
    composite: Math.round(composite), risk: risk, label: label, scores: scores
  });

  return { composite: composite, risk: risk, label: label, scores: scores };
}

/** Bulk: recompute for every candidate in Interview Pipeline. */
function updateRecommendationEngineForAll() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('updateRecommendationEngineForAll', 'OK');
  return withLockOrSkip_('updateRecommendationEngineForAll', function () {
    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var last = ip.getLastRow();
    if (last < 2) return '[RECOMMEND] pipeline empty';
    var headers = getHeaderRow_(ip);
    var cidCol = headers.indexOf('Candidate ID');
    if (cidCol === -1) throw new Error('updateRecommendationEngineForAll: Candidate ID column missing');
    var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, updated: 0, skipped: 0, errors: 0 };
    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var cid = String(data[i][cidCol] || '').trim();
      if (!cid) { summary.skipped++; continue; }
      try {
        var r = computeFinalRecommendation_(cid);
        if (r) summary.updated++; else summary.skipped++;
      } catch (e) {
        summary.errors++;
        logError_('updateRecommendationEngineForAll', e, cid, 'WARN');
      }
    }
    var msg = '[RECOMMEND] updateRecommendationEngineForAll — ' + JSON.stringify(summary);
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MATH
// ─────────────────────────────────────────────────────────────────────────────

function _weightedComposite_(scores) {
  // Base weights plus the assessment weight (tunable via ASSESSMENT_COMPOSITE_WEIGHT,
  // default 0.10). Only scores that are present and > 0 contribute; their weights
  // are renormalized, so adding 'assessment' is safe whether or not it is present.
  var weights = {
    preScreen:  REC_WEIGHTS.preScreen,
    phone:      REC_WEIGHTS.phone,
    full:       REC_WEIGHTS.full,
    culture:    REC_WEIGHTS.culture,
    references: REC_WEIGHTS.references,
    assessment: CFG.getFloat('ASSESSMENT_COMPOSITE_WEIGHT', 0.10)
  };
  var totalWeight = 0, sum = 0;
  Object.keys(weights).forEach(function (k) {
    var s = scores[k];
    if (typeof s === 'number' && !isNaN(s) && s > 0) {
      sum += s * weights[k];
      totalWeight += weights[k];
    }
  });
  if (totalWeight === 0) return 0;
  return sum / totalWeight;
}

function _compositeToLabel_(composite, risk, scores) {
  if (risk >= 7) return 'Manual Review (high risk)';

  // Interview-aware caps: a recorded interview is the strongest signal we have.
  // A weak interview must not be overridden by a strong written pre-screen.
  var interviewPresent = false, bestInterview = 0;
  if (scores) {
    ['phone', 'full'].forEach(function (k) {
      var s = scores[k];
      if (typeof s === 'number' && !isNaN(s) && s > 0) { interviewPresent = true; bestInterview = Math.max(bestInterview, s); }
    });
  }
  if (interviewPresent) {
    if (bestInterview < REC_INTERVIEW_POOR_MAX) return 'Do Not Recommend';
    if (bestInterview < REC_INTERVIEW_OK_MIN)   return 'Manual Review';
  }

  var base;
  if (composite >= 85) base = 'Highly Recommend';
  else if (composite >= 70) base = 'Recommend';
  else if (composite >= 55) base = 'Manual Review';
  else if (composite > 0)   base = 'Do Not Recommend';
  else return 'Insufficient Data';

  // Until an interview happens, a positive label is provisional (pre-screen only).
  if (!interviewPresent && (base === 'Highly Recommend' || base === 'Recommend')) {
    return base + ' — pre-screen only';
  }
  return base;
}

function _num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function RECOMMEND_selfTest() {
  var out = ['[RECOMMEND] selfTest (read-only)…'];
  var cases = [
    { name: 'High all-around',    s: { preScreen: 90, phone: 88, full: 92, culture: 85, references: 90 }, risk: 1 },
    { name: 'Strong with risk',   s: { preScreen: 90, phone: 85, full: 88 }, risk: 8 },
    { name: 'Only pre-screen',    s: { preScreen: 75 }, risk: 2 },
    { name: 'Below bar',          s: { preScreen: 50, phone: 45, full: 40 }, risk: 3 },
    { name: 'Empty',              s: {}, risk: 0 }
  ];
  cases.forEach(function (c) {
    var comp = _weightedComposite_(c.s);
    var lab = _compositeToLabel_(comp, c.risk);
    out.push('  ─ ' + c.name.padEnd(22, ' ') + ' composite=' + comp.toFixed(1).padStart(5, ' ') +
             '  risk=' + c.risk + '  label=' + lab);
  });
  out.push('[RECOMMEND] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
