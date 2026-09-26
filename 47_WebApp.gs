/**
 * 47_WebApp.gs
 * Frank's European Service — Recruiting OS
 *
 * HIRING CONSOLE WEB APP — the phone-friendly review + decision screen.
 *
 * Neither repo contained a doGet before this file, so there was no web app of
 * any kind: every decision required opening the workbook on a laptop and picking
 * a dropdown value in a 51-column sheet. That is the practical reason strong
 * candidates sat unreviewed.
 *
 * WHAT IT DOES
 *   • Ranked queue of every candidate awaiting a decision, best score first.
 *   • Each card shows role, score, tier, risk, the AI's strengths and concerns,
 *     hard-gate reasons, and a resume link.
 *   • Advance / Decline / Drawer buttons write straight through the SAME code
 *     path as the sheet dropdown (_dispatchPipelineDecision_), so status,
 *     Override Log, email queue and once-only ledger all behave identically.
 *   • Role and status filters; refresh without losing your place.
 *
 * DEPLOY
 *   Apps Script editor → Deploy → New deployment → type "Web app"
 *     Execute as:      Me (travis.burd@frankseuropeanservice.com)
 *     Who has access:  Anyone with a Google account
 *   Copy the /exec URL. Access is enforced in code by WEBAPP_isAuthorized_ —
 *   only the hiring manager and anyone listed in the Hiring Managers tab or in
 *   Config key WEBAPP_ALLOWED_EMAILS (comma-separated) can load it.
 *
 * Public functions:
 *   doGet(e)                          — the web app entry point
 *   WEBAPP_getQueue(filter)           — client → ranked candidate list
 *   WEBAPP_decide(candidateId, code)  — client → one-click decision
 *   WEBAPP_url()                      — logs the deployed URL
 *   WEBAPP_openInSheet()              — opens the console as a near-full-screen dialog
 *   CONSOLE_V2_SETUP_RUN_ONCE()       — installs the 9/26/26 additions (run once)
 *   WEBAPP_selfTest()
 *
 * 9/26/26 — CONSOLE V2
 *   • Every Manager Decision dropdown option is a button on each card, labelled
 *     with the exact Config text, so the console and the sheet always match.
 *   • New decision "Request Pre-Screen (Required)" (prescreen_required email).
 *   • Tabs: Needs decision · Waiting on pre-screen · In progress · Closed (reopen) · All active.
 *   • Reject asks for the Rejection Reason inline; Reject / Archive / Hire / Offer
 *     need a second click to confirm.
 *   • Dialog sizes itself to the screen, leaving a margin to navigate.
 *   • Fixed "undefined" score / risk / phone chips (google.script.run drops nulls).
 */

var WEBAPP_TITLE = "Frank's Hiring Console";

// Decisions the console can take, mapped to the Config decision labels the
// existing dropdown dispatcher understands.
// Every Manager Decision dropdown option, in the same order the dropdown shows.
// `confirm` = needs a second click in the console.
var WEBAPP_ACTIONS = Object.freeze({
  ADVANCE_LIVE:      'DECISION_ADVANCE_LIVE',
  INTERVIEW_BOOKED:  'DECISION_INTERVIEW_BOOKED',
  REQUEST_REFS:      'DECISION_REQUEST_REFERENCES',
  HIRED:             'DECISION_HIRED',
  DRAWER:            'DECISION_PUT_IN_DRAWER',
  REQUEST_PRESCREEN: 'DECISION_REQUEST_PRESCREEN',
  ADVANCE_WORKING:   'DECISION_ADVANCE_WORKING',
  MAKE_OFFER:        'DECISION_MAKE_OFFER',
  NEEDS_INFO:        'DECISION_NEEDS_INFO',
  REJECT:            'DECISION_REJECT',
  REOPEN:            'DECISION_REOPEN',
  ARCHIVE:           'DECISION_ARCHIVE'
});
var WEBAPP_ACTION_DEFAULT_LABELS = Object.freeze({
  DECISION_INTERVIEW_BOOKED:  'Interview Booked (Manual)',
  DECISION_REQUEST_PRESCREEN: 'Request Pre-Screen (Required)'
});
var WEBAPP_CONFIRM_ACTIONS = { REJECT: 1, ARCHIVE: 1, HIRED: 1, MAKE_OFFER: 1 };

/** Button list for the client: [{code,label,confirm}] in dropdown order. */
function WEBAPP_actionList_() {
  return Object.keys(WEBAPP_ACTIONS).map(function (code) {
    var key = WEBAPP_ACTIONS[code];
    return { code: code, label: CFG.get(key, WEBAPP_ACTION_DEFAULT_LABELS[key] || '') || '',
             confirm: !!WEBAPP_CONFIRM_ACTIONS[code] };
  }).filter(function (a) { return a.label; });
}

function WEBAPP_rejectionReasons_() {
  return String(CFG.get('REJECTION_REASONS') || '').split(',')
    .map(function (x) { return x.trim(); }).filter(Boolean);
}

function WEBAPP_fmtDate_(v) {
  if (!v) return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles'), 'EEE M/d');
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  var email = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(email)) {
    return HtmlService.createHtmlOutput(
      '<div style="font:16px system-ui;padding:40px;max-width:520px;margin:auto">' +
      '<h2 style="margin:0 0 12px">Not authorised</h2>' +
      '<p>This console is limited to Frank\'s European Service hiring managers.</p>' +
      '<p style="color:#666">Signed in as: <b>' + (email || 'unknown') + '</b></p>' +
      '<p style="color:#666">Add this address to the <b>Hiring Managers</b> tab or to Config key ' +
      '<b>WEBAPP_ALLOWED_EMAILS</b> to grant access.</p></div>'
    ).setTitle(WEBAPP_TITLE);
  }
  logEvent_('WEBAPP_OPENED', '', { viewer: email });
  var t = HtmlService.createTemplateFromFile('47_WebApp_UI');
  t.viewerEmail = email;
  t.shopName    = CFG.get('SHOP_NAME', "Frank's European Service");
  t.systemMode  = CFG.get('SYSTEM_MODE', 'TEST');
  return t.evaluate()
    .setTitle(WEBAPP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function WEBAPP_viewerEmail_() {
  var e = '';
  try { e = Session.getActiveUser().getEmail() || ''; } catch (err) { e = ''; }
  if (!e) { try { e = Session.getEffectiveUser().getEmail() || ''; } catch (err) {} }
  return String(e).toLowerCase();
}

function WEBAPP_isAuthorized_(email) {
  if (!email) return false;
  var allowed = {};
  var mgr = String(CFG.get('HIRING_MANAGER_EMAIL', '') || '').toLowerCase();
  if (mgr) allowed[mgr] = true;
  String(CFG.get('WEBAPP_ALLOWED_EMAILS', '') || '').split(/\s*,\s*/).forEach(function (a) {
    if (a) allowed[a.toLowerCase()] = true;
  });
  var hm = getSheetOrNull_(SHEETS.HIRING_MANAGERS || 'Hiring Managers');
  if (hm && hm.getLastRow() >= 2) {
    var headers = getHeaderRow_(hm);
    var cEmail = headers.indexOf('Hiring Manager Email');
    var cActive = headers.indexOf('Active');
    if (cEmail >= 0) {
      hm.getRange(2, 1, hm.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
        if (cActive >= 0 && String(r[cActive]).trim().toUpperCase() === 'FALSE') return;
        var a = String(r[cEmail] || '').trim().toLowerCase();
        if (a) allowed[a] = true;
      });
    }
  }
  return !!allowed[email];
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT API — queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ranked candidate queue for the console.
 * @param {object} filter { role:string, bucket:'decide'|'all'|'booked' }
 * @return {object} { ok, mode, viewer, counts, candidates:[...] }
 */
function WEBAPP_getQueue(filter) {
  filter = filter || {};
  var viewer = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(viewer)) return { ok: false, error: 'not authorised' };

  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac || ac.getLastRow() < 2) return { ok: true, candidates: [], counts: {}, mode: CFG.get('SYSTEM_MODE') };

  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues();
  function c(n) { return headers.indexOf(n); }
  var cId = c('Candidate ID'), cFn = c('First Name'), cLn = c('Last Name'),
      cRole = c('Role'), cStatus = c('Status'), cScore = c('AI Score'),
      cRisk = c('Risk Score'), cTier = c('Score Tier'), cNotes = c('Notes'),
      cResume = c('Resume Link'), cEmail = c('Email'), cPhone = c('Phone'),
      cDate = c('Date Received'), cStr = c('Strengths'), cCon = c('Concerns'),
      cRec = c('Recommended Next Step'), cConf = c('Confidence');

  var detail = WEBAPP_gradeDetailIndex_();
  var pipeline = WEBAPP_pipelineIndex_();

  // 9/26/26: applicants who never completed the pre-screen are NOT "needs decision"
  // — applying on Indeed does not put someone in consideration; the pre-screen does.
  var DECIDE    = { 'MANUAL_REVIEW': 1, 'PHONE_DONE': 1, 'FULL_DONE': 1, 'NEW': 1, 'SCORED': 1,
                    'PRESCREEN_RECEIVED': 1, 'REFS_COMPLETE': 1, 'RECOMMENDED': 1 };
  var PRESCREEN = { 'PRESCREEN_SENT': 1 };
  var CLOSED    = { 'ARCHIVED': 1, 'REJECTED': 1, 'IN_DRAWER': 1 };
  var HIDE      = { 'ARCHIVED': 1, 'REJECTED': 1, 'HIRED': 1, 'WITHDRAWN': 1, 'IN_DRAWER': 1, 'REGISTRY_HOLD': 1 };

  var out = [], counts = { decide: 0, prescreen: 0, booked: 0, closed: 0, other: 0 };
  var wantRole = String(filter.role || '').toLowerCase();
  var bucket = String(filter.bucket || 'decide');

  data.forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var status = String(r[cStatus] || '').trim().toUpperCase();
    var role = cRole >= 0 ? String(r[cRole] || '') : '';

    if (DECIDE[status]) counts.decide++;
    else if (PRESCREEN[status]) counts.prescreen++;
    else if (CLOSED[status]) counts.closed++;
    else if (!HIDE[status]) counts.booked++;
    else counts.other++;

    if (bucket === '__counts__') return;   // tab badges only
    if (bucket === 'decide' && !DECIDE[status]) return;
    if (bucket === 'prescreen' && !PRESCREEN[status]) return;
    if (bucket === 'booked' && (DECIDE[status] || PRESCREEN[status] || HIDE[status])) return;
    if (bucket === 'closed' && !CLOSED[status]) return;
    if (bucket === 'all' && HIDE[status]) return;
    if (wantRole && role.toLowerCase().indexOf(wantRole) === -1) return;

    var d = detail[id] || {};
    var p = pipeline[id] || {};
    var score = cScore >= 0 ? parseFloat(r[cScore]) : NaN;

    out.push({
      id: id,
      name: ((cFn >= 0 ? r[cFn] : '') + ' ' + (cLn >= 0 ? r[cLn] : '')).trim() || '(no name)',
      role: role,
      status: status,
      score: isNaN(score) ? null : score,
      risk: cRisk >= 0 && r[cRisk] !== '' ? parseFloat(r[cRisk]) : null,
      tier: cTier >= 0 ? String(r[cTier] || '') : '',
      phoneScore: p.phoneScore == null ? null : p.phoneScore,
      recommendation: p.recommendation || '',
      summary: cNotes >= 0 ? String(r[cNotes] || '') : '',
      strengths: WEBAPP_splitList_(cStr >= 0 ? r[cStr] : (d.strengths || '')),
      concerns:  WEBAPP_splitList_(cCon >= 0 ? r[cCon] : (d.concerns || '')),
      gateFailed: d.gateFailed || false,
      gateReasons: d.gateReasons || '',
      breakdown: d.breakdown || '',
      confidence: cConf >= 0 ? String(r[cConf] || '') : (d.confidence || ''),
      nextStep: String(cRec >= 0 ? String(r[cRec] || '') : (d.nextStep || '')).replace(/phone screen/ig, 'live interview'),
      resume: cResume >= 0 ? String(r[cResume] || '') : '',
      email: cEmail >= 0 ? String(r[cEmail] || '') : '',
      phone: cPhone >= 0 ? String(r[cPhone] || '') : '',
      received: cDate >= 0 ? WEBAPP_fmtDate_(r[cDate]) : ''
    });
  });

  // Best first; unscored last so they never bury a strong candidate.
  out.sort(function (a, b) {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  return {
    ok: true, viewer: viewer, mode: CFG.get('SYSTEM_MODE', 'TEST'),
    counts: counts, candidates: out,
    roles: WEBAPP_roleList_(),
    actions: WEBAPP_actionList_(),
    rejectionReasons: WEBAPP_rejectionReasons_()
  };
}

function WEBAPP_splitList_(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(/\s*\|\s*|\s*;\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function WEBAPP_roleList_() {
  var sh = getSheetOrNull_(SHEETS.ROLE_RULES);
  if (!sh || sh.getLastRow() < 2) return [];
  var headers = getHeaderRow_(sh);
  var cRole = headers.indexOf('Role'), cActive = headers.indexOf('Active');
  var out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    if (cActive >= 0 && String(r[cActive]).trim().toUpperCase() === 'FALSE') return;
    var v = String(r[cRole] || '').trim();
    if (v && out.indexOf(v) === -1) out.push(v);
  });
  return out;
}

/** Latest Grade Detail row per candidate. */
function WEBAPP_gradeDetailIndex_() {
  var sh = getSheetOrNull_(GRADE_DETAIL_SHEET);
  var idx = {};
  if (!sh || sh.getLastRow() < 2) return idx;
  var headers = getHeaderRow_(sh);
  function c(n) { return headers.indexOf(n); }
  var cId = c('Candidate ID'), cStr = c('Strengths'), cCon = c('Concerns'),
      cGate = c('Hard Gate Failed'), cGateR = c('Hard Gate Reasons'),
      cBd = c('Category Breakdown'), cConf = c('Confidence'), cNext = c('Recommended Next Step');
  sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    idx[id] = {   // later rows overwrite earlier ones = newest wins
      strengths:   cStr >= 0 ? String(r[cStr] || '') : '',
      concerns:    cCon >= 0 ? String(r[cCon] || '') : '',
      gateFailed:  cGate >= 0 && String(r[cGate]).toUpperCase() === 'TRUE',
      gateReasons: cGateR >= 0 ? String(r[cGateR] || '') : '',
      breakdown:   cBd >= 0 ? String(r[cBd] || '') : '',
      confidence:  cConf >= 0 ? String(r[cConf] || '') : '',
      nextStep:    cNext >= 0 ? String(r[cNext] || '') : ''
    };
  });
  return idx;
}

function WEBAPP_pipelineIndex_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var idx = {};
  if (!sh || sh.getLastRow() < 2) return idx;
  var headers = getHeaderRow_(sh);
  var cId = headers.indexOf('Candidate ID'),
      cPhone = headers.indexOf('Phone Score'),
      cRec = headers.indexOf('Final Recommendation');
  sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var ps = cPhone >= 0 ? parseFloat(r[cPhone]) : NaN;
    idx[id] = {
      phoneScore: isNaN(ps) ? null : ps,
      recommendation: cRec >= 0 ? String(r[cRec] || '') : ''
    };
  });
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT API — decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a decision. Routes through the existing dropdown dispatcher so the
 * console and the sheet behave identically.
 * @param {string} candidateId
 * @param {string} actionCode  key of WEBAPP_ACTIONS
 * @param {object=} opts       { reason: Rejection Reason (REJECT only) }
 * @return {object} { ok, message }
 */
function WEBAPP_decide(candidateId, actionCode, opts) {
  opts = opts || {};
  var viewer = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(viewer)) return { ok: false, message: 'Not authorised' };
  if (!candidateId) return { ok: false, message: 'No candidate' };

  var cfgKey = WEBAPP_ACTIONS[actionCode];
  if (!cfgKey) return { ok: false, message: 'Unknown action: ' + actionCode };
  var label = CFG.get(cfgKey, WEBAPP_ACTION_DEFAULT_LABELS[cfgKey] || '');
  if (!label) return { ok: false, message: 'Config key ' + cfgKey + ' is empty' };

  return withLock_(function () {
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    var hits = ip ? findRowsByColumnValue_(ip, 'Candidate ID', candidateId) : [];
    var candidate, rowNum = 0;

    if (hits.length) { candidate = hits[0].data; rowNum = hits[0].rowNum; }
    else {
      candidate = _getCandidateRow_(candidateId);
      if (!candidate) return { ok: false, message: 'Candidate not found' };
      // Surface them in the pipeline first so downstream writes have a row.
      safeRun_('webapp:ensureRow', function () {
        _ensureInterviewPipelineRow_(candidateId, {
          status: candidate['Status'], stage: 'Added from Hiring Console', via: 'webapp'
        });
      });
      hits = ip ? findRowsByColumnValue_(ip, 'Candidate ID', candidateId) : [];
      if (hits.length) { candidate = hits[0].data; rowNum = hits[0].rowNum; }
    }

    // Reject: record the reason on the pipeline row first — the dispatcher reads it.
    if (actionCode === 'REJECT' && opts.reason) {
      candidate['Rejection Reason'] = String(opts.reason);
      if (ip && rowNum) safeRun_('webapp:rejectReason', function () {
        updateRowWhere_(ip, 'Candidate ID', candidateId, { 'Rejection Reason': String(opts.reason) });
      });
    }

    var before = String(candidate['Status'] || '');
    var result;
    try {
      result = _dispatchPipelineDecision_(candidateId, label, candidate, rowNum);
    } catch (e) {
      logError_('WEBAPP_decide', e, candidateId, 'ERROR');
      return { ok: false, message: 'Failed: ' + e.message };
    }

    safeRun_('webapp:override', function () {
      logOverride_({
        actor: viewer + ' (Hiring Console)', candidateId: candidateId,
        overrideType: 'Console decision', previousValue: before, newValue: label,
        reason: 'One-click decision from the web console'
      });
    });
    logEvent_('WEBAPP_DECISION', candidateId, { action: actionCode, label: label, viewer: viewer });

    if (!result) return { ok: false, message: '"' + label + '" was not recognised by the dispatcher — nothing changed' };
    var msg = label + ' applied';
    if (result.archived) msg += ' — moved off the pipeline';
    if (result.emailQueued === false && result.reason) msg += ' (no email: ' + result.reason + ')';
    return { ok: true, message: msg, action: actionCode, result: result };
  });
}

/** Re-score one candidate on demand from the console. */
function WEBAPP_rescore(candidateId) {
  if (!WEBAPP_isAuthorized_(WEBAPP_viewerEmail_())) return { ok: false, message: 'Not authorised' };
  try {
    var r = scorePreScreenV2(candidateId);
    return { ok: true, message: r.score === null ? ('Not scored — ' + r.reason) : ('Scored ' + r.score + ' → ' + r.action) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTIL
// ─────────────────────────────────────────────────────────────────────────────

/** Log the deployed web app URL (blank until the first deployment). */
function WEBAPP_url() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  var msg = url ? ('[WEBAPP] ' + url) : '[WEBAPP] not deployed yet — Deploy → New deployment → Web app';
  Logger.log(msg);
  try { toast_(msg, 'Recruiting OS', 12); } catch (e) {}
  return msg;
}

function WEBAPP_selfTest() {
  var out = ['[WEBAPP] selfTest…'];
  var viewer = WEBAPP_viewerEmail_();
  out.push('  ─ viewer          : ' + (viewer || '(none — run from the editor once to authorise)'));
  out.push('  ─ authorised      : ' + WEBAPP_isAuthorized_(viewer));
  out.push('  ─ SYSTEM_MODE     : ' + CFG.get('SYSTEM_MODE'));
  var q = WEBAPP_getQueue({ bucket: 'decide' });
  out.push('  ─ queue (decide)  : ' + (q.ok ? q.candidates.length + ' candidate(s)' : 'ERROR ' + q.error));
  if (q.ok && q.candidates.length) {
    q.candidates.slice(0, 5).forEach(function (c) {
      out.push('       ' + String(c.score === null ? '—' : c.score).padStart(3, ' ') + '  ' +
               c.name + ' (' + c.role + ') ' + c.status);
    });
  }
  out.push('  ─ roles           : ' + WEBAPP_roleList_().join(', '));
  Object.keys(WEBAPP_ACTIONS).forEach(function (k) {
    var lbl = CFG.get(WEBAPP_ACTIONS[k], WEBAPP_ACTION_DEFAULT_LABELS[WEBAPP_ACTIONS[k]] || '');
    out.push('  ' + (lbl ? '✓' : '✗') + ' action ' + k + ' → "' + lbl + '"');
  });
  var url = ''; try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  out.push('  ' + (url ? '✓' : '✗') + ' deployed URL: ' + (url || 'not deployed yet'));
  out.push('[WEBAPP] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
/**
 * Open the Hiring Console as a dialog inside the spreadsheet — no deployment needed.
 * Step 1 shows a tiny launcher that measures the screen; step 2 (WEBAPP_openSized)
 * re-opens the console at nearly full size with a margin left around the edges.
 */
function WEBAPP_openInSheet() {
  var ui = SpreadsheetApp.getUi();
  var email = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(email)) {
    ui.alert('Not authorised', 'Signed in as: ' + (email || 'unknown') +
      '\nAdd this address to the Hiring Managers tab or Config key WEBAPP_ALLOWED_EMAILS.',
      ui.ButtonSet.OK);
    return;
  }
  var launcher = HtmlService.createHtmlOutput(
    '<div style="font:14px system-ui;padding:18px;color:#333">Opening Hiring Console…</div>' +
    '<script>' +
    'var w=(window.screen&&screen.availWidth)||1400,h=(window.screen&&screen.availHeight)||900;' +
    'google.script.run.withFailureHandler(function(e){document.body.textContent="Could not open: "+e.message;})' +
    '.WEBAPP_openSized(w,h);' +
    '</script>').setWidth(260).setHeight(70);
  ui.showModalDialog(launcher, "Frank's Hiring Console");
}

/**
 * Called by the launcher with the screen size. Leaves ~40px each side and room
 * for the browser toolbar + dialog title bar so you can still reach the sheet.
 */
function WEBAPP_openSized(screenW, screenH) {
  var w = Math.round(Number(screenW) || 1400) - 90;
  var h = Math.round(Number(screenH) || 900) - 250;
  w = Math.max(900, Math.min(w, 2400));
  h = Math.max(560, Math.min(h, 1400));
  var t = HtmlService.createTemplateFromFile('47_WebApp_UI');
  t.viewerEmail = WEBAPP_viewerEmail_();
  t.shopName    = CFG.get('SHOP_NAME', "Frank's European Service");
  t.systemMode  = CFG.get('SYSTEM_MODE', 'TEST');
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(w).setHeight(h), "Frank's Hiring Console");
}

/**
 * RUN ONCE after pulling the 9/26/26 files. Idempotent — safe to re-run.
 *   • adds Config DECISION_REQUEST_PRESCREEN + PIPELINE_ARCHIVE_ON_DECISION
 *   • installs the prescreen_required email template (adds it; leaves others alone)
 *   • refreshes the Manager Decision dropdown on Interview Pipeline + Pipeline Archive
 *   • moves any already-closed rows (Rejected / Archived / Drawer / Hired) off the pipeline now
 */
function CONSOLE_V2_SETUP_RUN_ONCE() {
  var out = ['[CONSOLE V2] setup'];
  if (!CFG.has('DECISION_REQUEST_PRESCREEN')) { CFG.set('DECISION_REQUEST_PRESCREEN', 'Request Pre-Screen (Required)'); out.push('✓ added DECISION_REQUEST_PRESCREEN'); }
  else out.push('─ DECISION_REQUEST_PRESCREEN already set: "' + CFG.get('DECISION_REQUEST_PRESCREEN') + '"');
  if (!CFG.has('DECISION_INTERVIEW_BOOKED')) { CFG.set('DECISION_INTERVIEW_BOOKED', 'Interview Booked (Manual)'); out.push('✓ added DECISION_INTERVIEW_BOOKED'); }
  if (!CFG.has('PIPELINE_ARCHIVE_ON_DECISION')) { CFG.set('PIPELINE_ARCHIVE_ON_DECISION', 'TRUE'); out.push('✓ added PIPELINE_ARCHIVE_ON_DECISION=TRUE'); }
  CFG.reset();

  // Add the new template only — do not overwrite edited wording on the others.
  var tSh = getSheet_(SHEETS.EMAIL_TEMPLATES);
  var seed = SEED_EMAIL_TEMPLATES.filter(function (r) { return r['Template Key'] === 'prescreen_required'; })[0];
  if (!seed) out.push('✗ prescreen_required missing from 03_Seed_Templates.gs — pull that file');
  else if (findRowsByColumnValue_(tSh, 'Template Key', 'prescreen_required').length) out.push('─ prescreen_required template already present');
  else { appendRowByHeader_(tSh, seed); out.push('✓ added prescreen_required email template'); }

  var n = _applyManagerDecisionDropdown_();
  out.push((n ? '✓' : '✗') + ' Manager Decision dropdown refreshed on Interview Pipeline');
  var arch = getSheetOrNull_(SHEETS.PIPELINE_ARCHIVE);
  if (arch && getColIndex_(arch, 'Manager Decision')) {
    _applyListValidation_(arch, 'Manager Decision', [CFG.get('DECISION_REOPEN', 'Reopen Candidate')]);
    out.push('✓ Pipeline Archive: pick "' + CFG.get('DECISION_REOPEN', 'Reopen Candidate') + '" in Manager Decision to bring someone back');
  }

  // One-time cleanup of rows already closed out (ignores the cancellable hold).
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE), moved = 0;
  if (ip && ip.getLastRow() >= 2) {
    var H = getHeaderRow_(ip), cS = H.indexOf('Status'), cI = H.indexOf('Candidate ID');
    var closed = { REJECTED: 1, ARCHIVED: 1, IN_DRAWER: 1, HIRED: 1, REGISTRY_HOLD: 1 };
    var ids = ip.getRange(2, 1, ip.getLastRow() - 1, H.length).getValues()
      .filter(function (r) { return closed[String(r[cS] || '').trim().toUpperCase()] && String(r[cI] || '').trim(); })
      .map(function (r) { return [String(r[cI]).trim(), String(r[cS]).trim().toUpperCase()]; });
    withLock_(function () {
      ids.forEach(function (p) { if (archivePipelineCandidateNow_(p[0], p[1])) moved++; });
    });
  }
  out.push('✓ moved ' + moved + ' already-closed candidate(s) off Interview Pipeline');
  out.push(WEBAPP_selfTest());
  var msg = out.join('\n'); Logger.log(msg);
  try { toast_('Console V2 setup done — moved ' + moved + ' closed row(s). See Execution log.', 'Recruiting OS', 10); } catch (e) {}
  return msg;
}
