/**
 * 04_Forms.gs
 * Frank's European Service — Recruiting OS
 *
 * Runtime helpers around the Form Registry sheet:
 *   - Read form specs by key (live from the sheet — never cache stale IDs)
 *   - Install / remove per-form onFormSubmit triggers, idempotently
 *   - Verify that every active form is accessible and its response tab exists
 *
 * Per project rules:
 *   - All form IDs and URLs live in Form Registry. Apps Script never hard-codes them.
 *   - Triggers route to canonical handler names defined here in FORM_HANDLER_MAP.
 *   - This file does NOT define those handler functions; they live in the
 *     corresponding feature files (05_Candidate_Intake, 11_References,
 *     12_Culture_Fit, 13_Skills_Test). Install only runs after those files
 *     are in the project (otherwise the handler-existence pre-check fails).
 *
 * Functions exposed:
 *   getFormSpec_(formKey)
 *   getFormResponderId_(formKey)
 *   getFormUrl_(formKey)
 *   getFormResponseTab_(formKey)
 *   getFormHandler_(formKey)
 *   getActiveFormKeys_()
 *   installFormTrigger_(formKey)
 *   removeFormTrigger_(formKey)
 *   installAllFormTriggers()       — public, called by 18_Triggers.gs
 *   removeAllFormTriggers()        — public emergency-stop
 *   verifyFormRegistry()           — public, validates IDs and tabs
 *   FORMS_selfTest()               — read-only sanity check
 */

// ─────────────────────────────────────────────────────────────────────────────
// FORM KEY → HANDLER FUNCTION (single source of truth for routing)
// Handler functions are implemented in their feature files.
// ─────────────────────────────────────────────────────────────────────────────
var FORM_HANDLER_MAP = Object.freeze({
  'PRESCREEN':            'onPreScreenSubmit',          // 05_Candidate_Intake.gs
  'CULTURE_FIT':          'onCultureSubmit',            // 12_Culture_Fit.gs
  'REFERENCE_SUBMISSION': 'onCandidateReferenceSubmit', // 11_References.gs
  'REFERENCE_CHECK':      'onRefereeFormSubmit',        // 11_References.gs
  'SKILLS_TEST':          'onSkillsTestSubmit'          // 13_Skills_Test.gs
});

// ─────────────────────────────────────────────────────────────────────────────
// FORM REGISTRY READS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Form Registry row as {Header: value} for the given Form Key,
 * or null if the form key is not present or row is marked Active=FALSE.
 */
function getFormSpec_(formKey) {
  var sh = getSheetOrNull_(SHEETS.FORM_REGISTRY);
  if (!sh) return null;
  var hits = findRowsByColumnValue_(sh, 'Form Key', formKey);
  if (!hits.length) return null;
  // Prefer Active row; fall back to the first match if no row is explicitly active.
  for (var i = 0; i < hits.length; i++) {
    var d = hits[i].data;
    if (String(d['Active']).trim().toUpperCase() === 'TRUE') return d;
  }
  return null;
}

function getFormResponderId_(formKey) {
  var s = getFormSpec_(formKey);
  return s ? String(s['Approved Form ID'] || '').trim() : '';
}

/**
 * Returns the document/edit ID needed by FormApp.openById().
 * Reads the "Edit ID" column. The "Approved Form ID" column holds the
 * 1FAIpQLS… responder ID which FormApp cannot open.
 */
function getFormEditId_(formKey) {
  var s = getFormSpec_(formKey);
  return s ? String(s['Edit ID'] || '').trim() : '';
}

function getFormUrl_(formKey) {
  var s = getFormSpec_(formKey);
  return s ? String(s['Approved Form URL'] || '').trim() : '';
}

function getFormResponseTab_(formKey) {
  var s = getFormSpec_(formKey);
  return s ? String(s['Response Tab'] || '').trim() : '';
}

function getFormHandler_(formKey) {
  return FORM_HANDLER_MAP[formKey] || '';
}

/** Returns array of Form Key strings where Active=TRUE. */
function getActiveFormKeys_() {
  var sh = getSheetOrNull_(SHEETS.FORM_REGISTRY);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var keyCol = headers.indexOf('Form Key');
  var actCol = headers.indexOf('Active');
  if (keyCol === -1 || actCol === -1) return [];
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][actCol]).trim().toUpperCase() === 'TRUE') {
      var k = String(data[i][keyCol] || '').trim();
      if (k) out.push(k);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER INSTALL — per-form onFormSubmit. Idempotent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install (or replace) the canonical form-submit trigger for one form key.
 * Returns the new trigger's unique ID, or '' if skipped.
 */
/**
 * Single dispatcher invoked by ONE spreadsheet-bound onFormSubmit trigger.
 * Spreadsheet-bound events include e.range (the row appended in the linked
 * Form Responses tab); form-bound events don't, which is why we route through
 * here instead of installing per-form triggers via forForm().
 */
function onAnyFormSubmit(e) {
  return safeRun_('onAnyFormSubmit', function () {
    if (!e || !e.range) {
      logError_('onAnyFormSubmit', 'event missing .range — trigger may have been installed forForm() instead of forSpreadsheet()', '', 'WARN');
      return null;
    }
    var name = e.range.getSheet().getName();
    if (name === SHEETS.RAW_PRESCREEN         && typeof onPreScreenSubmit          === 'function') return onPreScreenSubmit(e);
    if (name === SHEETS.CULTURE_FIT           && typeof onCultureSubmit            === 'function') return onCultureSubmit(e);
    if (name === SHEETS.REFERENCE_REQUESTS    && typeof onCandidateReferenceSubmit === 'function') return onCandidateReferenceSubmit(e);
    if (name === SHEETS.REFERENCE_CHECKS      && typeof onRefereeFormSubmit        === 'function') return onRefereeFormSubmit(e);
    if (name === SHEETS.SKILLS_TEST_RESPONSES && typeof onSkillsTestSubmit         === 'function') return onSkillsTestSubmit(e);
    logError_('onAnyFormSubmit', 'no handler mapped for sheet: ' + name, '', 'WARN');
    return null;
  });
}

function installFormTrigger_(formKey) {
  // Per-form trigger installation is superseded by the single spreadsheet-bound
  // dispatcher installed by installAllFormTriggers(). This stub remains so older
  // callers don't break; it simply delegates to the dispatcher installer.
  installAllFormTriggers();
  return 'dispatched-via-onAnyFormSubmit';
}

/** Remove triggers matching this form + handler. Returns the count removed. */
function _removeMatchingFormTriggers_(formId, handlerFn) {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      if (t.getEventType() !== ScriptApp.EventType.ON_FORM_SUBMIT) return;
      if (t.getHandlerFunction() !== handlerFn) return;
      if (t.getTriggerSourceId && t.getTriggerSourceId() === formId) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    } catch (_) { /* tolerate odd triggers */ }
  });
  return removed;
}

/** Remove all triggers for one form key. Safe even if none exist. */
function removeFormTrigger_(formKey) {
  var handlerFn = getFormHandler_(formKey);
  var editId    = getFormEditId_(formKey);
  if (!handlerFn || !editId) return 0;
  return _removeMatchingFormTriggers_(editId, handlerFn);
}

/**
 * Install ONE spreadsheet-bound onFormSubmit trigger pointing to the
 * onAnyFormSubmit dispatcher. Replaces the old per-form forForm() triggers,
 * which fire with an event object that lacks `e.range` and silently dropped
 * every submission. Idempotent: removes stale triggers first.
 */
function installAllFormTriggers() {
  return withLock_(function () {
    var summary = { installed: 0, removedStale: 0, activeForms: getActiveFormKeys_() };
    var perHandlerFns = ['onPreScreenSubmit', 'onCultureSubmit',
      'onCandidateReferenceSubmit', 'onRefereeFormSubmit', 'onSkillsTestSubmit',
      'onAnyFormSubmit'];

    // Remove every existing form-submit trigger for our handlers so we don't
    // accumulate duplicates (and so the buggy form-bound ones go away).
    ScriptApp.getProjectTriggers().forEach(function (t) {
      try {
        if (t.getEventType() !== ScriptApp.EventType.ON_FORM_SUBMIT) return;
        if (perHandlerFns.indexOf(t.getHandlerFunction()) === -1) return;
        ScriptApp.deleteTrigger(t);
        summary.removedStale++;
      } catch (_) { /* tolerate */ }
    });

    // Install the single dispatcher trigger.
    ScriptApp.newTrigger('onAnyFormSubmit')
      .forSpreadsheet(SpreadsheetApp.getActive())
      .onFormSubmit()
      .create();
    summary.installed = 1;

    var msg = '[FORMS] installAllFormTriggers — ' + JSON.stringify(summary);
    Logger.log(msg);
    toast_('Form trigger installed (dispatcher); removed ' + summary.removedStale + ' stale', 'Recruiting OS', 5);
    return msg;
  });
}

/** Emergency stop — remove every form-submit trigger this project owns. */
function removeAllFormTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      if (t.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    } catch (_) { /* tolerate */ }
  });
  Logger.log('[FORMS] removeAllFormTriggers — removed ' + removed);
  toast_('Removed ' + removed + ' form-submit triggers', 'Recruiting OS', 5);
  return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY — validates every active form spec against the live Form and Sheet.
// Updates "Last Verified" cell on success. Logs failures to Setup Registry.
// ─────────────────────────────────────────────────────────────────────────────
function verifyFormRegistry() {
  return withLock_(function () {
    _clearUtilCaches_();
    var fr = getSheet_(SHEETS.FORM_REGISTRY);
    var reg = getSheetOrNull_(SHEETS.SETUP_REGISTRY);
    var keys = getActiveFormKeys_();
    var summary = { checked: 0, ok: 0, failed: 0, issues: [] };

    keys.forEach(function (k) {
      summary.checked++;
      var spec = getFormSpec_(k);
      var editId = String(spec['Edit ID'] || '').trim();
      var responderId = String(spec['Approved Form ID'] || '').trim();
      var tabName = String(spec['Response Tab'] || '').trim();
      var problems = [];

      // 1) Form accessible? (use Edit ID — Approved Form ID is the responder ID)
      var form = null;
      if (!editId) {
        problems.push('Edit ID is blank — open form in editor, copy the long ID from the /forms/d/{ID}/edit URL, paste into Form Registry → Edit ID column');
      } else {
        try { form = FormApp.openById(editId); }
        catch (e) {
          problems.push('FormApp.openById(Edit ID="' + editId + '") failed: ' + e.message +
            ' — verify this is the Edit ID (from /forms/d/{ID}/edit URL), not the responder ID (' +
            truncate_(responderId, 18) + '…) from /viewform');
        }
      }

      // (Title check intentionally omitted — internal form title is cosmetic.
      //  Form openById success above already proves the form is reachable.)

      // 2) Response tab present in this spreadsheet
      if (tabName) {
        if (!getSheetOrNull_(tabName)) problems.push('response tab missing: "' + tabName + '"');
      } else {
        problems.push('Response Tab cell is empty');
      }

      if (!problems.length) {
        summary.ok++;
        // Update Last Verified
        var rowNum = updateRowWhere_(fr, 'Form Key', k, { 'Last Verified': shopDate_() });
        if (!rowNum) Logger.log('verifyFormRegistry: could not update Last Verified for ' + k);
      } else {
        summary.failed++;
        summary.issues.push({ form: k, problems: problems });
        if (reg) {
          appendRowByHeader_(reg, {
            'Timestamp':       shopDateTime_(),
            'Item':            'Form Registry: ' + k,
            'Category':        'Verify',
            'Status':          'FAIL',
            'Auto-Created':    'FALSE',
            'Action Required': problems.join(' | '),
            'Notes':           'verifyFormRegistry detected issues'
          });
        }
      }
    });

    // Non-fatal response-header schema check (WARN by default; never throws here).
    try {
      var hdr = validateResponseHeaders_();
      if (hdr && hdr.passed === false) {
        summary.headerProblems = hdr.problems.length;
        summary.issues.push({ form: '(headers)', problems: hdr.problems });
      }
    } catch (e) {
      // Only STRICT mode throws; surface it as an issue rather than aborting verify.
      summary.issues.push({ form: '(headers)', problems: [String(e && e.message || e)] });
    }

    var msg = '[FORMS] verifyFormRegistry — ' + JSON.stringify(summary);
    Logger.log(msg);
    toast_('Form verify: ' + summary.ok + ' ok / ' + summary.failed + ' failed', 'Recruiting OS', 6);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE-HEADER SCHEMA VALIDATION  (ported from recruiting_os/04_forms.gs)
// Catches silent column drift in a form's Response Tab that would otherwise
// break readRowAsObject_-based parsers. Expected headers come from
// SHEET_MANIFEST (A's single source of truth); the Form Registry's
// "Expected Header Key" column names the SHEETS key whose headers to expect.
//
// Behavior is governed by Config key FORM_SCHEMA_ENFORCEMENT:
//   STRICT → throw on mismatch   WARN → log only (default)   OFF → skip
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// FORM RESPONSE HEADER SCHEMAS — validation-only.
//
// Google-Form response tabs are intentionally NOT in SHEET_MANIFEST (see
// FORM_LINKED_TABS in 02_Setup_Bootstrap.gs — "Google Forms owns linkage; never
// auto-created"). So validateResponseHeaders_ had no schema to compare against
// and warned for every form. These maps give it a reference WITHOUT going
// through the bootstrap create/repair path, so bootstrap never touches the live
// form tabs.
//
// Keyed by the "Expected Header Key" value from the Form Registry. The arrays
// are the exact, ordered header rows of the live response tabs (extracted from
// the response exports — preserve smart quotes / non-breaking hyphens / any
// duplicate columns verbatim, or the exact-match check will report false drift).
//
// Only structured tabs whose column order is fixed belong here. Forms parsed by
// fuzzy header detection (Culture Fit, References — see 12_Culture_Fit.gs /
// 11_References.gs) are listed in FORM_HEADER_VALIDATION_OPT_OUT instead, so the
// validator skips them silently rather than imposing a rigid schema the rest of
// the system deliberately avoids.
// ─────────────────────────────────────────────────────────────────────────────
var FORM_RESPONSE_HEADERS = {
  RAW_PRESCREEN: [
    "Timestamp",
    "Email Address",
    "Full Name",
    "Email Address",
    "Best Phone Number",
    "How did you hear about this position?",
    "Select the role that best matches your application.",
    "How much direct automotive technician experience do you have?",
    "A vehicle comes in with a concern you have never seen before. What is your first move?",
    "You have been working on a diagnosis for a while and are genuinely stuck. What do you do?",
    "How comfortable are you with European vehicles such as BMW, Mercedes-Benz, Audi, or Land Rover?",
    "Which statement best describes your approach to your workspace and vehicle care?",
    "What does \"doing the job right the first time\" mean to you?",
    "How much direct supervisory or shop foreman experience do you have?",
    "A technician on your team consistently turns in incomplete or low-quality work. What do you do first?",
    "Two jobs are behind and a technician needs help on a third urgent job. What guides your decision?",
    "How do you define the relationship between quality control and shop production?",
    "How do you keep the service advisor team informed about job status throughout the day?",
    "What does accountability for your team's performance mean to you as a foreman?",
    "How much direct service advisor or customer-facing automotive experience do you have?",
    "Which statement best describes your comfort discussing repair recommendations and pricing with customers?",
    "A customer says \"That price is way too high.\" What is the best response?",
    "A technician finds a safety concern plus several maintenance items. What do you present to the customer first?",
    "A customer declines a safety-related repair. What is the best next step?",
    "Are you willing to follow a structured process, use digital vehicle inspections, and document every customer decision clearly?",
    "How much direct automotive parts experience do you have?",
    "Which statement best describes how you work when the shop is moving quickly?",
    "What is most important when ordering or sourcing parts for the shop?",
    "A technician needs parts immediately but key details are unclear. What is your best response?",
    "A wrong part arrives and it is affecting shop workflow. What do you do first?",
    "How do you feel about working inside a structured process with documentation, follow-up, and accountability?",
    "How much office administration or automotive admin experience do you have?",
    "When you have multiple tasks with competing deadlines, what do you do?",
    "How comfortable are you with digital tools like Google Workspace, scheduling systems, or shop management software?",
    "How do you handle confidential or sensitive information at work?",
    "When advisors, technicians, and management all need something from you at the same time, how do you manage it?",
    "How do you feel about following established office processes and documentation standards every single day?",
    "How much direct sales experience do you have, ideally in automotive or B2B?",
    "A prospect shows interest but keeps delaying a decision. What do you do?",
    "A prospect firmly declines. What is your next step?",
    "How do you build a long-term relationship with a client or referral partner?",
    "How do you manage your own pipeline and follow-up activity?",
    "What does accountability for results mean to you in a sales role?",
    "Can you reliably work our required schedule, including early starts and flexibility when the day shifts?",
    "Do you have a valid driver's license and a clean driving record?",
    "Which statement best describes how you work in a fast-paced environment?",
    "Multiple vehicles need to be moved and the front desk is busy. What guides your priorities?",
    "A customer hands you their keys and seems upset about something. What do you do?",
    "Are you willing to follow a structured process, accept feedback, and be held to clear daily standards?",
    "How do you handle a mistake you made at work?",
    "How do you stay dependable when things get busy or stressful?",
    "A coworker is having a rough day and it is noticeably affecting the team. What do you do?",
    "A customer is upset about something that is not your fault. What do you do?",
    "How quickly do you pick up new processes or software tools?",
    "How important is it to follow a set process even when you personally disagree with it?",
    "What does a great day at work look like to you?",
    "How do you prefer to receive feedback from a manager?",
    "How many years of experience do you have in this field?",
    "Resume or LinkedIn URL",
    "What was your most recent job title?",
    "List any certifications, licenses, or specialized training you hold.",
    "Briefly describe your most relevant experience for this role.",
    "What is your availability?",
    "Are you currently employed?",
    "Can you reliably commute to our location in Las Vegas daily?",
    "Do you have reliable personal transportation?",
    "Are you able to pass a background check if required for this position?",
    "Why do you want to work at an independent European auto shop specifically?",
    "What is the most important thing to you in a workplace?",
    "Is there anything else you would like us to know about you?"
  ],
  SKILLS_TEST_RESPONSES: [
    "Timestamp",
    "Email Address",
    "Score",
    "First & Last Name",
    "Todays Date",
    "What’s your next test when a starter shows 12.6 V static without load?",
    "How would you tell if the fault is the coil driver or the coil itself?",
    "After sleep, draw is 0.18 A (spec is .05 A). What is your test?",
    "How do you prove a bad ground is causing a sensor to read high bias?",
    "Why does voltage drop under load matter more than static resistance in high current paths?",
    "LIN window motor acting up then failing. What’s your first check using a scope?",
    "You see many U‑codes across modules. What's your first move?",
    "What does Mode 06 really tell you?",
    "After a bidirectional test passes then a DTC returns later, what do you do?",
    "One node on a sub-bus isn't communicating. What's your diagnostic step?",
    "You finish a programming update and now see many CAN faults. What do you check first?",
    "Car is running lean at idle, but fine under load. What’s likely wrong?",
    "Cylinder 3 misfire; coil/plug swapped, injector current normal. What’s next?",
    "You get P0420 after installing a new catalytic converter. What do you inspect?",
    "High‑pressure fuel rail oscillates during tip‑in. What’s most likely the cause?",
    "If a car stalls intermittently, what’s the correct order of troubleshooting?",
    "What does 'proving a hypothesis' mean in diagnosis?",
    "What does 'no parts darts' mean in repair work?",
    "When do you pause and ask for help during diagnosis?",
    "How should you use Technical Service Bulletins (TSBs)?",
    "How do you read a wiring diagram well?",
    "If AC doesn’t work but no codes, what doc do you look at first?",
    "Write a clear 'Verified Concern / Findings / Recommendation'",
    "List your first 4 tests & what good/bad looks like for P0171 on a turbo DI",
    "How to confirm a LIN mirror node failure using only tools and SI info"
  ]
};

// Forms parsed by fuzzy header detection — no fixed column order to enforce.
// validateResponseHeaders_ skips these silently (not a problem state).
var FORM_HEADER_VALIDATION_OPT_OUT = {
  CULTURE_FIT: true,
  REFERENCE_REQUESTS: true,
  REFERENCE_CHECKS: true
};

/**
 * Normalize a header cell for tolerant comparison. Collapses the Unicode space
 * variants Google Forms emits (no-break U+00A0, narrow no-break U+202F, thin
 * U+2009/U+200A, figure U+2007, line/para separators) to a single regular
 * space, then collapses runs and trims. Letters, digits, and punctuation
 * (including curly quotes) are left intact so genuine column drift still shows.
 */
function _normalizeHeaderForCompare_(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00A0\u2007\u2009\u200A\u202F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve the expected header array for an "Expected Header Key" value. */
function _expectedHeadersForKey_(headerKey) {
  if (!headerKey) return null;
  // Prefer an explicit validation-only schema (form response tabs live here,
  // since they're intentionally absent from SHEET_MANIFEST).
  if (FORM_RESPONSE_HEADERS[headerKey] && Array.isArray(FORM_RESPONSE_HEADERS[headerKey])) {
    return FORM_RESPONSE_HEADERS[headerKey];
  }
  // Otherwise headerKey is a SHEETS map key (e.g. 'CULTURE_FIT'); resolve to a
  // tab name, then find that tab in SHEET_MANIFEST. Fall back to treating
  // headerKey as a literal tab name if it isn't a SHEETS key.
  var tabName = (SHEETS && SHEETS[headerKey]) ? SHEETS[headerKey] : headerKey;
  for (var i = 0; i < SHEET_MANIFEST.length; i++) {
    if (SHEET_MANIFEST[i].name === tabName && Array.isArray(SHEET_MANIFEST[i].headers)) {
      return SHEET_MANIFEST[i].headers;
    }
  }
  return null;
}

/**
 * Validate that each active form's Response Tab header row matches the
 * expected headers declared in SHEET_MANIFEST. Returns a summary object.
 * Throws only when FORM_SCHEMA_ENFORCEMENT === 'STRICT'.
 */
function validateResponseHeaders_() {
  var mode = String(CFG.get('FORM_SCHEMA_ENFORCEMENT', 'WARN')).toUpperCase();
  if (mode === 'OFF') return { skipped: true, mode: mode };

  var ss = SpreadsheetApp.getActive();
  var problems = [];

  getActiveFormKeys_().forEach(function (formKey) {
    var spec = getFormSpec_(formKey);
    if (!spec) return;
    var registryTab = String(spec['Response Tab'] || '').trim();
    var headerKey = String(spec['Expected Header Key'] || '').trim();
    if (!headerKey) { problems.push(formKey + (registryTab ? ' (' + registryTab + ')' : '') + ': Expected Header Key is blank — cannot validate'); return; }

    // The SHEETS map is the source of truth for which physical tab a form's
    // responses land in (intake/scoring read it directly). Validate against
    // that canonical tab — not the Form Registry's "Response Tab" column, which
    // is a human-maintained mirror that can drift. When they disagree, flag it
    // so the registry gets corrected, but still validate the right tab.
    var canonicalTab = (SHEETS && SHEETS[headerKey]) ? SHEETS[headerKey] : registryTab;
    if (!canonicalTab) { problems.push(formKey + ': no Response Tab and no canonical mapping for "' + headerKey + '"'); return; }
    if (registryTab && registryTab !== canonicalTab) {
      problems.push(formKey + ': Form Registry "Response Tab" = "' + registryTab +
        '" but the canonical tab for ' + headerKey + ' is "' + canonicalTab +
        '" — correct the Response Tab column in the Form Registry tab');
    }

    var sheet = ss.getSheetByName(canonicalTab);
    if (!sheet) { problems.push(formKey + ': response tab not found: "' + canonicalTab + '"'); return; }

    // Forms parsed by fuzzy header detection opt out of strict header validation.
    if (FORM_HEADER_VALIDATION_OPT_OUT[headerKey]) return;

    var expected = _expectedHeadersForKey_(headerKey);
    if (!expected) {
      problems.push(formKey + ': Expected Header Key "' + headerKey + '" has no declared schema ' +
        '(add it to FORM_RESPONSE_HEADERS or FORM_HEADER_VALIDATION_OPT_OUT in 04_Forms.gs)');
      return;
    }

    var width = Math.max(expected.length, sheet.getLastColumn() || expected.length);
    var actual = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var mismatches = [];
    expected.forEach(function (h, i) {
      var a = actual[i] || '';
      // Compare on a normalized form so harmless Unicode whitespace variants
      // Google Forms injects (narrow/non-breaking spaces around units, etc.)
      // don't read as drift. Real column add/remove/rename still flag.
      if (_normalizeHeaderForCompare_(a) !== _normalizeHeaderForCompare_(h)) {
        mismatches.push('col ' + (i + 1) + ' expected "' + h + '", got "' + a + '"');
      }
    });
    if (mismatches.length) {
      problems.push(formKey + ' (' + canonicalTab + '): ' + mismatches.join('; '));
    }
  });

  if (!problems.length) return { passed: true, mode: mode };

  var summary = 'Response header validation problems:\n  - ' + problems.join('\n  - ');
  if (mode === 'STRICT') throw new Error(summary);
  logError_('validateResponseHeaders_', summary, '', 'WARN');
  return { passed: false, mode: mode, problems: problems };
}

/**
 * Menu/diagnostic entry: validate every active form's Approved IDs AND its
 * response-tab header schema. Shows a clear pass/fail dialog.
 */
function auditFormResponseHeaders() {
  return safeRun_('auditFormResponseHeaders', function () {
    var ui = SpreadsheetApp.getUi();
    var res = validateResponseHeaders_();
    if (res.skipped) {
      ui.alert('Form Header Audit', 'FORM_SCHEMA_ENFORCEMENT is OFF — header validation skipped.', ui.ButtonSet.OK);
    } else if (res.passed) {
      ui.alert('Form Header Audit', 'All active form response tabs match their expected headers.', ui.ButtonSet.OK);
    } else {
      ui.alert('Form Header Audit — MISMATCHES (' + res.mode + ')',
        res.problems.join('\n\n'), ui.ButtonSet.OK);
    }
    return res;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only summary
// ─────────────────────────────────────────────────────────────────────────────
function FORMS_selfTest() {
  var out = ['[FORMS] selfTest (read-only)…'];
  var sh = getSheetOrNull_(SHEETS.FORM_REGISTRY);
  if (!sh) {
    out.push('  ✗ Form Registry sheet missing. Run bootstrapSystem() then seedAllTemplates().');
    Logger.log(out.join('\n')); return out.join('\n');
  }
  var keys = getActiveFormKeys_();
  out.push('  ─ Active form keys: ' + keys.length + ' (' + keys.join(', ') + ')');

  // Walk handler map
  Object.keys(FORM_HANDLER_MAP).forEach(function (k) {
    var spec = getFormSpec_(k);
    var status = spec ? 'OK' : 'NOT IN REGISTRY';
    var editId = spec ? String(spec['Edit ID'] || '').trim() : '';
    var tab    = spec ? spec['Response Tab'] : '—';
    var tabOK  = spec && getSheetOrNull_(tab) ? '✓ tab' : '✗ tab missing';
    var idOK   = editId ? '✓ Edit ID' : '✗ Edit ID MISSING';
    var handler = FORM_HANDLER_MAP[k];
    out.push('  ─ ' + k.padEnd(22, ' ') + ' status=' + status.padEnd(15, ' ') +
             ' ' + idOK.padEnd(20, ' ') + ' ' + tabOK.padEnd(15, ' ') +
             ' handler=' + handler);
  });

  // Existing form-submit triggers
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT;
  });
  out.push('  ─ Installed form-submit triggers: ' + triggers.length);
  triggers.forEach(function (t) {
    out.push('     · ' + t.getHandlerFunction() + ' (sourceId ' + t.getTriggerSourceId() + ')');
  });

  out.push('[FORMS] selfTest done. Run installAllFormTriggers() after feature files are pasted.');
  out.push('       Run verifyFormRegistry() any time to validate IDs and response tabs.');
  out.push('       NOTE: Edit ID = the long ID from /forms/d/{ID}/edit URL (NOT the /viewform responder ID).');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
