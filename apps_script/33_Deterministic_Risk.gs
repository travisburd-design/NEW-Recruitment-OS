/**
 * 33_Deterministic_Risk.gs
 * Frank's European Service — Recruiting OS
 *
 * DETERMINISTIC (non-LLM) HARD-DISQUALIFIER + RISK-FLAG BACKSTOP.
 *
 * This is a SAFETY NET layered ALONGSIDE the existing Gemini-based scorer in
 * 06_Scoring_Risk.gs — it is NOT a replacement for it. It runs cheap, fully
 * explainable regex/heuristic checks so that if the AI is down, rate-limited,
 * or hallucinates, hard disqualifiers and high deterministic risk can still
 * surface and (optionally) force MANUAL_REVIEW.
 *
 * DESIGN PRINCIPLES (read before editing):
 *   • ADVISORY BY DEFAULT. With DETERMINISTIC_BACKSTOP_ENFORCE=FALSE (the
 *     default) this module ONLY logs + writes audit rows to the "Risk Flags"
 *     sheet. It never changes a candidate's Status.
 *   • NEVER SILENTLY ELIMINATES A CANDIDATE. The strongest action this module
 *     can ever take is to DOWNGRADE a candidate to STATUS.MANUAL_REVIEW so a
 *     human looks at them. It NEVER auto-rejects, never archives, never sends
 *     a decline. A human always makes the elimination call.
 *   • ONLY ESCALATES WHAT THE AI MISSED. When enforcement is on, it only
 *     downgrades to MANUAL_REVIEW if the AI did NOT already route the candidate
 *     to MANUAL_REVIEW / REJECTED itself (i.e. the AI thought they were fine).
 *   • EXPLAINABLE. Every flag and every DQ reason is a plain-English string the
 *     manager can read in the audit sheet.
 *
 * Public functions:
 *   applyDeterministicBackstop_(candidateId)  — single candidate entry
 *   runDeterministicRiskReview()              — bulk job (capped at MAX_PER_RUN)
 *   getDeterministicSignals_(payload, rule)   — pure hook for the AI scorer
 *   DETERMINISTIC_RISK_selfTest()             — read-only sample-payload test
 *
 * Internal:
 *   detectHardDisqualifiers_(payload, roleRule) -> [reason, ...]
 *   computeDeterministicRisk_(payload, roleRule) -> { score, flags[] }
 *
 * Pre-screen payload shape: the {questionText: answer} dict produced by
 * _buildPreScreenPayload_() in 06_Scoring_Risk.gs. Because Google Form column
 * headers are free text and drift over time, all field reads below go through
 * _detPick_(payload, [...synonyms]) which matches header substrings
 * case-insensitively rather than hard-coding one exact header string.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHEET + CONFIG CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// "Risk Flags" audit sheet. Mirrored in the integration spec (SHEETS.RISK_FLAGS).
var DET_RISK_FLAGS_SHEET = 'Risk Flags';
var DET_RISK_FLAGS_HEADERS = Object.freeze([
  'Timestamp', 'Candidate ID', 'Full Name', 'Role',
  'Hard DQ', 'Hard DQ Reasons',
  'Deterministic Risk Score', 'High Risk', 'Risk Flags',
  'AI Risk Score', 'AI Status Before',
  'Backstop Action', 'Enforced', 'Notes'
]);

// Default threshold at/above which deterministic risk is considered "high".
// (B used score >= 5 = BLOCK.) Overridable via DETERMINISTIC_RISK_BLOCK_THRESHOLD.
var DET_RISK_BLOCK_THRESHOLD_DEFAULT = 5;

// Batch cap, consistent with A's other backfill/batch jobs (e.g. 25).
var DET_MAX_PER_RUN = 25;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: single-candidate backstop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the deterministic backstop for one candidate.
 *   1. load candidate + latest Pre-Screen payload (via 06_Scoring_Risk helpers)
 *   2. run hard-DQ detection + deterministic risk scoring
 *   3. write an audit row to the "Risk Flags" sheet
 *   4. ADVISORY by default: log only.
 *      ENFORCE mode (DETERMINISTIC_BACKSTOP_ENFORCE=TRUE): if a hard DQ or
 *      high deterministic risk is found AND the AI did not already route the
 *      candidate to MANUAL_REVIEW / REJECTED, downgrade to STATUS.MANUAL_REVIEW.
 *   NEVER auto-rejects.
 *
 * @param {string} candidateId
 * @return {object|null} { candidateId, hardDq, dqReasons, risk, flags, highRisk, action }
 */
function applyDeterministicBackstop_(candidateId) {
  if (!candidateId) { logError_('applyDeterministicBackstop_', 'no candidateId provided', '', 'WARN'); return null; }
  if (!CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true)) {
    logEvent_('DET_BACKSTOP_SKIPPED', candidateId, 'DETERMINISTIC_BACKSTOP_ENABLED is FALSE');
    return null;
  }

  var candidate = _getCandidateRow_(candidateId); // 14_Email_Queue.gs
  if (!candidate) {
    logError_('applyDeterministicBackstop_', 'candidate not found: ' + candidateId, candidateId, 'WARN');
    return null;
  }

  var psRow = _findPreScreenRow_(candidate['Email']); // 06_Scoring_Risk.gs
  if (!psRow) {
    logError_('applyDeterministicBackstop_', 'no Pre-Screen response for ' + candidate['Email'], candidateId, 'WARN');
    return null;
  }

  var payload  = _buildPreScreenPayload_(psRow);      // 06_Scoring_Risk.gs
  var roleRule = _getRoleRule_(candidate['Role']);    // 14_Email_Queue.gs
  var signals  = getDeterministicSignals_(payload, roleRule);

  var aiRisk      = _detToInt_(candidate['Risk Score'], -1);
  var statusBefore = String(candidate['Status'] || '');

  // Decide what (if anything) to do. Advisory unless ENFORCE is on.
  var enforce  = CFG.getBool('DETERMINISTIC_BACKSTOP_ENFORCE', false);
  var triggered = signals.hardDq || signals.highRisk;
  // The AI "already caught it" if it routed the candidate anywhere a human will
  // already see them (manual review) or already declined them.
  var aiAlreadyCaught = (statusBefore === STATUS.MANUAL_REVIEW || statusBefore === STATUS.REJECTED);

  var action = 'ADVISORY';   // logged, no status change
  if (enforce && triggered && !aiAlreadyCaught) {
    action = 'DOWNGRADE_MANUAL_REVIEW';
  } else if (triggered && aiAlreadyCaught) {
    action = 'ADVISORY_AI_ALREADY_CAUGHT';
  } else if (triggered) {
    action = 'ADVISORY_WOULD_DOWNGRADE'; // enforce off — would have downgraded
  }

  var notes = _detBuildNotes_(signals, enforce, aiAlreadyCaught);

  // Audit write (locked). Never blocks the rest on a sheet failure.
  safeRun_('det:auditWrite', function () {
    withLock_(function () {
      var sh = getOrCreateSheet_(DET_RISK_FLAGS_SHEET, DET_RISK_FLAGS_HEADERS);
      ensureHeaders_(sh, DET_RISK_FLAGS_HEADERS);
      appendRowByHeader_(sh, {
        'Timestamp':                 shopDateTime_(),
        'Candidate ID':              candidateId,
        'Full Name':                 candidate['Full Name'] || candidate['Name'] || '',
        'Role':                      candidate['Role'] || '',
        'Hard DQ':                   signals.hardDq ? 'TRUE' : 'FALSE',
        'Hard DQ Reasons':           signals.dqReasons.join('; '),
        'Deterministic Risk Score':  signals.risk,
        'High Risk':                 signals.highRisk ? 'TRUE' : 'FALSE',
        'Risk Flags':                signals.flags.join('; '),
        'AI Risk Score':             aiRisk < 0 ? '' : aiRisk,
        'AI Status Before':          statusBefore,
        'Backstop Action':           action,
        'Enforced':                  enforce ? 'TRUE' : 'FALSE',
        'Notes':                     truncate_(notes, 500)
      });
    });
  });

  // Enforcement: downgrade to MANUAL_REVIEW only. NEVER reject.
  if (action === 'DOWNGRADE_MANUAL_REVIEW') {
    safeRun_('det:downgrade', function () {
      var ac = getSheet_(SHEETS.ALL_CANDIDATES);
      updateRowWhere_(ac, 'Candidate ID', candidateId, {
        'Status':       STATUS.MANUAL_REVIEW,
        'Notes':        truncate_('Deterministic backstop → MANUAL_REVIEW: ' + notes, 500),
        'Last Updated': shopDateTime_()
      });
    });
  }

  logEvent_('DET_BACKSTOP', candidateId, {
    role: candidate['Role'], hardDq: signals.hardDq, risk: signals.risk,
    highRisk: signals.highRisk, action: action, enforce: enforce
  });

  return {
    candidateId: candidateId,
    hardDq:      signals.hardDq,
    dqReasons:   signals.dqReasons,
    risk:        signals.risk,
    flags:       signals.flags,
    highRisk:    signals.highRisk,
    action:      action
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: bulk review (capped, locked)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the deterministic backstop over recently-scored candidates. Capped at
 * DET_MAX_PER_RUN like A's other batch jobs. Scans candidates that have been
 * scored (or routed to manual review) so the backstop sees the AI's verdict and
 * can decide whether the AI missed something.
 * @return {string} summary
 */
function runDeterministicRiskReview() {
  return withLock_(function () {
    if (!CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true)) {
      var off = '[DET_BACKSTOP] disabled (DETERMINISTIC_BACKSTOP_ENABLED=FALSE)';
      Logger.log(off); toast_(off, 'Recruiting OS', 5); return off;
    }
    var sh = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
    if (!sh) return '[DET_BACKSTOP] All Candidates sheet missing';
    var last = sh.getLastRow();
    if (last < 2) return '[DET_BACKSTOP] no candidates';

    var headers = getHeaderRow_(sh);
    var hId     = headers.indexOf('Candidate ID');
    var hStatus = headers.indexOf('Status');
    if (hId === -1) throw new Error('runDeterministicRiskReview: Candidate ID column missing');

    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, reviewed: 0, hardDq: 0, highRisk: 0, downgraded: 0 };

    // Statuses worth backstopping: scored / auto-booked / already in review.
    var reviewable = {};
    reviewable[STATUS.SCORED] = 1;
    reviewable[STATUS.AUTO_BOOK_SENT] = 1;
    reviewable[STATUS.MANUAL_REVIEW] = 1;

    for (var i = 0; i < data.length && summary.reviewed < DET_MAX_PER_RUN; i++) {
      summary.scanned++;
      var status = hStatus === -1 ? '' : String(data[i][hStatus] || '');
      if (!reviewable[status]) continue;
      var cid = String(data[i][hId] || '');
      if (!cid) continue;

      summary.reviewed++;
      var res = safeRun_('det:review:' + cid, function () { return applyDeterministicBackstop_(cid); });
      if (res) {
        if (res.hardDq)   summary.hardDq++;
        if (res.highRisk) summary.highRisk++;
        if (res.action === 'DOWNGRADE_MANUAL_REVIEW') summary.downgraded++;
      }
    }

    var msg = '[DET_BACKSTOP] runDeterministicRiskReview — ' + JSON.stringify(summary);
    Logger.log(msg);
    logEvent_('DET_BACKSTOP_RUN', '', summary);
    toast_(msg, 'Recruiting OS', 6);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC HOOK for the AI scorer (06_Scoring_Risk.gs may call this).
// Pure: no sheet reads/writes, no status changes. Safe to call inline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute deterministic signals from an already-built pre-screen payload.
 *
 * SIGNATURE (stable — wire this into 06_Scoring_Risk.gs):
 *   getDeterministicSignals_(prescreenPayload, roleRule)
 *     @param {Object} prescreenPayload  {questionText: answer} from _buildPreScreenPayload_()
 *     @param {Object|null} roleRule      Role Rules row from _getRoleRule_()
 *     @return {Object} {
 *       hardDq:    boolean,    // any hard disqualifier present
 *       dqReasons: string[],   // plain-English DQ reasons (empty if none)
 *       risk:      number,     // 0..N deterministic risk score
 *       flags:     string[],   // plain-English risk-flag labels that fired
 *       highRisk:  boolean,    // risk >= DETERMINISTIC_RISK_BLOCK_THRESHOLD
 *       threshold: number      // the high-risk threshold used
 *     }
 *
 * This function NEVER throws and NEVER changes state.
 */
function getDeterministicSignals_(prescreenPayload, roleRule) {
  var payload = prescreenPayload && typeof prescreenPayload === 'object' ? prescreenPayload : {};
  var rule    = roleRule && typeof roleRule === 'object' ? roleRule : null;

  var dqReasons = detectHardDisqualifiers_(payload, rule);
  var riskObj   = computeDeterministicRisk_(payload, rule);
  var threshold = CFG.getInt('DETERMINISTIC_RISK_BLOCK_THRESHOLD', DET_RISK_BLOCK_THRESHOLD_DEFAULT);

  return {
    hardDq:    dqReasons.length > 0,
    dqReasons: dqReasons,
    risk:      riskObj.score,
    flags:     riskObj.flags,
    highRisk:  riskObj.score >= threshold,
    threshold: threshold
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HARD DISQUALIFIERS (adapted from recruiting_os/06_scoring.gs)
// Returns an array of plain-English reasons. Empty array = no hard DQ.
// Only flags things that are genuinely disqualifying AND that the candidate's
// own answer makes explicit — when an answer is blank/ambiguous we do NOT DQ
// (we let a flag or the AI handle uncertainty). Never eliminates on a guess.
// ─────────────────────────────────────────────────────────────────────────────

function detectHardDisqualifiers_(prescreenPayload, roleRule) {
  var p = prescreenPayload || {};
  var rule = roleRule || {};
  var reasons = [];

  // Work authorization: explicit "no" only.
  var workAuth = _detPick_(p, ['work auth', 'authorized to work', 'legally authorized', 'eligible to work']);
  if (workAuth && _detIsNo_(workAuth)) reasons.push('Not authorized to work in the US');

  // Schedule incompatibility: explicit "no" / "cannot" against the role's
  // required availability.
  var schedule = _detPick_(p, ['schedule ok', 'available', 'availability', 'can you work', 'work the schedule', 'work these hours']);
  if (schedule && (/^\s*no\b/i.test(schedule) || /\bcannot\b|\bcan't\b|\bunable\b/i.test(schedule))) {
    reasons.push('Schedule incompatible with required availability' +
      (rule['Required Availability'] ? ' (' + String(rule['Required Availability']) + ')' : ''));
  }

  // Driver's license: only a hard DQ when the role REQUIRES one and the
  // candidate explicitly says no.
  if (_detBool_(rule['Valid Drivers License Required'])) {
    var dl = _detPick_(p, ["driver's license", 'drivers license', 'valid license', 'driver license']);
    if (dl && _detIsNo_(dl)) reasons.push("No valid driver's license (required for this role)");
  }

  // Background check: only when the role REQUIRES it and the candidate refuses
  // or says no.
  if (_detBool_(rule['Background Check Required'])) {
    var bg = _detPick_(p, ['background check', 'background ok', 'consent to background', 'pass a background']);
    if (bg && (/^\s*no\b/i.test(bg) || /refuse|won't|will not|decline/i.test(bg))) {
      reasons.push('Failed/refused required background check');
    }
  }

  return reasons;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC RISK (adapted from recruiting_os/07_risk_review.gs)
// Ports the 9 flag* functions. Returns { score, flags[] } where flags are
// plain-English labels. Weights preserved from B (total possible = 20).
// ─────────────────────────────────────────────────────────────────────────────

function computeDeterministicRisk_(prescreenPayload, roleRule) {
  var p = prescreenPayload || {};
  var rule = roleRule || {};
  var role = String(_detPick_(p, ['role applied', 'position applied', 'role', 'position']) || '');

  var checks = [
    { w: 3, label: 'Experience mismatch',                  on: _detFlagExperienceMismatch_(p, rule) },
    { w: 2, label: 'Vague answers',                        on: _detFlagVagueAnswers_(p) },
    { w: 2, label: 'AI-style / over-polished answers',     on: _detFlagAiStyleAnswers_(p) },
    { w: 3, label: 'Schedule contradiction',               on: _detFlagScheduleContradiction_(p) },
    { w: 2, label: 'Role confusion',                       on: _detFlagRoleConfusion_(p, role) },
    { w: 3, label: 'Blame language',                       on: _detFlagBlameLanguage_(p) },
    { w: 1, label: 'Unexplained resume gap',               on: _detFlagResumeGap_(p) },
    { w: 2, label: 'Pay mismatch (extreme)',               on: _detFlagPayMismatchExtreme_(p, rule) },
    { w: 2, label: 'No customer-service references',       on: _detFlagNoCsReferences_(p, role) }
  ];

  var score = 0;
  var flags = [];
  checks.forEach(function (c) {
    if (c.on) { score += c.w; flags.push(c.label + ' (+' + c.w + ')'); }
  });

  return { score: score, flags: flags };
}

// ── the 9 flag detectors (private; adapted to A's payload shape) ─────────────

function _detFlagExperienceMismatch_(p, rule) {
  var years = parseFloat(String(_detPick_(p, ['years experience', 'years of experience', 'experience years']) || '').replace(/[^0-9.]/g, ''));
  if (isNaN(years)) return false;
  var minY = Number(rule['Minimum Experience Years'] || 0);
  var resume = String(_detPick_(p, ['resume', 'resume text', 'resume link', 'work history']) || '').toLowerCase();
  var yearMatches = (resume.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
  if (minY > 0 && years > minY * 2 && yearMatches.length < 2) return true;
  if (years >= 5 && resume.length < 80) return true;
  return false;
}

function _detFlagVagueAnswers_(p) {
  var combined = [
    _detPick_(p, ['why interested', 'why do you want', 'why this role']),
    _detPick_(p, ['difficult customer', 'difficult customer story', 'tough customer']),
    _detPick_(p, ['mistake story', 'a time you made a mistake', 'tell us about a mistake'])
  ].map(function (s) { return String(s || ''); }).join(' ');
  if (combined.length < 80) return true;
  if (!/\d/.test(combined) && combined.length < 220) return true;
  if (/(in general|usually|always|sometimes)/i.test(combined) && combined.length < 180) return true;
  return false;
}

function _detFlagAiStyleAnswers_(p) {
  var t = String(_detPick_(p, ['why interested', 'why do you want']) || '') + ' ' +
          String(_detPick_(p, ['difficult customer', 'difficult customer story']) || '');
  var triggers = /(leverage|synerg|paramount|in today's fast-paced|cutting-edge|esteemed|delve into|tapestry)/i;
  var perfect = t.length > 280 && (t.match(/[.!?]/g) || []).length >= 5 &&
                !/(um|uh|like, |honestly|tbh|kind of)/i.test(t);
  return triggers.test(t) || perfect;
}

function _detFlagScheduleContradiction_(p) {
  var s1 = String(_detPick_(p, ['schedule ok', 'available', 'availability', 'can you work']) || '');
  var s2 = String(_detPick_(p, ['best contact time', 'best time to contact', 'preferred contact']) || '');
  var anythingElse = String(_detPick_(p, ['anything else', 'additional comments', 'other comments']) || '');
  if (/^\s*yes/i.test(s1) && /(weekend only|evenings only|nights only)/i.test(s2)) return true;
  if (/^\s*no/i.test(s1) && /full[-\s]?time/i.test(anythingElse)) return true;
  return false;
}

function _detFlagRoleConfusion_(p, role) {
  if (!role) return false;
  var t = (String(_detPick_(p, ['why interested', 'why do you want']) || '') + ' ' +
           String(_detPick_(p, ['current role', 'current employer', 'current role employer', 'most recent job']) || '')).toLowerCase();
  // Match by canonical role substring so wording drift (e.g. "CX / Valet
  // Porter Driver") still resolves to a keyword set.
  var keywordSets = [
    { test: /service advisor|advisor/i,            words: ['advisor', 'customer', 'write up', 'service', 'estimate'] },
    { test: /technician|^tech$/i,                  words: ['tech', 'mechanic', 'diagnos', 'repair', 'wrench'] },
    { test: /lube/i,                               words: ['oil', 'lube', 'fluid', 'tire', 'filter'] },
    { test: /valet|porter|driver|cx/i,             words: ['valet', 'porter', 'lot', 'shuttle', 'wash', 'drive', 'customer'] },
    { test: /parts/i,                              words: ['parts', 'vendor', 'catalog', 'inventory'] },
    { test: /customer experience|reception|front/i, words: ['customer', 'front desk', 'reception', 'support', 'cx'] }
  ];
  var keywords = null;
  for (var i = 0; i < keywordSets.length; i++) {
    if (keywordSets[i].test.test(role)) { keywords = keywordSets[i].words; break; }
  }
  if (!keywords) return false;
  var hits = 0;
  keywords.forEach(function (k) { if (t.indexOf(k) !== -1) hits++; });
  return hits === 0 && t.length > 60;
}

function _detFlagBlameLanguage_(p) {
  var t = [
    _detPick_(p, ['mistake story', 'a time you made a mistake']),
    _detPick_(p, ['ownership meaning', 'what does ownership mean', 'taking ownership']),
    _detPick_(p, ['manager style', 'ideal manager', 'best manager']),
    _detPick_(p, ['difficult customer', 'difficult customer story'])
  ].map(function (s) { return String(s || ''); }).join(' ');
  return /(customers always|managers always|nobody ever|not my fault|wasn't my problem|they were stupid|they didn't|micromanag)/i.test(t);
}

function _detFlagResumeGap_(p) {
  var resume = String(_detPick_(p, ['resume', 'resume text', 'resume link', 'work history']) || '');
  var years = (resume.match(/\b(20\d{2}|19\d{2})\b/g) || []).map(Number).sort();
  if (years.length < 2) return false;
  for (var i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] >= 2) return true;
  }
  return false;
}

function _detFlagPayMismatchExtreme_(p, rule) {
  var nums = (String(rule['Pay Range'] || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return false;
  var hi = Math.max.apply(null, nums);
  var pay = parseFloat((String(_detPick_(p, ['pay expectations', 'pay expectation', 'desired pay', 'salary expectation', 'expected pay']) || '').match(/\d+(?:\.\d+)?/) || [0])[0]);
  if (!pay) return false;
  return pay > hi * 1.30;
}

function _detFlagNoCsReferences_(p, role) {
  if (!/Advisor|CX|Customer|Valet|Porter|Driver/i.test(String(role))) return false;
  var t = (String(_detPick_(p, ['difficult customer', 'difficult customer story']) || '') + ' ' +
           String(_detPick_(p, ['why interested', 'why do you want']) || '')).toLowerCase();
  return !/customer|client|guest|patron/.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD FIELD ACCESS — header-substring matching (case-insensitive).
// Google Form headers are free text and drift, so we match by substring of the
// question text rather than an exact column name.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the first non-empty payload value whose header contains ANY of the
 * given substrings (case-insensitive). Returns '' if nothing matches.
 */
function _detPick_(payload, substrings) {
  if (!payload) return '';
  var keys = Object.keys(payload);
  for (var s = 0; s < substrings.length; s++) {
    var needle = String(substrings[s]).toLowerCase();
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].toLowerCase().indexOf(needle) !== -1) {
        var v = String(payload[keys[k]] == null ? '' : payload[keys[k]]).trim();
        if (v) return v;
      }
    }
  }
  return '';
}

function _detIsNo_(v) {
  // Explicit "no" answer. "Yes" / blank / ambiguous → not a no (no DQ on a guess).
  return /^\s*no\b/i.test(String(v || '')) && !/^\s*no problem|^\s*not a problem/i.test(String(v || ''));
}

// Boolean coercion for Role Rules cells (A has no boolFromCell_; this is local).
function _detBool_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'required' || s === 'y';
}

function _detToInt_(v, dflt) {
  var n = parseInt(String(v == null ? '' : v).replace(/[^\-0-9]/g, ''), 10);
  return isNaN(n) ? dflt : n;
}

function _detBuildNotes_(signals, enforce, aiAlreadyCaught) {
  var bits = [];
  if (signals.hardDq) bits.push('HARD DQ: ' + signals.dqReasons.join(', '));
  if (signals.highRisk) bits.push('HIGH RISK (' + signals.risk + '>=' + signals.threshold + '): ' + signals.flags.join(', '));
  else if (signals.flags.length) bits.push('risk ' + signals.risk + ': ' + signals.flags.join(', '));
  if (!signals.hardDq && !signals.highRisk) bits.push('clean — no hard DQ, risk ' + signals.risk);
  if ((signals.hardDq || signals.highRisk) && aiAlreadyCaught) bits.push('(AI already routed to review/decline)');
  if ((signals.hardDq || signals.highRisk) && !enforce) bits.push('(advisory only — enforcement OFF)');
  return bits.join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — pure, read-only (no sheet writes, no status changes).
// Covers: clean candidate, hard-DQ candidate, high-risk candidate.
// ─────────────────────────────────────────────────────────────────────────────

function DETERMINISTIC_RISK_selfTest() {
  var out = ['[DET_BACKSTOP] selfTest (read-only)…'];
  out.push('  ─ DETERMINISTIC_BACKSTOP_ENABLED : ' + CFG.getBool('DETERMINISTIC_BACKSTOP_ENABLED', true));
  out.push('  ─ DETERMINISTIC_BACKSTOP_ENFORCE : ' + CFG.getBool('DETERMINISTIC_BACKSTOP_ENFORCE', false));
  out.push('  ─ RISK_BLOCK_THRESHOLD           : ' + CFG.getInt('DETERMINISTIC_RISK_BLOCK_THRESHOLD', DET_RISK_BLOCK_THRESHOLD_DEFAULT));

  // Role rule used for DQ + experience/pay checks.
  var rule = {
    'Role': 'Service Advisor',
    'Valid Drivers License Required': 'TRUE',
    'Background Check Required': 'TRUE',
    'Minimum Experience Years': '3',
    'Pay Range': '$20 - $28',
    'Required Availability': 'Mon-Fri days'
  };

  // 1) CLEAN candidate — qualified, specific, customer-focused, no contradictions.
  var clean = {
    'Role Applied': 'Service Advisor',
    'Work Auth': 'Yes, I am authorized to work in the US',
    'Schedule OK': 'Yes, Mon-Fri days work great for me',
    "Driver's License": 'Yes, valid and clean',
    'Background Check OK': 'Yes, happy to consent',
    'Years Experience': '4',
    'Pay Expectations': '$24/hr',
    'Resume Text Or Link': 'Worked 2018-2022 at a dealership, 2022-2026 at an indie shop as a service advisor.',
    'Why Interested': 'I have 4 years writing service for European cars and love helping customers understand repairs. I closed 2 to 3 estimates a day.',
    'Difficult Customer Story': 'A customer was upset about a 600 dollar brake estimate. I listened, walked them through the inspection photos, and we resolved it with a payment plan.',
    'Mistake Story': 'I once forgot to call a customer back; I apologized, owned it, and built a callback checklist so it never happened again.',
    'Ownership Meaning': 'Ownership means I follow a problem through to resolution even when it is not strictly my job.'
  };

  // 2) HARD-DQ candidate — not authorized + refuses background + no license.
  var hardDq = {
    'Role Applied': 'Service Advisor',
    'Work Auth': 'No, I am not currently authorized to work in the US',
    'Schedule OK': 'No, I cannot work the required hours',
    "Driver's License": 'No, I do not have a license',
    'Background Check OK': 'No, I refuse a background check',
    'Years Experience': '4',
    'Pay Expectations': '$24/hr',
    'Why Interested': 'I want a job.'
  };

  // 3) HIGH-RISK candidate — vague + blame + role confusion + pay extreme +
  //    experience mismatch + no CS refs (no hard DQ).
  var highRisk = {
    'Role Applied': 'Service Advisor',
    'Work Auth': 'Yes',
    'Schedule OK': 'Yes',
    "Driver's License": 'Yes',
    'Background Check OK': 'Yes',
    'Years Experience': '12',
    'Pay Expectations': '$45/hr',
    'Resume Text Or Link': 'stuff',
    'Why Interested': 'In general I usually do a good job and always try hard.',
    'Difficult Customer Story': 'It was not my fault, the customers always complain and nobody ever listens to me.',
    'Mistake Story': 'They didn\'t tell me what to do so it wasn\'t my problem.',
    'Ownership Meaning': 'idk'
  };

  function reportCase(name, payload, expectDq, expectHigh) {
    var sig = getDeterministicSignals_(payload, rule);
    var dqOk = (sig.hardDq === expectDq);
    var hiOk = (sig.highRisk === expectHigh);
    out.push('  ' + ((dqOk && hiOk) ? '✓' : '✗') + ' ' + name +
      ' → hardDq=' + sig.hardDq + ' (exp ' + expectDq + '), risk=' + sig.risk +
      ', highRisk=' + sig.highRisk + ' (exp ' + expectHigh + ')');
    if (sig.dqReasons.length) out.push('        DQ: ' + sig.dqReasons.join('; '));
    if (sig.flags.length)     out.push('        flags: ' + sig.flags.join('; '));
  }

  reportCase('clean candidate',    clean,    false, false);
  reportCase('hard-DQ candidate',  hardDq,   true,  false);   // hard DQ present
  reportCase('high-risk candidate', highRisk, false, true);   // no DQ, risk >= threshold

  out.push('[DET_BACKSTOP] selfTest done. (advisory — no candidate data touched)');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
