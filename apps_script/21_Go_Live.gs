/**
 * 21_Go_Live.gs
 * Frank's European Service — Recruiting OS
 *
 * The kill switch. goLive() flips SYSTEM_MODE from TEST to LIVE only AFTER
 * productionReadinessCheck() returns no blockers. returnToTestMode() goes
 * back to TEST at any time, no checks.
 *
 * Public functions:
 *   goLive()
 *   returnToTestMode()
 *   GO_LIVE_currentMode()
 */

function GO_LIVE_currentMode() {
  var paused = CFG.getBool('HIRING_PAUSE_MODE', false);
  var msg = '[GO_LIVE] current SYSTEM_MODE = ' + CFG.get('SYSTEM_MODE') +
            '  | SEND_ENABLED = ' + sendEnabled_() +
            '  | TEST_RECIPIENT_EMAIL = ' + CFG.get('TEST_RECIPIENT_EMAIL') +
            '  | HIRING_PAUSE_MODE = ' + (paused ? 'ON (not hiring)' : 'OFF (hiring active)');
  Logger.log(msg);
  toast_(msg, 'Recruiting OS', 8);
  return msg;
}

function goLive() {
  return withLock_(function () {
    var out = ['[GO_LIVE] goLive starting…'];

    var current = String(CFG.get('SYSTEM_MODE')).toUpperCase();
    if (current === 'LIVE') {
      out.push('  ─ Already LIVE. No change.');
      Logger.log(out.join('\n'));
      toast_('Already LIVE', 'Recruiting OS', 5);
      return out.join('\n');
    }

    // Run strict readiness check
    out.push('  ─ Running productionReadinessCheck()…');
    var report = productionReadinessCheck();
    out.push(report);

    // Look for verdict line
    var verdictLine = report.split('\n').filter(function (l) { return l.indexOf('VERDICT:') !== -1; })[0] || '';
    if (verdictLine.indexOf('PRODUCTION READY') === -1) {
      out.push('  ✗ goLive ABORTED — readiness check did not return PRODUCTION READY');
      toast_('goLive ABORTED — see Execution Log', 'Recruiting OS', 10);
      var msg = out.join('\n');
      Logger.log(msg);
      return msg;
    }

    // FLIP THE SWITCH
    CFG.set('SYSTEM_MODE', 'LIVE');
    CFG.reset(); // force re-read so isLiveMode_() returns true everywhere
    out.push('  ✓ SYSTEM_MODE set to LIVE');
    out.push('');
    out.push('  *** LIVE MODE ACTIVE *** Candidate-facing emails will now send to real addresses.');

    logEvent_('SYSTEM_GO_LIVE', '', { mode: 'LIVE', by: Session.getActiveUser().getEmail() || 'unknown' });

    // Belt-and-suspenders confirmation toast
    toast_('LIVE MODE ACTIVE — real emails will send', 'Recruiting OS', 12);

    var msg = out.join('\n');
    Logger.log(msg);
    return msg;
  });
}

function returnToTestMode() {
  return withLock_(function () {
    var was = CFG.get('SYSTEM_MODE');
    CFG.set('SYSTEM_MODE', 'TEST');
    CFG.reset();
    logEvent_('SYSTEM_RETURN_TO_TEST', '', { previousMode: was });
    var msg = '[GO_LIVE] returnToTestMode — SYSTEM_MODE was ' + was + ', now TEST';
    Logger.log(msg);
    toast_('Back in TEST mode', 'Recruiting OS', 6);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HIRING PAUSE MODE — stop all post-prescreen pipeline advancement.
//
// When ON: candidates who complete the pre-screen receive the
// "not_currently_hiring" email regardless of their score, and are
// parked with Status=IN_DRAWER so you can still see who was reviewed.
// No booking emails are sent. Toggle it back OFF to resume normal flow.
// ─────────────────────────────────────────────────────────────────────────────

function enableHiringPauseMode() {
  return withLock_(function () {
    if (CFG.getBool('HIRING_PAUSE_MODE', false)) {
      var already = '[PAUSE] Hiring Pause Mode is already ON — no change.';
      Logger.log(already);
      toast_('Pause Mode already ON', 'Recruiting OS', 5);
      return already;
    }
    CFG.set('HIRING_PAUSE_MODE', 'TRUE');
    CFG.reset();
    logEvent_('HIRING_PAUSE_ENABLED', '', { by: Session.getActiveUser().getEmail() || 'unknown' });
    var msg = '[PAUSE] Hiring Pause Mode ENABLED — new pre-screen completions will receive a ' +
              '"not currently hiring" response. Existing pipeline is unaffected. ' +
              'Run "Disable Hiring Pause Mode" to resume normal flow.';
    Logger.log(msg);
    toast_('PAUSE MODE ON — not sending booking emails', 'Recruiting OS', 10);
    return msg;
  });
}

function disableHiringPauseMode() {
  return withLock_(function () {
    if (!CFG.getBool('HIRING_PAUSE_MODE', false)) {
      var already = '[PAUSE] Hiring Pause Mode is already OFF — no change.';
      Logger.log(already);
      toast_('Pause Mode already OFF', 'Recruiting OS', 5);
      return already;
    }
    CFG.set('HIRING_PAUSE_MODE', 'FALSE');
    CFG.reset();
    logEvent_('HIRING_PAUSE_DISABLED', '', { by: Session.getActiveUser().getEmail() || 'unknown' });
    var msg = '[PAUSE] Hiring Pause Mode DISABLED — normal routing (auto-book / manual review / reject) ' +
              'is now active for new pre-screen completions.';
    Logger.log(msg);
    toast_('Pause Mode OFF — normal hiring flow resumed', 'Recruiting OS', 8);
    return msg;
  });
}
