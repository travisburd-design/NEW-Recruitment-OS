/**
 * 20_Smoke_Tests.gs
 * Frank's European Service — Recruiting OS
 *
 * End-to-end smoke tests. Each test:
 *   - Forces SEND_ENABLED=FALSE while running (no real candidate email sent)
 *   - Cleans up every row it created
 *   - Returns a printable log
 *
 * Public functions:
 *   smokeTest()                     — run all smoke tests in sequence
 *   smokeTestEmailSafety()
 *   smokeTestCandidateJourney()
 *   smokeTestOtterTranscript()
 */

function smokeTest() {
  var out = ['========= SMOKE TEST RUN — ' + shopDateTime_() + ' =========\n'];
  out.push(smokeTestEmailSafety());
  out.push('');
  out.push(smokeTestCandidateJourney());
  out.push('');
  out.push(smokeTestOtterTranscript());
  out.push('\n========= SMOKE TEST RUN COMPLETE =========');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SAFETY — TEST mode rerouting + recipient mismatch detection
// ─────────────────────────────────────────────────────────────────────────────
function smokeTestEmailSafety() {
  var out = ['[SMOKE:EMAIL_SAFETY] starting…'];
  var sendBefore = CFG.get('SEND_ENABLED');
  CFG.set('SEND_ENABLED', 'FALSE');
  try {
    var sh = getSheet_(SHEETS.EMAIL_QUEUE);
    var rowsBefore = sh.getLastRow();
    var qid = queueEmail_({
      to: 'fake_real_candidate@example.com',
      subject: '[SMOKE] safety check — should never send',
      body: 'If you receive this in production, something is broken.',
      candidateId: 'FES-SMOKE-EMAIL',
      templateKey: '__smoke__',
      reason: 'smoke email safety',
      sendAt: new Date(Date.now() + 24 * 3600 * 1000)
    });
    var hits = findRowsByColumnValue_(sh, 'Queue ID', qid);
    var row = hits[0].data;
    var expected = isTestMode_() ? CFG.get('TEST_RECIPIENT_EMAIL') : 'fake_real_candidate@example.com';
    if (String(row['To (Actual)']).toLowerCase() === String(expected).toLowerCase())
      out.push('  ✓ TEST-mode rerouting holds — To (Actual) = ' + row['To (Actual)']);
    else
      out.push('  ✗ TEST-mode reroute failure — got ' + row['To (Actual)'] + ' expected ' + expected);
    cancelQueuedEmail_(qid, 'smoke cleanup');
    out.push('  ✓ cleanup — row cancelled (Q=' + qid + ')');
  } catch (e) {
    out.push('  ✗ threw: ' + e.message);
  } finally {
    CFG.set('SEND_ENABLED', sendBefore);
  }
  out.push('[SMOKE:EMAIL_SAFETY] done');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDIDATE JOURNEY — intake → score → dropdown decision dispatch
// (Skips real Gemini call — uses an injected fake AI result via direct status set)
// ─────────────────────────────────────────────────────────────────────────────
function smokeTestCandidateJourney() {
  var out = ['[SMOKE:JOURNEY] starting…'];
  var sendBefore = CFG.get('SEND_ENABLED');
  var gradeBefore = CFG.get('AI_GRADING_ENABLED');
  CFG.set('SEND_ENABLED', 'FALSE');
  CFG.set('AI_GRADING_ENABLED', 'FALSE');

  var ps = getSheetOrNull_(SHEETS.RAW_PRESCREEN);
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
  if (!ps) { out.push('  ✗ Pre-Screen tab missing'); CFG.set('SEND_ENABLED', sendBefore); CFG.set('AI_GRADING_ENABLED', gradeBefore); return out.join('\n'); }

  var headers = getHeaderRow_(ps);
  var email = 'smoke_journey_' + Date.now() + '@example.com';
  var role = 'Technician';

  var psRow = headers.map(function (h) {
    var lc = String(h || '').toLowerCase();
    if (lc.indexOf('timestamp') !== -1) return new Date();
    if (lc === 'full name') return 'Smoke Journey';
    if (lc.indexOf('email') !== -1) return email;
    if (lc.indexOf('phone') !== -1) return '7025550000';
    if (lc.indexOf('how did you hear') !== -1) return 'Smoke';
    if (lc.indexOf('select the role') !== -1) return role;
    return '';
  });
  ps.appendRow(psRow);
  var psRowNum = ps.getLastRow();
  out.push('  ✓ Pre-Screen row appended at ' + psRowNum);

  var cid = candidateIdFromEmail_(email, role);

  try {
    _processPreScreenRow_(psRowNum, false);
    out.push('  ✓ _processPreScreenRow_ ran');
  } catch (e) {
    out.push('  ✗ _processPreScreenRow_ threw: ' + e.message);
  }

  var acHits = findRowsByColumnValue_(ac, 'Candidate ID', cid);
  out.push('  ' + (acHits.length === 1 ? '✓' : '✗') + ' All Candidates row created (' + acHits.length + ' hit)');

  // Inject into Interview Pipeline manually so dropdown dispatch has a row
  appendRowByHeader_(ip, {
    'Candidate ID': cid,
    'Full Name': 'Smoke Journey',
    'First Name': 'Smoke',
    'Last Name': 'Journey',
    'Email': email,
    'Role': role,
    'Status': STATUS.MANUAL_REVIEW
  });
  out.push('  ✓ Interview Pipeline row injected');

  // Test a Reject dispatch
  try {
    var result = manuallyDispatchDecision(cid, CFG.get('DECISION_REJECT'));
    out.push('  ✓ manuallyDispatchDecision(REJECT) → ' + JSON.stringify(result));
  } catch (e) { out.push('  ✗ dispatch threw: ' + e.message); }

  // Cleanup
  try { ps.deleteRow(psRowNum); out.push('  ✓ deleted Pre-Screen test row'); }
  catch (e) { out.push('  ⚠ delete Pre-Screen failed: ' + e.message); }

  var ach = findRowsByColumnValue_(ac, 'Candidate ID', cid);
  ach.reverse().forEach(function (h) {
    try { ac.deleteRow(h.rowNum); } catch (_) {}
  });
  out.push('  ✓ deleted ' + ach.length + ' All Candidates test row(s)');

  var iph = findRowsByColumnValue_(ip, 'Candidate ID', cid);
  iph.reverse().forEach(function (h) {
    try { ip.deleteRow(h.rowNum); } catch (_) {}
  });
  out.push('  ✓ deleted ' + iph.length + ' Interview Pipeline test row(s)');

  // Cancel any queued email rows for this test candidate
  var cancelled = cancelQueuedEmailsForCandidate_(cid);
  out.push('  ✓ cancelled ' + cancelled + ' queued email(s)');

  CFG.set('SEND_ENABLED', sendBefore);
  CFG.set('AI_GRADING_ENABLED', gradeBefore);
  out.push('  ─ restored SEND_ENABLED=' + sendBefore + ', AI_GRADING_ENABLED=' + gradeBefore);
  out.push('[SMOKE:JOURNEY] done');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// OTTER — synthetic intake row → UNMATCHED outcome
// ─────────────────────────────────────────────────────────────────────────────
function smokeTestOtterTranscript() {
  return OTTER_selfTest();
}
