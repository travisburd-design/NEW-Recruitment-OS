/**
 * 13_Skills_Test.gs
 * Frank's European Service — Recruiting OS
 *
 * Technician Skill Level Test workflow:
 *   - On auto-book for a Technician with score >= TECH_SKILL_TEST_MIN_SCORE,
 *     the technician_post_prescreen template (sent by 06_Scoring_Risk) bundles
 *     the booking link AND the skills test link in one email.
 *   - Candidate completes the SKILLS_TEST Google Form.
 *   - onSkillsTestSubmit fires → match candidate → extract auto-graded "Score"
 *     (Google Forms produces "NN / 100") → write to Interview Pipeline.
 *
 * Public functions:
 *   sendSkillsTest_(candidateId)
 *   onSkillsTestSubmit(e)
 *   SKILLS_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEND TEST INVITE (used when manager re-sends or for non-auto-book candidates)
// ─────────────────────────────────────────────────────────────────────────────

function sendSkillsTest_(candidateId) {
  var c = _getCandidateRow_(candidateId);
  if (!c) { logError_('sendSkillsTest_', 'candidate not found: ' + candidateId, candidateId, 'WARN'); return ''; }
  if (!c['Email']) { logError_('sendSkillsTest_', 'no email', candidateId, 'WARN'); return ''; }
  // Use technician_post_prescreen which includes both booking link and skill test
  return sendTemplatedEmail_('technician_post_prescreen', c['Email'], candidateId, {
    SkillsTestLink: CFG.get('TECH_SKILL_TEST_FORM_URL') || getFormUrl_('SKILLS_TEST')
  }, { reason: 'manual skill test invite' });
}

// ─────────────────────────────────────────────────────────────────────────────
// FORM SUBMIT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function onSkillsTestSubmit(e) {
  return safeRun_('onSkillsTestSubmit', function () {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var rowNum = e.range.getRow();
    var rowData = readRowAsObject_(sh, rowNum);

    var candidateEmail = normalizeEmail_(rowData['Email Address'] || rowData['Email'] || '');
    var candidateName  = String(rowData['First & Last Name'] || rowData['Full Name'] || rowData['Name'] || '').trim();
    var candidateId = candidateEmail ? _findCandidateByEmail_(candidateEmail) : '';
    if (!candidateId && candidateName) candidateId = _findCandidateByFullName_(candidateName);
    if (!candidateId) {
      logError_('skills:noMatch', 'no candidate match for skills test (email=' + candidateEmail + ', name=' + candidateName + ')', '', 'WARN');
      return;
    }

    var score = _extractSkillsScore_(rowData);
    logEvent_('SKILLS_TEST_SUBMITTED', candidateId, { row: rowNum, score: score });

    // Write Skills Test Score on Interview Pipeline (column may be named
    // "Full Interview Score" or a dedicated "Skill Test Score"; we update
    // both if present)
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (ip) {
      var updates = { 'Last Updated': shopDateTime_() };
      if (getColIndex_(ip, 'Skill Test Score')) updates['Skill Test Score'] = score;
      if (getColIndex_(ip, 'Full Interview Score') && !ip.getRange(2, 1).getValue()) {
        // only stamp Full Interview Score if blank — don't overwrite a real interview grade
      }
      if (getColIndex_(ip, 'Notes / Next Action')) {
        updates['Notes / Next Action'] = 'Skills Test completed: ' + score + '/100 @ ' + shopDateTime_();
      }
      updateRowWhere_(ip, 'Candidate ID', candidateId, updates);
    }
  });
}

/**
 * Extract numeric score 0-100 from a Skills Test response row.
 * The form's auto-graded "Score" field looks like "93 / 100" or "93".
 */
function _extractSkillsScore_(rowData) {
  var raw = String(rowData['Score'] || rowData['Total Score'] || rowData['Grade'] || '').trim();
  if (!raw) return 0;
  // Match "NN", "NN/100", "NN / 100", "NN%"
  var m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  return isNaN(n) ? 0 : Math.round(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function SKILLS_selfTest() {
  var out = ['[SKILLS] selfTest (read-only)…'];
  out.push('  ─ TECH_SKILL_TEST_MIN_SCORE: ' + CFG.getInt('TECH_SKILL_TEST_MIN_SCORE'));
  out.push('  ─ TECH_SKILL_TEST_FORM_URL : ' + truncate_(CFG.get('TECH_SKILL_TEST_FORM_URL'), 70));
  var sh = getSheetOrNull_(SHEETS.SKILLS_TEST_RESPONSES);
  out.push('  ─ Skill Test responses     : ' + (sh ? Math.max(0, sh.getLastRow() - 1) : 'sheet missing'));

  // Score extraction sanity
  var cases = [
    { row: { 'Score': '93 / 100' }, expect: 93 },
    { row: { 'Score': '78' },       expect: 78 },
    { row: { 'Score': '85%' },      expect: 85 },
    { row: { 'Score': '' },         expect: 0 },
    { row: { },                      expect: 0 }
  ];
  cases.forEach(function (c) {
    var got = _extractSkillsScore_(c.row);
    out.push('  ' + (got === c.expect ? '✓' : '✗') +
             ' _extractSkillsScore_(' + JSON.stringify(c.row) + ') → ' + got + ' (expected ' + c.expect + ')');
  });
  out.push('[SKILLS] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
