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
 *   WEBAPP_selfTest()
 */

var WEBAPP_TITLE = "Frank's Hiring Console";

// Decisions the console can take, mapped to the Config decision labels the
// existing dropdown dispatcher understands.
var WEBAPP_ACTIONS = Object.freeze({
  ADVANCE_PHONE: 'DECISION_ADVANCE_PHONE',
  ADVANCE_LIVE:  'DECISION_ADVANCE_LIVE',
  REQUEST_REFS:  'DECISION_REQUEST_REFERENCES',
  DRAWER:        'DECISION_PUT_IN_DRAWER',
  REJECT:        'DECISION_REJECT',
  HIRED:         'DECISION_HIRED'
});

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

  var DECIDE = { 'MANUAL_REVIEW': 1, 'PHONE_DONE': 1, 'FULL_DONE': 1, 'NEW': 1, 'PRESCREEN_SENT': 1 };
  var HIDE   = { 'ARCHIVED': 1, 'REJECTED': 1, 'HIRED': 1, 'WITHDRAWN': 1, 'IN_DRAWER': 1 };

  var out = [], counts = { decide: 0, booked: 0, other: 0 };
  var wantRole = String(filter.role || '').toLowerCase();
  var bucket = String(filter.bucket || 'decide');

  data.forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var status = String(r[cStatus] || '').trim().toUpperCase();
    var role = cRole >= 0 ? String(r[cRole] || '') : '';

    if (DECIDE[status]) counts.decide++;
    else if (!HIDE[status]) counts.booked++;
    else counts.other++;

    if (bucket === 'decide' && !DECIDE[status]) return;
    if (bucket === 'booked' && (DECIDE[status] || HIDE[status])) return;
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
      nextStep: cRec >= 0 ? String(r[cRec] || '') : (d.nextStep || ''),
      resume: cResume >= 0 ? String(r[cResume] || '') : '',
      email: cEmail >= 0 ? String(r[cEmail] || '') : '',
      phone: cPhone >= 0 ? String(r[cPhone] || '') : '',
      received: cDate >= 0 ? String(r[cDate] || '') : ''
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
    roles: WEBAPP_roleList_()
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
 * @return {object} { ok, message }
 */
function WEBAPP_decide(candidateId, actionCode) {
  var viewer = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(viewer)) return { ok: false, message: 'Not authorised' };
  if (!candidateId) return { ok: false, message: 'No candidate' };

  var cfgKey = WEBAPP_ACTIONS[actionCode];
  if (!cfgKey) return { ok: false, message: 'Unknown action: ' + actionCode };
  var label = CFG.get(cfgKey);
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

    return { ok: true, message: label + ' applied', action: actionCode, result: result || {} };
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
    var lbl = CFG.get(WEBAPP_ACTIONS[k]);
    out.push('  ' + (lbl ? '✓' : '✗') + ' action ' + k + ' → "' + lbl + '"');
  });
  var url = ''; try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  out.push('  ' + (url ? '✓' : '✗') + ' deployed URL: ' + (url || 'not deployed yet'));
  out.push('[WEBAPP] selfTest done.');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
/** Open the Hiring Console as a dialog inside the spreadsheet — no deployment needed. */
function WEBAPP_openInSheet() {
  var ui = SpreadsheetApp.getUi();
  var email = WEBAPP_viewerEmail_();
  if (!WEBAPP_isAuthorized_(email)) {
    ui.alert('Not authorised', 'Signed in as: ' + (email || 'unknown') +
      '\nAdd this address to the Hiring Managers tab or Config key WEBAPP_ALLOWED_EMAILS.',
      ui.ButtonSet.OK);
    return;
  }
  var t = HtmlService.createTemplateFromFile('47_WebApp_UI');
  t.viewerEmail = email;
  t.shopName    = CFG.get('SHOP_NAME', "Frank's European Service");
  t.systemMode  = CFG.get('SYSTEM_MODE', 'TEST');
  ui.showModalDialog(t.evaluate().setWidth(1100).setHeight(720), "Frank's Hiring Console");
}