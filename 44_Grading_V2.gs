/**
 * 44_Grading_V2.gs
 * Frank's European Service — Recruiting OS
 *
 * RUBRIC-ANCHORED PRE-SCREEN GRADING (V2).
 *
 * WHAT WAS WRONG WITH V1
 * ----------------------
 * The 'prescreen' prompt instructed the model to "Apply the rubric weights
 * listed in AI Grading Rubrics" — but the rubric was NEVER passed into the
 * prompt. The only merge fields were Payload / RoleName / RoleRequirements /
 * Provider / Model. RoleRequirements resolved to Role Rules['Notes'], which is
 * blank for most roles and, for Service Advisor, literally read
 * "Fill in booking links and pay range."
 *
 * So the model produced an unanchored impression score. The fingerprint of that
 * is visible in the live data: 23 scored candidates share only 9 distinct
 * values, and "78 / risk 3" repeats 9 times in the Interview Pipeline. A grader
 * that returns the same number for nine different people is not ranking anyone.
 *
 * WHAT V2 DOES
 * ------------
 *   1. Injects the ACTUAL rubric rows (category, weight, criteria) from the
 *      "AI Grading Rubrics" tab into the prompt, with explicit 0–10 anchors.
 *   2. Injects the ACTUAL role requirements from the Role Rules row —
 *      minimum experience years, required availability, licence, background
 *      check, pay range — instead of a blank Notes cell.
 *   3. Asks the model to score EACH CATEGORY 0–10 and cite the evidence.
 *   4. Computes the 0–100 score IN SCRIPT as the weighted sum. The model no
 *      longer picks the headline number, so it cannot snap to 78. Weights stay
 *      editable in the sheet; changing a weight changes scoring with no code
 *      change.
 *   5. Applies deterministic hard gates the LLM should never own — stated
 *      experience below the role's minimum, no valid licence when required.
 *   6. Writes the full grade: per-category breakdown, strengths, concerns,
 *      credibility, confidence, recommended next step. V1 computed most of
 *      these and threw them away.
 *
 * REVERSIBLE: set GRADING_V2_ENABLED=FALSE in Config to fall back to V1.
 *
 * Public functions:
 *   GRADE_prescreenV2_(candidateId)     — the graded result (no writes)
 *   GRADE_installV2Prompt()             — writes the V2 prompt into the sheet
 *   GRADE_calibrationReport()           — score spread before/after, per role
 *   GRADE_selfTest()                    — read-only
 */

var GRADE_DETAIL_SHEET = 'Grade Detail';
var GRADE_DETAIL_HEADERS = Object.freeze([
  'Timestamp', 'Candidate ID', 'Full Name', 'Role', 'Rubric Key',
  'Weighted Score', 'Risk Score', 'Credibility', 'Confidence',
  'Hard Gate Failed', 'Hard Gate Reasons',
  'Category Breakdown', 'Strengths', 'Concerns',
  'Recommended Next Step', 'Summary', 'Source Tab', 'Model'
]);

// Categories where a HIGH raw signal is BAD. The model is told 10 = clean.
var GRADE_NEGATIVE_CATEGORY_RE = /blame|risk|red flag|concern|misrepresent/i;

// ─────────────────────────────────────────────────────────────────────────────
// RUBRIC + ROLE CONTEXT BLOCKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load rubric rows for a rubric key from the AI Grading Rubrics tab.
 * @return {{categories:Array<{category:string,weight:number,criteria:string,negative:boolean}>,
 *           totalWeight:number, text:string}}
 */
function GRADE_buildRubricBlock_(rubricKey) {
  var sh = getSheetOrNull_(SHEETS.AI_RUBRICS);
  var cats = [];
  if (sh) {
    var last = sh.getLastRow();
    if (last >= 2) {
      var headers = getHeaderRow_(sh);
      var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
      var cKey = headers.indexOf('Rubric Key'),
          cCat = headers.indexOf('Category'),
          cW   = headers.indexOf('Weight'),
          cCri = headers.indexOf('Criteria');
      data.forEach(function (r) {
        if (cKey < 0 || String(r[cKey] || '').trim().toLowerCase() !== String(rubricKey).toLowerCase()) return;
        var name = cCat >= 0 ? String(r[cCat] || '').trim() : '';
        if (!name) return;
        var w = cW >= 0 ? parseFloat(r[cW]) : 0;
        if (isNaN(w) || w <= 0) return;
        cats.push({
          category: name,
          weight: w,
          criteria: cCri >= 0 ? String(r[cCri] || '').trim() : '',
          negative: GRADE_NEGATIVE_CATEGORY_RE.test(name)
        });
      });
    }
  }

  var total = 0;
  cats.forEach(function (c) { total += c.weight; });

  var lines = cats.map(function (c, i) {
    var dir = c.negative
      ? '10 = none of this present at all; 0 = severe and repeated'
      : '10 = outstanding, concrete evidence; 5 = adequate but generic; 0 = absent or contradicted';
    return (i + 1) + '. ' + c.category + '  [weight ' + c.weight + ']\n' +
           '   Criteria: ' + (c.criteria || '(see category name)') + '\n' +
           '   Anchor: ' + dir;
  });

  return {
    categories: cats,
    totalWeight: total,
    text: lines.length ? lines.join('\n') : '(no rubric rows found for key "' + rubricKey + '")'
  };
}

/** Structured role requirements from the Role Rules row — not the Notes cell. */
function GRADE_buildRoleContextBlock_(roleName, roleRule) {
  if (!roleRule) return 'Role: ' + roleName + '\n(No Role Rules row found — grade on general fit.)';
  function v(k, dflt) {
    var x = roleRule[k];
    return (x === undefined || x === null || String(x).trim() === '') ? (dflt || 'not specified') : String(x).trim();
  }
  var lines = [
    'Role: ' + roleName,
    'Minimum relevant experience required: ' + v('Minimum Experience Years', '0') + ' year(s)',
    'Required availability: ' + v('Required Availability'),
    'Valid driver’s licence required: ' + v('Valid Drivers License Required'),
    'Background check required: ' + v('Background Check Required'),
    'Posted pay range: ' + v('Pay Range'),
    'Passing score for this role: ' + v('Minimum Score'),
    'Auto-booking score for this role: ' + v('Auto Booking Minimum Score')
  ];
  var notes = String(roleRule['Notes'] || '').trim();
  // Ignore admin leftovers like "Fill in booking links and pay range."
  if (notes && !/fill in|todo|tbd|placeholder/i.test(notes)) lines.push('Hiring manager notes: ' + notes);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// THE V2 PROMPT
// ─────────────────────────────────────────────────────────────────────────────

var GRADE_V2_PROMPT_BODY =
'You are grading a job pre-screen for Frank\'s European Service, an independent European auto repair shop in Las Vegas. Be a demanding, evidence-driven grader. Most real applicants are average; reserve high category scores for answers that contain specific, checkable detail.\n' +
'\n' +
'ROLE CONTEXT\n' +
'{{RoleContext}}\n' +
'\n' +
'RUBRIC — score EVERY category below from 0 to 10 (integers only).\n' +
'{{Rubric}}\n' +
'\n' +
'GRADING RULES\n' +
'1. Score each category ONLY on evidence present in the candidate payload. If a category has nothing to judge, score it 3, not 5.\n' +
'2. Generic, polished, content-free answers are NOT good answers. "I always give 110%" is a 2, not an 8.\n' +
'3. Specific beats positive. A candidate who names a vehicle, a tool, a process, a number, or a real mistake outranks one who sounds enthusiastic.\n' +
'4. Compare stated experience against the role\'s minimum experience requirement above and say plainly whether it is met.\n' +
'5. Do NOT produce an overall score. The system computes it from your category scores and the sheet\'s weights.\n' +
'6. Spread your scores. If every category lands on 7 or 8, you are not grading.\n' +
'\n' +
'CANDIDATE PAYLOAD\n' +
'{{Payload}}\n' +
'\n' +
'Return ONE valid JSON object and nothing else. Your entire response must start with "{" and end with "}".\n' +
'{\n' +
'  "categories": [ { "category": "<exact category name from the rubric>", "score": <0-10>, "evidence": "<short quote or paraphrase from the payload that justifies the score>" } ],\n' +
'  "ai_risk_score": <0-10, 0 = no concern, 10 = serious credibility or reliability concern>,\n' +
'  "credibility_score": <0-10>,\n' +
'  "possible_misrepresentation": "<Yes or No>",\n' +
'  "meets_minimum_experience": "<Yes or No or Unclear>",\n' +
'  "stated_experience_years": <number, best estimate from the payload, or -1 if not stated>,\n' +
'  "strengths": ["<three specific strengths>"],\n' +
'  "concerns": ["<three specific concerns>"],\n' +
'  "recommended_next_step": "<Advance to live interview | Manual review | Decline>",\n' +
'  "confidence_level": "<High|Medium|Low>",\n' +
'  "ai_authored_likelihood": <0-100>,\n' +
'  "ai_authored_reasoning": "<1-2 sentences>",\n' +
'  "summary": "<2-3 sentences a hiring manager can read in five seconds>"\n' +
'}';

/**
 * Write the V2 prompt into the AI Prompt Templates tab under key 'prescreen'.
 * The V1 body is preserved as 'prescreen_v1_archived' so the change is
 * reversible from inside the sheet. Idempotent.
 */
function GRADE_installV2Prompt() {
  var sh = getSheetOrNull_(SHEETS.AI_PROMPTS);
  if (!sh) return '[GRADE_V2] AI Prompt Templates tab missing';

  return withLock_(function () {
    var hits = findRowsByColumnValue_(sh, 'Prompt Key', 'prescreen');
    if (hits.length) {
      var existing = String(hits[0].data['Prompt Body'] || '');
      var already = existing.indexOf('{{Rubric}}') !== -1;
      if (!already) {
        var archived = findRowsByColumnValue_(sh, 'Prompt Key', 'prescreen_v1_archived');
        if (!archived.length) {
          appendRowByHeader_(sh, {
            'Prompt Key': 'prescreen_v1_archived',
            'Phase': 'PreScreen',
            'Provider': hits[0].data['Provider'] || 'gemini',
            'Model': hits[0].data['Model'] || '{{Model}}',
            'Temperature': hits[0].data['Temperature'] || '',
            'Prompt Body': existing,
            'Notes': 'Archived V1 body on ' + shopDateTime_() + '. Rubric was never injected. Kept for rollback.'
          });
        }
      }
      updateRowWhere_(sh, 'Prompt Key', 'prescreen', {
        'Prompt Body': GRADE_V2_PROMPT_BODY,
        'Phase': 'PreScreen',
        'Notes': 'V2 rubric-anchored. Merge fields: {{RoleContext}} {{Rubric}} {{Payload}}. Overall score computed in script from category scores x sheet weights.'
      });
    } else {
      appendRowByHeader_(sh, {
        'Prompt Key': 'prescreen', 'Phase': 'PreScreen', 'Provider': 'gemini',
        'Model': '{{Model}}', 'Temperature': '0.2',
        'Prompt Body': GRADE_V2_PROMPT_BODY,
        'Notes': 'V2 rubric-anchored.'
      });
    }
    logEvent_('GRADE_V2_PROMPT_INSTALLED', '', {});
    var msg = '[GRADE_V2] prescreen prompt installed (V1 archived as prescreen_v1_archived)';
    Logger.log(msg);
    try { toast_(msg, 'Recruiting OS', 8); } catch (e) {}
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING MATH — deterministic, in script, weights from the sheet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weighted 0-100 score from the model's 0-10 category scores.
 * Missing categories are dropped and remaining weights renormalized, so a
 * partial response degrades instead of scoring 0.
 * @return {{score:number|null, covered:number, expected:number, breakdown:Array}}
 */
function GRADE_computeWeightedScore_(categoryScores, rubricCats) {
  var byName = {};
  (categoryScores || []).forEach(function (c) {
    if (!c) return;
    var n = String(c.category || '').trim().toLowerCase();
    if (!n) return;
    var s = parseFloat(c.score);
    if (isNaN(s)) return;
    byName[n] = { score: Math.max(0, Math.min(10, s)), evidence: String(c.evidence || '') };
  });

  var sum = 0, wTotal = 0, breakdown = [], covered = 0;
  rubricCats.forEach(function (rc) {
    var hit = byName[rc.category.toLowerCase()];
    if (!hit) {
      breakdown.push({ category: rc.category, weight: rc.weight, score: null, evidence: '(not returned)' });
      return;
    }
    covered++;
    sum += hit.score * rc.weight;
    wTotal += rc.weight;
    breakdown.push({ category: rc.category, weight: rc.weight, score: hit.score, evidence: hit.evidence });
  });

  if (!wTotal) return { score: null, covered: 0, expected: rubricCats.length, breakdown: breakdown };
  // (0-10 weighted average) x 10 -> 0-100
  var score = Math.round((sum / wTotal) * 10);
  return { score: score, covered: covered, expected: rubricCats.length, breakdown: breakdown };
}

/**
 * Deterministic hard gates the LLM must never own.
 * Returns { failed:boolean, reasons:string[] }.
 */
function GRADE_hardGates_(ai, roleRule, payload) {
  var reasons = [];
  if (!roleRule) return { failed: false, reasons: reasons };

  var minYears = parseFloat(roleRule['Minimum Experience Years']);
  if (!isNaN(minYears) && minYears > 0) {
    var stated = parseFloat(ai.stated_experience_years);
    if (!isNaN(stated) && stated >= 0 && stated < minYears) {
      reasons.push('Stated experience ' + stated + ' yr < role minimum ' + minYears + ' yr');
    } else if (String(ai.meets_minimum_experience || '').toLowerCase() === 'no') {
      reasons.push('Model judged minimum experience (' + minYears + ' yr) not met');
    }
  }

  if (String(roleRule['Valid Drivers License Required'] || '').trim().toUpperCase() === 'TRUE') {
    var lic = GRADE_pickPayload_(payload, ['driver', 'license', 'licence']);
    if (lic && /\b(no|none|expired|suspended|do not have|don't have)\b/i.test(lic)) {
      reasons.push('Valid driver’s licence required; candidate answer indicates none/expired');
    }
  }
  return { failed: reasons.length > 0, reasons: reasons };
}

/** Case-insensitive substring lookup across payload keys. */
function GRADE_pickPayload_(payload, fragments) {
  if (!payload) return '';
  var keys = Object.keys(payload);
  for (var i = 0; i < keys.length; i++) {
    var lk = keys[i].toLowerCase();
    for (var j = 0; j < fragments.length; j++) {
      if (lk.indexOf(fragments[j]) !== -1) return String(payload[keys[i]] || '');
    }
  }
  return '';
}

/** Normalize the V2 JSON shape. Never throws. */
function GRADE_validateV2Json_(obj) {
  var o = obj && typeof obj === 'object' ? obj : {};
  function toInt(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
  function toArr(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x || ''); }).filter(Boolean);
    if (!v) return [];
    return String(v).split(/\s*[;|\n]\s*/).filter(Boolean);
  }
  return {
    categories:                 Array.isArray(o.categories) ? o.categories : [],
    ai_risk_score:              Math.max(0, Math.min(10, toInt(o.ai_risk_score, 0))),
    credibility_score:          Math.max(0, Math.min(10, toInt(o.credibility_score, 0))),
    possible_misrepresentation: String(o.possible_misrepresentation || 'No'),
    meets_minimum_experience:   String(o.meets_minimum_experience || 'Unclear'),
    stated_experience_years:    (o.stated_experience_years === undefined || o.stated_experience_years === null || o.stated_experience_years === '') ? -1 : parseFloat(o.stated_experience_years),
    strengths:                  toArr(o.strengths),
    concerns:                   toArr(o.concerns),
    recommended_next_step:      String(o.recommended_next_step || 'Manual review'),
    confidence_level:           String(o.confidence_level || 'Low'),
    ai_authored_likelihood:     toInt(o.ai_authored_likelihood, 0),
    ai_authored_reasoning:      String(o.ai_authored_reasoning || ''),
    summary:                    String(o.summary || '')
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: grade one candidate (computes only — caller writes status/emails)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade a candidate's pre-screen with the rubric-anchored engine.
 * @return {{ok:boolean, score:number|null, risk:number, ai:object, breakdown:Array,
 *           gates:{failed:boolean,reasons:string[]}, sourceTab:string, error:string}}
 */
function GRADE_prescreenV2_(candidateId) {
  var candidate = _getCandidateRow_(candidateId);
  if (!candidate) return { ok: false, error: 'candidate not found: ' + candidateId };

  var payload = (typeof PS_buildPayloadFor_ === 'function')
    ? PS_buildPayloadFor_(candidate['Email'])
    : null;
  if (!payload) {
    // fall back to the legacy single-tab lookup so V2 never regresses V1 reach
    var legacyRow = (typeof _findPreScreenRow_ === 'function') ? _findPreScreenRow_(candidate['Email']) : 0;
    if (legacyRow) payload = _buildPreScreenPayload_(legacyRow);
  }
  if (!payload || Object.keys(payload).length < 3) {
    return { ok: false, error: 'no pre-screen response found for ' + candidate['Email'] };
  }
  var sourceTab = payload.__source_tab || SHEETS.RAW_PRESCREEN;
  var cleanPayload = {};
  Object.keys(payload).forEach(function (k) { if (k.indexOf('__') !== 0) cleanPayload[k] = payload[k]; });

  var roleRule = _getRoleRule_(candidate['Role']);
  var rubric   = GRADE_buildRubricBlock_('prescreen');
  if (!rubric.categories.length) {
    return { ok: false, error: 'no rubric rows for key "prescreen" in AI Grading Rubrics' };
  }

  var promptRow = _loadAiPrompt_('prescreen');
  var body = (promptRow && String(promptRow['Prompt Body'] || '').indexOf('{{Rubric}}') !== -1)
    ? String(promptRow['Prompt Body'])
    : GRADE_V2_PROMPT_BODY;

  var promptText = renderMerge_(body, {
    RoleContext: GRADE_buildRoleContextBlock_(candidate['Role'], roleRule),
    Rubric:      rubric.text,
    Payload:     JSON.stringify(cleanPayload, null, 2),
    RoleName:    candidate['Role'],
    Model:       CFG.get('GEMINI_MODEL'),
    Provider:    CFG.get('AI_PROVIDER', 'gemini')
  });

  var result = _geminiGradeJson_('prescreen_v2', candidateId, promptText);
  if (!result.ok) return { ok: false, error: result.error || 'AI call failed' };

  var ai = GRADE_validateV2Json_(result.data);
  var computed = GRADE_computeWeightedScore_(ai.categories, rubric.categories);

  if (computed.score === null) {
    return { ok: false, error: 'AI returned no usable category scores (0 of ' + rubric.categories.length + ')' };
  }
  // Guard: a response covering fewer than half the categories is not a grade.
  if (computed.covered < Math.ceil(rubric.categories.length / 2)) {
    return { ok: false, error: 'AI covered only ' + computed.covered + '/' + rubric.categories.length + ' rubric categories' };
  }

  var gates = GRADE_hardGates_(ai, roleRule, cleanPayload);

  return {
    ok: true, score: computed.score, risk: ai.ai_risk_score, ai: ai,
    breakdown: computed.breakdown, coverage: computed.covered + '/' + computed.expected,
    gates: gates, sourceTab: sourceTab, error: ''
  };
}

/** Write the audit row + the rich fields V1 discarded. */
function GRADE_writeDetail_(candidateId, candidate, g) {
  safeRun_('grade:detailWrite', function () {
    var sh = getOrCreateSheet_(GRADE_DETAIL_SHEET, GRADE_DETAIL_HEADERS);
    ensureHeaders_(sh, GRADE_DETAIL_HEADERS);
    var bd = g.breakdown.map(function (b) {
      return b.category + '=' + (b.score === null ? '—' : b.score) + '/10 (w' + b.weight + ')';
    }).join(' | ');
    appendRowByHeader_(sh, {
      'Timestamp':             shopDateTime_(),
      'Candidate ID':          candidateId,
      'Full Name':             ((candidate['First Name'] || '') + ' ' + (candidate['Last Name'] || '')).trim(),
      'Role':                  candidate['Role'] || '',
      'Rubric Key':            'prescreen',
      'Weighted Score':        g.score,
      'Risk Score':            g.risk,
      'Credibility':           g.ai.credibility_score,
      'Confidence':            g.ai.confidence_level,
      'Hard Gate Failed':      g.gates.failed ? 'TRUE' : 'FALSE',
      'Hard Gate Reasons':     g.gates.reasons.join('; '),
      'Category Breakdown':    truncate_(bd, 900),
      'Strengths':             truncate_(g.ai.strengths.join(' | '), 500),
      'Concerns':              truncate_(g.ai.concerns.join(' | '), 500),
      'Recommended Next Step': g.ai.recommended_next_step,
      'Summary':               truncate_(g.ai.summary, 500),
      'Source Tab':            g.sourceTab,
      'Model':                 CFG.get('GEMINI_MODEL')
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION — proves whether the grader actually discriminates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only. Reports the spread of existing AI Scores. A healthy grader spreads
 * candidates out; a broken one clusters them. Run this before and after the V2
 * re-score to see the difference.
 */
function GRADE_calibrationReport() {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return '[GRADE_V2] All Candidates missing';
  var last = ac.getLastRow();
  if (last < 2) return '[GRADE_V2] no candidates';

  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var cScore = headers.indexOf('AI Score'), cRole = headers.indexOf('Role');

  var scores = [], byRole = {}, freq = {};
  data.forEach(function (r) {
    var s = cScore >= 0 ? parseFloat(r[cScore]) : NaN;
    if (isNaN(s)) return;
    scores.push(s);
    freq[s] = (freq[s] || 0) + 1;
    var role = cRole >= 0 ? String(r[cRole] || 'Unknown') : 'Unknown';
    (byRole[role] = byRole[role] || []).push(s);
  });

  var out = ['[GRADE_V2] calibration report — ' + shopDateTime_()];
  if (!scores.length) { out.push('  no scored candidates'); Logger.log(out.join('\n')); return out.join('\n'); }

  scores.sort(function (a, b) { return a - b; });
  var n = scores.length;
  var mean = scores.reduce(function (a, b) { return a + b; }, 0) / n;
  var sd = Math.sqrt(scores.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / n);
  var distinct = Object.keys(freq).length;
  var modeVal = null, modeCount = 0;
  Object.keys(freq).forEach(function (k) { if (freq[k] > modeCount) { modeCount = freq[k]; modeVal = k; } });

  out.push('  scored candidates : ' + n);
  out.push('  min / median / max: ' + scores[0] + ' / ' + scores[Math.floor(n / 2)] + ' / ' + scores[n - 1]);
  out.push('  mean / std dev    : ' + mean.toFixed(1) + ' / ' + sd.toFixed(1));
  out.push('  distinct values   : ' + distinct + ' across ' + n + ' candidates  (' + (distinct / n * 100).toFixed(0) + '% unique)');
  out.push('  most common score : ' + modeVal + ' appears ' + modeCount + ' time(s)');
  out.push('  VERDICT           : ' + (
    distinct / n < 0.45 || sd < 8
      ? 'CLUSTERED — the grader is not discriminating between candidates.'
      : 'SPREAD — the grader is separating candidates.'
  ));
  out.push('  by role:');
  Object.keys(byRole).sort().forEach(function (role) {
    var a = byRole[role].slice().sort(function (x, y) { return x - y; });
    out.push('    ' + role + ': n=' + a.length + '  range ' + a[0] + '-' + a[a.length - 1] +
             '  distinct=' + (function () { var s = {}; a.forEach(function (x) { s[x] = 1; }); return Object.keys(s).length; })());
  });

  var msg = out.join('\n');
  Logger.log(msg);
  logEvent_('GRADE_CALIBRATION', '', { n: n, distinct: distinct, sd: Math.round(sd * 10) / 10 });
  return msg;
}

/** Read-only sanity check of the V2 wiring. */
function GRADE_selfTest() {
  var out = ['[GRADE_V2] selfTest…'];
  out.push('  ─ GRADING_V2_ENABLED : ' + CFG.getBool('GRADING_V2_ENABLED', true));

  var rb = GRADE_buildRubricBlock_('prescreen');
  out.push('  ' + (rb.categories.length ? '✓' : '✗') + ' rubric categories loaded: ' + rb.categories.length +
           '  total weight=' + rb.totalWeight);
  rb.categories.forEach(function (c) {
    out.push('       ' + c.category + '  w=' + c.weight + (c.negative ? '  [negative-direction]' : ''));
  });

  ['Technician', 'Service Advisor'].forEach(function (role) {
    var rr = _getRoleRule_(role);
    out.push('  ─ role context for ' + role + ':');
    GRADE_buildRoleContextBlock_(role, rr).split('\n').forEach(function (l) { out.push('       ' + l); });
  });

  var p = _loadAiPrompt_('prescreen');
  var injected = p && String(p['Prompt Body'] || '').indexOf('{{Rubric}}') !== -1;
  out.push('  ' + (injected ? '✓' : '✗') + ' prescreen prompt has {{Rubric}} merge field' +
           (injected ? '' : ' — run GRADE_installV2Prompt()'));

  // Math check with a synthetic response.
  var fake = rb.categories.map(function (c, i) { return { category: c.category, score: (i % 2 === 0 ? 8 : 4), evidence: 'x' }; });
  var comp = GRADE_computeWeightedScore_(fake, rb.categories);
  out.push('  ─ math check: alternating 8/4 across ' + rb.categories.length + ' categories -> score ' + comp.score +
           ' (coverage ' + comp.covered + '/' + comp.expected + ')');

  out.push('[GRADE_V2] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}