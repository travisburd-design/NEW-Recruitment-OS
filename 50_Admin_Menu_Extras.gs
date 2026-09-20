/**
 * ============================================================================
 * 50_Admin_Menu_Extras.gs
 * Frank's European Service — Recruiting OS
 * ============================================================================
 * PURPOSE  Wrappers that make existing-but-unreachable admin tools usable from
 *          the menu, plus a prompt-driven way to set the Gemini API key without
 *          opening Project Settings.
 *
 * OWNER    General Manager (Travis Burd)
 *
 * WHY THIS EXISTS
 *   The 9/8/26 audit found working functions with no menu item and no trigger.
 *   Two mattered: AUTOADV_installTrigger (the auto-advance feature was never
 *   switched on because V2_GO was never run by hand) and setSecret_ (the only
 *   way to set the Gemini key was Project Settings -> Script Properties).
 *
 * DEPENDENCIES  00_Config (SECRETS, getSecret_/setSecret_/hasSecret_),
 *               46_Auto_Advance, 44_Grading_V2, 45_Grading_Runner, 17_Errors_Logs
 *
 * SAFETY   Nothing here sends candidate email. ADMIN_previewAutoAdvance is a
 *          dry run. ADMIN_installAutoAdvanceTrigger is idempotent.
 * ============================================================================
 */

/**
 * Prompts for the Gemini API key and stores it in Script Properties.
 * Replaces the manual Project Settings -> Script Properties step.
 */
function ADMIN_setGeminiKey() {
  var ui = SpreadsheetApp.getUi();
  var already = hasSecret_(SECRETS.GEMINI_API_KEY);

  var res = ui.prompt(
    'Gemini API Key',
    (already
      ? 'A key is already set. Entering a new one replaces it.\n\n'
      : 'No key is currently set. AI grading cannot run without it.\n\n') +
    'Paste the key and click OK:',
    ui.ButtonSet.OK_CANCEL);

  if (res.getSelectedButton() !== ui.Button.OK) return 'Cancelled.';

  var key = String(res.getResponseText() || '').trim();
  if (!key) {
    ui.alert('Nothing entered — the key was not changed.');
    return 'Cancelled.';
  }

  setSecret_(SECRETS.GEMINI_API_KEY, key);
  logEvent_('GEMINI_KEY_SET', '', { replaced: already });
  ui.alert('Gemini API key saved.\n\nRun "Ping Gemini" to confirm it works.');
  return 'Saved.';
}

/** Reports whether the key is set, without revealing it. */
function ADMIN_checkGeminiKey() {
  var set = hasSecret_(SECRETS.GEMINI_API_KEY);
  SpreadsheetApp.getUi().alert(
    'Gemini API key: ' + (set ? 'SET' : 'NOT SET — AI grading cannot run.'));
  return set;
}

/**
 * Dry run. Shows which candidates WOULD auto-advance. Sends nothing,
 * changes nothing. Run this before installing the trigger.
 */
function ADMIN_previewAutoAdvance() {
  return safeRun_('ADMIN_previewAutoAdvance', function () {
    var out = AUTOADV_previewNow();
    SpreadsheetApp.getUi().alert('Auto-Advance — dry run\n\n' + out);
    return out;
  });
}

/**
 * Installs the 15-minute AUTOADV_run trigger. Safe to run more than once.
 * The audit found this trigger was never installed, so the approved
 * auto-advance-to-live-interview feature has never fired.
 */
function ADMIN_installAutoAdvanceTrigger() {
  return safeRun_('ADMIN_installAutoAdvanceTrigger', function () {
    var msg = AUTOADV_installTrigger();
    logEvent_('AUTOADV_TRIGGER_INSTALLED', '', { via: 'menu' });
    SpreadsheetApp.getUi().alert('Auto-Advance trigger\n\n' + String(msg));
    return msg;
  });
}

/** Grading calibration report — how scores are distributing. Read-only. */
function ADMIN_gradingCalibration() {
  return safeRun_('ADMIN_gradingCalibration', function () {
    return GRADE_calibrationReport();
  });
}

/** Re-scores every candidate that currently has no score. */
function ADMIN_rescoreUnscored() {
  return safeRun_('ADMIN_rescoreUnscored', function () {
    return RESCORE_unscored();
  });
}/**
 * Cancels a pending auto-advance during the hold window
 * (AUTO_ADVANCE_HOLD_MINUTES, currently 60). Select the candidate's row
 * on Interview Pipeline first if the function expects a selection.
 */
function ADMIN_cancelAutoAdvance() {
  return safeRun_('ADMIN_cancelAutoAdvance', function () {
    var out = AUTOADV_cancel();
    SpreadsheetApp.getUi().alert('Auto-Advance cancel\n\n' + String(out));
    return out;
  });
}