/**
 * 37_Report_Card.gs
 * Frank's European Service — Recruiting OS
 *
 * The leadership-facing "candidate report card." This is the artifact the
 * hiring manager reads right before the final Hire / Not-Hire decision.
 *
 * It fires automatically once BOTH final-stage signals are in for a candidate:
 *   • AI-graded Culture Fit responses   (12_Culture_Fit.gs → Culture Score)
 *   • AI-graded Reference responses     (11_References.gs  → Reference Score)
 * Both of those handlers call maybeSendCandidateReportCard_(); whichever one
 * completes last is the one that actually emits the card. The other call
 * no-ops because the second score is not present yet.
 *
 * The card shows:
 *   • A grand-total grade (the composite from 10_Recommendation.gs, which
 *     blends pre-screen, phone, live interview, assessment, culture, and refs)
 *     plus the human-readable recommendation label.
 *   • Pros and Cons, derived from each sub-score versus the role's thresholds.
 *   • A side-by-side "what we're looking for vs. how they measured up" table
 *     built from Role Rules (Minimum / Auto-Booking-Minimum score, max risk).
 *   • The AI-written reference and culture-fit summaries.
 *
 * Sending is idempotent — a per-candidate guard (Script Property, plus a
 * "Report Card Sent" pipeline column when present) prevents duplicates.
 *
 * Public functions:
 *   maybeSendCandidateReportCard_(candidateId, trigger)  — gated auto-send
 *   sendCandidateReportCardNow(candidateId)              — force a (re)send
 *   REPORTCARD_selfTest()
 */

var REPORT_CARD_PROP_PREFIX = 'RPTCARD_SENT::';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — gated auto-send
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the report card IF both culture + reference scores are present and it
 * has not already been sent for this candidate. Returns true if an email was
 * queued, false otherwise (missing data, disabled, or already sent).
 */
function maybeSendCandidateReportCard_(candidateId, trigger) {
  if (!CFG.getBool('CANDIDATE_REPORT_CARD_ENABLED', true)) return false;
  if (!candidateId) return false;

  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return false;
  var hits = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
  if (!hits.length) return false;
  var c = hits[0].data;

  var culture = _num_(c['Culture Score']);
  var refs    = _num_(c['Reference Score'] || c['Reference Average']);
  if (!(culture > 0) || !(refs > 0)) {
    logEvent_('REPORT_CARD_DEFERRED', candidateId, { trigger: trigger || '', culture: culture, references: refs });
    return false; // both halves must be graded first
  }

  if (_reportCardAlreadySent_(candidateId)) {
    logEvent_('REPORT_CARD_SKIPPED_DUPLICATE', candidateId, { trigger: trigger || '' });
    return false;
  }

  return _buildAndSendReportCard_(candidateId, c, trigger || 'auto');
}

/** Force-build and send the report card regardless of the dedup guard. */
function sendCandidateReportCardNow(candidateId) {
  return withLock_(function () {
    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    var hits = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
    if (!hits.length) throw new Error('sendCandidateReportCardNow: candidate not in Interview Pipeline: ' + candidateId);
    return _buildAndSendReportCard_(candidateId, hits[0].data, 'manual');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────

function _buildAndSendReportCard_(candidateId, c, trigger) {
  var first = c['First Name'] || (String(c['Full Name'] || '').split(' ')[0]) || '';
  var last  = c['Last Name']  || (String(c['Full Name'] || '').split(' ').slice(1).join(' ')) || '';
  var name  = (first + ' ' + last).trim() || c['Full Name'] || candidateId;
  var role  = String(c['Role'] || '').trim();

  // Recompute so the grand total reflects every score we now hold.
  var rec = null;
  if (typeof computeFinalRecommendation_ === 'function') {
    try { rec = computeFinalRecommendation_(candidateId); } catch (e) { rec = null; }
  }
  var grand = rec ? Math.round(rec.composite) : _num_(c['Final Recommendation']);
  var label = rec ? rec.label : String(c['Final Recommendation'] || 'See pipeline');
  var risk  = rec ? rec.risk : _num_(c['Risk Score']);

  var scores = {
    'Pre-Screen':     _num_(c['Pre-Screen Score'] || c['AI Score']),
    'Phone Screen':   _num_(c['Phone Score']),
    'Live Interview': _num_(c['Full Score']),
    'Culture Fit':    _num_(c['Culture Score']),
    'References':     _num_(c['Reference Score'] || c['Reference Average'])
  };

  var rr = role ? _getRoleRule_(role) : null;
  var minScore  = rr ? _num_(rr['Minimum Score']) : CFG.getInt('MIN_PRESCREEN_SCORE', 60);
  var autoMin   = rr ? _num_(rr['Auto Booking Minimum Score']) : CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD', 80);
  var maxRisk   = rr ? _num_(rr['Max Risk Score For Auto Booking']) : CFG.getInt('MAX_RISK_SCORE_AUTOBOOK', 4);
  var payRange  = (rr && rr['Pay Range']) ? rr['Pay Range'] : '(set in Role Rules)';
  var target    = minScore > 0 ? minScore : 60;

  // Pros / Cons from sub-scores vs the role bar.
  var pros = [], cons = [];
  Object.keys(scores).forEach(function (k) {
    var s = scores[k];
    if (!(s > 0)) { cons.push(k + ' not on file (no score captured)'); return; }
    if (s >= autoMin && autoMin > 0)      pros.push(k + ' is strong (' + s + ' ≥ ' + autoMin + ')');
    else if (s >= target)                 pros.push(k + ' meets the bar (' + s + ' ≥ ' + target + ')');
    else                                  cons.push(k + ' is below the bar (' + s + ' < ' + target + ')');
  });
  if (risk >= maxRisk && maxRisk > 0) cons.push('Risk score is elevated (' + risk + ' ≥ ' + maxRisk + ')');
  else if (risk > 0)                  pros.push('Low risk profile (' + risk + ' < ' + maxRisk + ')');
  if (!pros.length) pros.push('No clearly above-bar dimensions — review the detail below.');
  if (!cons.length) cons.push('No below-bar dimensions flagged.');

  // Side-by-side: what we're looking for vs how they measured up.
  function row(dim, looking, measured) {
    return '  ' + _padRight_(dim, 16) + ' | ' + _padRight_(looking, 22) + ' | ' + measured;
  }
  var sideBySide = [
    row('Dimension', 'What we look for', 'How they measured up'),
    row('────────', '────────────────', '────────────────────'),
    row('Grand total', '≥ ' + target + ' to advance', grand + ' / 100  →  ' + label)
  ];
  Object.keys(scores).forEach(function (k) {
    var s = scores[k];
    var lookFor = (k === 'References' || k === 'Culture Fit') ? ('≥ ' + target + ' (final-stage)') : ('≥ ' + target);
    sideBySide.push(row(k, lookFor, (s > 0 ? (s + ' / 100' + (s >= target ? '  ✓' : '  ✗')) : 'not captured')));
  });
  sideBySide.push(row('Risk', '≤ ' + maxRisk + ' (lower better)', (risk > 0 ? (risk + ' / 10' + (risk <= maxRisk ? '  ✓' : '  ✗')) : 'n/a')));
  sideBySide.push(row('Pay range', payRange, '—'));

  var refSummary     = String(c['Reference Summary'] || '').trim();
  var cultureSummary = String(c['Culture Summary'] || '').trim();

  var body = [
    'CANDIDATE REPORT CARD — ready for your Hire / Not-Hire decision',
    '',
    'Candidate : ' + name,
    'Role      : ' + (role || '(unspecified)'),
    'Candidate ID : ' + candidateId,
    '',
    '────────────────────────────────────────────────────────',
    'GRAND TOTAL GRADE : ' + grand + ' / 100',
    'RECOMMENDATION    : ' + label,
    '────────────────────────────────────────────────────────',
    '',
    'PROS',
    pros.map(function (p) { return '  ✓ ' + p; }).join('\n'),
    '',
    'CONS',
    cons.map(function (x) { return '  ✗ ' + x; }).join('\n'),
    '',
    'SIDE BY SIDE — what we look for vs. how they measured up',
    sideBySide.join('\n'),
    ''
  ];

  if (refSummary) {
    body.push('REFERENCE SUMMARY (AI-graded)');
    body.push('  ' + refSummary);
    body.push('');
  }
  if (cultureSummary) {
    body.push('CULTURE FIT SUMMARY (AI-graded)');
    body.push('  ' + cultureSummary);
    body.push('');
  }

  body.push('────────────────────────────────────────────────────────');
  body.push('YOUR NEXT STEP — in the Interview Pipeline, set "Manager Decision" to:');
  body.push('  • "' + CFG.get('DECISION_HIRED', 'Confirm Hire') + '"  to hire, or');
  body.push('  • "' + CFG.get('DECISION_PUT_IN_DRAWER', 'Put in the Drawer') + '"  to pass for now.');
  body.push('');
  body.push('— Recruiting OS');

  var to = CFG.get('LEADERSHIP_REPORT_RECIPIENTS') || CFG.get('DIGEST_RECIPIENT_EMAIL') || CFG.get('HIRING_MANAGER_EMAIL');
  queueEmail_({
    to:          to,
    subject:     'REPORT CARD — ' + name + (role ? ' (' + role + ')' : '') + ' — ' + grand + '/100 · ' + label,
    body:        body.join('\n'),
    candidateId: candidateId,
    templateKey: '__candidate_report_card__',
    reason:      'candidate report card to leadership (trigger: ' + trigger + ')'
  });

  _markReportCardSent_(candidateId);
  logEvent_('REPORT_CARD_SENT', candidateId, { grand: grand, label: label, trigger: trigger, to: to });
  toast_('Report card sent to leadership for ' + name + ' (' + grand + '/100)', 'Recruiting OS', 6);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUP GUARD
// ─────────────────────────────────────────────────────────────────────────────

function _reportCardAlreadySent_(candidateId) {
  try {
    if (PropertiesService.getScriptProperties().getProperty(REPORT_CARD_PROP_PREFIX + candidateId)) return true;
  } catch (e) { /* ignore */ }
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip && getColIndex_(ip, 'Report Card Sent')) {
    var hits = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
    if (hits.length && String(hits[0].data['Report Card Sent'] || '').trim()) return true;
  }
  return false;
}

function _markReportCardSent_(candidateId) {
  try {
    PropertiesService.getScriptProperties().setProperty(REPORT_CARD_PROP_PREFIX + candidateId, shopDateTime_());
  } catch (e) { /* ignore */ }
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip && getColIndex_(ip, 'Report Card Sent')) {
    updateRowWhere_(ip, 'Candidate ID', candidateId, { 'Report Card Sent': shopDateTime_() });
  }
}

function _padRight_(s, n) {
  s = String(s == null ? '' : s);
  while (s.length < n) s += ' ';
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function REPORTCARD_selfTest() {
  var out = ['[REPORTCARD] selfTest (read-only)…'];
  out.push('  ─ CANDIDATE_REPORT_CARD_ENABLED : ' + CFG.getBool('CANDIDATE_REPORT_CARD_ENABLED', true));
  out.push('  ─ LEADERSHIP_REPORT_RECIPIENTS  : ' + (CFG.get('LEADERSHIP_REPORT_RECIPIENTS') || '(falls back to digest/hiring manager)'));
  out.push('  ' + (typeof computeFinalRecommendation_ === 'function' ? '✓' : '✗') + ' computeFinalRecommendation_ available');
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (ip) {
    out.push('  ─ Culture Score column     : ' + (getColIndex_(ip, 'Culture Score') ? 'present' : 'missing (recommendation still blends it when populated)'));
    out.push('  ─ Reference Score column   : ' + (getColIndex_(ip, 'Reference Score') || getColIndex_(ip, 'Reference Average') ? 'present' : 'missing'));
    out.push('  ─ Report Card Sent column  : ' + (getColIndex_(ip, 'Report Card Sent') ? 'present' : 'using Script Property guard only'));
  }
  out.push('[REPORTCARD] selfTest done. Use sendCandidateReportCardNow(candidateId) to force one.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
