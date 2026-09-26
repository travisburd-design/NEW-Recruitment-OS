/**
 * 54_Pipeline_Snapshot.gs
 * Frank's European Service — Recruiting OS
 *
 * 9/26/26 — COMMON-SENSE CLEANUP + DECISION SNAPSHOT
 *
 * 1) DECISION SNAPSHOT on the Interview Pipeline tab, so a decision never rests
 *    on one number. Three columns, refreshed every 15 minutes (inside LIVEADV_run):
 *      • Decision Snapshot   — score · tier · risk · culture · role skill, top
 *                              strengths, top concerns, hard-gate flags, AI next step.
 *                              Hover the cell for the full breakdown + AI summary.
 *      • Pre-Screen Answers  — link straight to the candidate's pre-screen row.
 *      • Resume              — link to the resume.
 *    It also fills Culture Score / Culture Summary from the combined pre-screen
 *    (AI Assessment Results → Culture Fit Score) — there is no separate culture form.
 *
 * 2) RECRUITING_CLEANUP_RUN_ONCE() — one idempotent pass that brings the live
 *    workbook in line with the retired phone screen and retired culture form:
 *      • removes "Send Phone Screen Booking" from the Manager Decision dropdown
 *      • deletes the retired email templates and rewrites the ones whose wording
 *        was wrong ("We enjoyed our conversation", culture-form asks, 45–60 min)
 *      • fixes the AI prompt's next-step wording (phone screen → live interview)
 *      • repairs candidates marked FULL_BOOKED before they actually booked, so
 *        their booking is picked up (booking alert, worksheet, booking record)
 *      • hides phone-screen columns, adds + shows the snapshot columns
 *      • closes the retired Culture & Style and Technician Skill Test forms
 *      • rebuilds the Instruction Manual and fills every snapshot
 *
 * Public functions:
 *   PIPELINE_refreshDecisionSnapshots()
 *   RECRUITING_CLEANUP_RUN_ONCE()
 *   SNAP_cultureFromAssessment_(candidateId) → { score, summary }
 *   SNAP_selfTest()
 */

var SNAP_COLS = ['Decision Snapshot', 'Pre-Screen Answers', 'Resume'];

// Email templates that no longer have any sender (phone screen, separate culture
// form, separate technician skill test).
var SNAP_RETIRED_TEMPLATES = [
  'phone_screen_booking', 'phone_screen_confirmation', 'technician_post_prescreen',
  'culture_fit_invite', 'reference_and_culture_invite', 'live_interview_booking_technician'
];

// Interview Pipeline columns from the retired phone-screen stage (hidden, not deleted).
var SNAP_PHONE_COLUMNS = [
  'Phone Screen Link Sent', 'Phone Screen Booked', 'Phone Screen Done',
  'Phone Screen Outcome', 'Phone Screen Score', 'Phone Score'
];

// ─────────────────────────────────────────────────────────────────────────────
// CULTURE — from the combined pre-screen
// ─────────────────────────────────────────────────────────────────────────────

function SNAP_cultureFromAssessment_(candidateId) {
  var out = { score: 0, summary: '' };
  try {
    var a = (typeof getLatestAssessmentResult_ === 'function') ? getLatestAssessmentResult_(candidateId) : null;
    if (!a) return out;
    var n = parseFloat(a['Culture Fit Score']);
    out.score = isNaN(n) ? 0 : n;
    out.summary = String(a['Summary For Worksheet'] || '').trim();
  } catch (e) {}
  return out;
}

/** Latest AI Assessment Results row per candidate, read once. */
function SNAP_assessmentIndex_() {
  var idx = {};
  var name = (typeof ASSESS_SHEETS !== 'undefined' && ASSESS_SHEETS.RESULTS) ? ASSESS_SHEETS.RESULTS : 'AI Assessment Results';
  var sh = getSheetOrNull_(name);
  if (!sh || sh.getLastRow() < 2) return idx;
  var h = getHeaderRow_(sh);
  var cId = h.indexOf('Candidate ID'), cTs = h.indexOf('Timestamp');
  sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues().forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var ts = cTs >= 0 ? _coerceDate_(r[cTs]).getTime() : 0;
    if (idx[id] && idx[id]._ts > ts) return;
    var o = { _ts: ts };
    h.forEach(function (name, j) { o[name] = r[j]; });
    idx[id] = o;
  });
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

function PIPELINE_refreshDecisionSnapshots() {
  if (!CFG.getBool('PIPELINE_SNAPSHOT_ENABLED', true)) return '[SNAP] disabled';
  return withLockOrSkip_('PIPELINE_refreshDecisionSnapshots', function () {
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (!ip) return '[SNAP] Interview Pipeline missing';
    ensureHeaders_(ip, SNAP_COLS);
    var last = ip.getLastRow();
    if (last < 2) return '[SNAP] pipeline empty';

    var H = getHeaderRow_(ip);
    function col(n) { return H.indexOf(n); }
    var cId = col('Candidate ID'), cEmail = col('Email'), cStatus = col('Status'),
        cSnap = col('Decision Snapshot'), cAns = col('Pre-Screen Answers'), cRes = col('Resume'),
        cCult = col('Culture Score'), cCultSum = col('Culture Summary');
    var n = last - 1;
    var data = ip.getRange(2, 1, n, H.length).getValues();
    var ansF = ip.getRange(2, cAns + 1, n, 1).getFormulas();
    var resF = ip.getRange(2, cRes + 1, n, 1).getFormulas();

    var ac = _SNAP_acIndex_();
    var gd = (typeof WEBAPP_gradeDetailIndex_ === 'function') ? WEBAPP_gradeDetailIndex_() : {};
    var as = SNAP_assessmentIndex_();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var gidCache = {};

    var snapOut = [], noteOut = [], ansOut = [], resOut = [], cultureWrites = [];
    for (var i = 0; i < n; i++) {
      var id = String(data[i][cId] || '').trim();
      var a = ac[id] || {}, g = gd[id] || {}, x = as[id] || {};
      var status = String(data[i][cStatus] || a['Status'] || '').toUpperCase();
      var built = id ? _SNAP_build_(a, g, x, status) : { text: '', note: '' };
      snapOut.push([built.text]);
      noteOut.push([built.note]);

      // Pre-Screen Answers link — computed once, then kept.
      var ans = ansF[i][0];
      if (!ans && id) {
        var email = String(data[i][cEmail] || a['Email'] || '').trim();
        var hit = (email && typeof PS_findPreScreenRow2_ === 'function') ? PS_findPreScreenRow2_(email) : null;
        if (hit) {
          if (!(hit.sheetName in gidCache)) { var t = ss.getSheetByName(hit.sheetName); gidCache[hit.sheetName] = t ? t.getSheetId() : null; }
          var gid = gidCache[hit.sheetName];
          if (gid !== null) ans = '=HYPERLINK("#gid=' + gid + '&range=A' + hit.rowNum + '","Open pre-screen")';
        }
      }
      ansOut.push([ans || '']);

      var res = resF[i][0];
      var url = String(a['Resume Link'] || '').trim();
      if (!res && /^https?:\/\//i.test(url)) res = '=HYPERLINK("' + url.replace(/"/g, '%22') + '","Resume")';
      resOut.push([res || '']);

      // Culture from the pre-screen when the column is still blank.
      if (id && cCult >= 0 && !(parseFloat(data[i][cCult]) > 0)) {
        var cf = parseFloat(x['Culture Fit Score']);
        if (cf > 0) cultureWrites.push({ row: i, score: cf, summary: String(x['Summary For Worksheet'] || '') });
      }
    }

    // Rows can move while we worked (a decision archives a row instantly) — only
    // write when the Candidate ID column is exactly what we read.
    var idsNow = ip.getRange(2, cId + 1, Math.max(ip.getLastRow() - 1, 1), 1).getValues()
      .map(function (r) { return String(r[0] || '').trim(); });
    var idsThen = data.map(function (r) { return String(r[cId] || '').trim(); });
    if (idsNow.length !== idsThen.length || idsNow.join('|') !== idsThen.join('|')) {
      return '[SNAP] pipeline changed during refresh — skipped this pass (next pass in 15 min)';
    }

    ip.getRange(2, cSnap + 1, n, 1).setValues(snapOut).setNotes(noteOut).setWrap(true).setVerticalAlignment('top');
    ip.getRange(2, cAns + 1, n, 1).setFormulas(ansOut);
    ip.getRange(2, cRes + 1, n, 1).setFormulas(resOut);
    cultureWrites.forEach(function (w) {
      ip.getRange(w.row + 2, cCult + 1).setValue(w.score);
      if (cCultSum >= 0 && !String(data[w.row][cCultSum] || '').trim() && w.summary) {
        ip.getRange(w.row + 2, cCultSum + 1).setValue(truncate_(w.summary, 1000));
      }
    });
    return '[SNAP] refreshed ' + n + ' row(s); culture filled for ' + cultureWrites.length;
  });
}

function _SNAP_acIndex_() {
  var idx = {};
  var sh = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!sh || sh.getLastRow() < 2) return idx;
  var h = getHeaderRow_(sh);
  var cId = h.indexOf('Candidate ID');
  sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues().forEach(function (r) {
    var id = String(r[cId] || '').trim();
    if (!id) return;
    var o = {}; h.forEach(function (name, j) { o[name] = r[j]; });
    idx[id] = o;
  });
  return idx;
}

function _SNAP_list_(v, max) {
  if (!v) return [];
  return String(v).split(/\s*\|\s*|\s*;\s*|\n+/).map(function (s) { return s.trim(); })
    .filter(Boolean).slice(0, max).map(function (s) { return s.length > 95 ? s.slice(0, 92) + '…' : s; });
}

function _SNAP_num_(v) { var n = parseFloat(v); return isNaN(n) ? null : Math.round(n); }

function _SNAP_build_(a, g, x, status) {
  var score = _SNAP_num_(a['AI Score']);
  if (status === 'PRESCREEN_SENT' || (score === null && !x['Culture Fit Score'])) {
    return { text: 'No pre-screen yet — applying is not consideration. Use "Request Pre-Screen (Required)".', note: '' };
  }
  var parts = [];
  if (score !== null) parts.push('Pre-screen ' + score);
  if (a['Score Tier']) parts.push(String(a['Score Tier']));
  var risk = _SNAP_num_(a['Risk Score']); if (risk !== null) parts.push('Risk ' + risk);
  var cult = _SNAP_num_(x['Culture Fit Score']); if (cult !== null) parts.push('Culture ' + cult);
  var skill = _SNAP_num_(x['Role Skill Score']); if (skill !== null) parts.push('Role skill ' + skill);

  var lines = [parts.join(' · ')];
  var str = _SNAP_list_(a['Strengths'] || x['Strengths'] || g.strengths, 2);
  var con = _SNAP_list_(a['Concerns'] || x['Concerns'] || g.concerns, 2);
  if (str.length) lines.push('✔ ' + str.join('; '));
  if (con.length) lines.push('⚠ ' + con.join('; '));
  if (g.gateFailed) lines.push('⛔ Hard gate: ' + (g.gateReasons || 'failed'));
  var next = String(a['Recommended Next Step'] || g.nextStep || x['Recommendation'] || '').replace(/phone screen/ig, 'live interview');
  if (next) lines.push('AI: ' + next);

  var note = [];
  var sum = String(x['Summary For Worksheet'] || a['Notes'] || '').trim();
  if (sum) note.push('SUMMARY\n' + sum);
  if (g.breakdown) note.push('SCORE BREAKDOWN\n' + String(g.breakdown).split(' | ').join('\n'));
  if (x['Clarification Needed']) note.push('ASK IN THE INTERVIEW\n' + x['Clarification Needed']);
  if (x['Suggested Interview Questions']) note.push('SUGGESTED QUESTIONS\n' + x['Suggested Interview Questions']);
  return { text: lines.join('\n'), note: truncate_(note.join('\n\n'), 4500) };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN ONCE
// ─────────────────────────────────────────────────────────────────────────────

function RECRUITING_CLEANUP_RUN_ONCE() {
  var out = ['[CLEANUP 9/26/26] phone screen + culture form retirement'];
  function step(label, fn) {
    try { var r = fn(); out.push('✓ ' + label + (r ? ' — ' + r : '')); }
    catch (e) { out.push('✗ ' + label + ' — ' + e.message); logError_('RECRUITING_CLEANUP_RUN_ONCE:' + label, e, '', 'ERROR'); }
  }

  step('Config', function () {
    var set = {
      DECISION_ADVANCE_PHONE: '', PHONE_SCREEN_RETIRED: 'TRUE', LIVE_INVITE_RESEND_DAYS: '7',
      LIVE_ADVANCE_TEMPLATE_TECH: 'live_interview_booking', REFERENCE_CULTURE_COMBINED_EMAIL_ENABLED: 'FALSE',
      PIPELINE_SNAPSHOT_ENABLED: 'TRUE'
    };
    Object.keys(set).forEach(function (k) {
      if (k === 'LIVE_INVITE_RESEND_DAYS' || k === 'PIPELINE_SNAPSHOT_ENABLED') { if (!CFG.has(k)) CFG.set(k, set[k]); }
      else CFG.set(k, set[k]);
    });
    if (CFG.get('LIVE_ADVANCE_TEMPLATE', '') === 'live_interview_booking_technician') CFG.set('LIVE_ADVANCE_TEMPLATE', 'live_interview_booking');
    var rep = String(CFG.get('EMAIL_REPEATABLE_TEMPLATES', '') || '').split(',')
      .map(function (s) { return s.trim(); }).filter(function (s) { return s && s !== 'phone_screen_confirmation'; });
    CFG.set('EMAIL_REPEATABLE_TEMPLATES', rep.join(','));
    CFG.reset();
    return 'phone decision blanked, one invite template for all roles, references-only';
  });

  step('Manager Decision dropdown', function () {
    var n = _applyManagerDecisionDropdown_();
    return n ? '"Send Phone Screen Booking" removed' : 'column not found';
  });

  step('Email templates', function () {
    var sh = getSheet_(SHEETS.EMAIL_TEMPLATES);
    var removed = [];
    SNAP_RETIRED_TEMPLATES.forEach(function (k) {
      var hits = findRowsByColumnValue_(sh, 'Template Key', k);
      hits.map(function (h) { return h.rowNum; }).sort(function (a, b) { return b - a; })
          .forEach(function (rn) { sh.deleteRow(rn); });
      if (hits.length) removed.push(k);
    });
    var rewritten = [];
    ['full_interview_booking', 'reference_request_candidate', 'reference_culture_reminder'].forEach(function (k) {
      var seed = SEED_EMAIL_TEMPLATES.filter(function (r) { return r['Template Key'] === k; })[0];
      if (!seed) return;
      if (findRowsByColumnValue_(sh, 'Template Key', k).length) updateRowWhere_(sh, 'Template Key', k, seed);
      else appendRowByHeader_(sh, seed);
      rewritten.push(k);
    });
    var live = findRowsByColumnValue_(sh, 'Template Key', 'live_interview_booking');
    if (live.length) {
      var b = String(live[0].data['Body'] || '')
        .replace('Plan for 45–60 minutes.', 'Plan for about 45 minutes.')
        .replace('Where: {{InterviewLocation}}\n', 'Where: {{InterviewLocation}} (in person)\n');
      batchUpdateRow_(sh, live[0].rowNum, { 'Body': b });
      rewritten.push('live_interview_booking (45 min, in person)');
    }
    return 'removed ' + (removed.join(', ') || 'none') + ' | rewrote ' + rewritten.join(', ');
  });

  step('AI prompt next-step wording', function () {
    var sh = getSheetOrNull_(SHEETS.AI_PROMPTS);
    if (!sh) return 'no prompt tab';
    var hits = findRowsByColumnValue_(sh, 'Prompt Key', 'prescreen');
    if (!hits.length) return 'no prescreen prompt';
    var body = String(hits[0].data['Prompt Body'] || '');
    if (body.indexOf('Advance to phone screen') === -1) return 'already correct';
    batchUpdateRow_(sh, hits[0].rowNum, { 'Prompt Body': body.split('Advance to phone screen').join('Advance to live interview') });
    return '"Advance to phone screen" → "Advance to live interview"';
  });

  step('Repair invited-but-not-booked candidates', function () {
    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    if (ip.getLastRow() < 2) return 'pipeline empty';
    var H = getHeaderRow_(ip);
    var cS = H.indexOf('Status'), cB = H.indexOf('Full Interview Booked'), cI = H.indexOf('Candidate ID');
    var fixed = [];
    ip.getRange(2, 1, ip.getLastRow() - 1, H.length).getValues().forEach(function (r) {
      if (String(r[cS] || '').toUpperCase() !== String(STATUS.FULL_BOOKED)) return;
      if (cB >= 0 && String(r[cB] || '').trim()) return;           // really booked — leave it
      var id = String(r[cI] || '').trim(); if (!id) return;
      var cand = {}; H.forEach(function (h, j) { cand[h] = r[j]; });
      _setBothStatuses_(id, STATUS.AUTO_BOOK_SENT,
        'Repaired 9/26/26: invite was sent but no booking recorded yet — status corrected so the booking is picked up.');
      if (typeof LIVEADV_recordManualRelease_ === 'function' && !LIVEADV_lastInviteSentFromQueue_(id)) {
        LIVEADV_recordManualRelease_(id, cand, 'full_interview_booking');
      }
      fixed.push(LIVEADV_name_(cand));
    });
    if (typeof pollCalendarBookings === 'function') pollCalendarBookings();
    return fixed.length + ' repaired' + (fixed.length ? ' (' + fixed.join(', ') + ') — calendar re-polled' : '');
  });

  step('Interview Pipeline columns', function () {
    var ip = getSheet_(SHEETS.INTERVIEW_PIPELINE);
    ensureHeaders_(ip, SNAP_COLS);
    var H = getHeaderRow_(ip), hidden = 0;
    SNAP_PHONE_COLUMNS.forEach(function (n) { var c = H.indexOf(n); if (c >= 0) { ip.hideColumns(c + 1); hidden++; } });
    SNAP_COLS.forEach(function (n) { var c = H.indexOf(n); if (c >= 0) ip.showColumns(c + 1); });
    var c1 = H.indexOf('Decision Snapshot'); if (c1 >= 0) ip.setColumnWidth(c1 + 1, 420);
    var arch = getSheetOrNull_(SHEETS.PIPELINE_ARCHIVE);
    if (arch) ensureHeaders_(arch, SNAP_COLS);
    ['Role Rules', 'Hiring Managers'].forEach(function (t) {
      var s = getSheetOrNull_(t); if (!s) return;
      var c = getHeaderRow_(s).indexOf('Phone Screen Booking Link'); if (c >= 0) { s.hideColumns(c + 1); hidden++; }
    });
    return 'hid ' + hidden + ' phone-screen column(s); snapshot columns visible';
  });

  step('Close retired forms (Culture & Style, Technician Skill Test)', function () {
    var reg = getSheetOrNull_(SHEETS.FORM_REGISTRY || 'Form Registry');
    if (!reg) return 'no Form Registry';
    var done = [];
    ['CULTURE_FIT', 'SKILLS_TEST'].forEach(function (key) {
      var hit = findRowsByColumnValue_(reg, 'Form Key', key);
      if (!hit.length) return;
      var editId = String(hit[0].data['Edit ID'] || '').trim();
      if (!editId) return;
      try {
        var f = FormApp.openById(editId);
        f.setAcceptingResponses(false)
         .setCustomClosedFormMessage('This form is no longer used. Everything we need is in the pre-screen you already completed. Questions? Call ' + CFG.get('COMPANY_PHONE', '702-365-9100') + '.');
        batchUpdateRow_(reg, hit[0].rowNum, { 'Active': 'FALSE', 'Notes': 'RETIRED 9/26/26 — folded into the combined pre-screen. Form closed to responses.' });
        done.push(key);
      } catch (e) { done.push(key + ' (could not open: ' + e.message + ')'); }
    });
    return done.join(', ') || 'nothing to close';
  });

  step('Instruction Manual rebuilt', function () {
    if (typeof buildInstructionManual === 'function') { buildInstructionManual(); return 'ok'; }
    return 'builder not found';
  });
  step('Start Here refreshed', function () {
    if (typeof STARTHERE_refreshStatus === 'function') { STARTHERE_refreshStatus(); return 'ok'; }
    return 'n/a';
  });
  step('Decision snapshots filled', function () { return PIPELINE_refreshDecisionSnapshots(); });

  var msg = out.join('\n');
  Logger.log(msg);
  logEvent_('RECRUITING_CLEANUP_RUN_ONCE', '', { result: msg.slice(0, 900) });
  try { toast_('Cleanup done — see Execution log for the checklist.', 'Recruiting OS', 10); } catch (e) {}
  return msg;
}

/** RELEASED row already on the Live Advance Queue for this candidate? */
function LIVEADV_lastInviteSentFromQueue_(candidateId) {
  var q = getSheetOrNull_(typeof LIVEADV_SHEET !== 'undefined' ? LIVEADV_SHEET : 'Live Advance Queue');
  if (!q) return false;
  return findRowsByColumnValue_(q, 'Candidate ID', candidateId).some(function (h) {
    return String(h.data['Status'] || '').toUpperCase() === 'RELEASED';
  });
}

function SNAP_selfTest() {
  var out = ['[SNAP] selfTest (read-only)'];
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var H = ip ? getHeaderRow_(ip) : [];
  SNAP_COLS.forEach(function (c) { out.push('  ' + (H.indexOf(c) >= 0 ? '✓' : '✗') + ' column ' + c); });
  out.push('  ─ DECISION_ADVANCE_PHONE = "' + CFG.get('DECISION_ADVANCE_PHONE', '') + '" (blank = retired)');
  var tSh = getSheetOrNull_(SHEETS.EMAIL_TEMPLATES);
  SNAP_RETIRED_TEMPLATES.forEach(function (k) {
    var has = tSh && findRowsByColumnValue_(tSh, 'Template Key', k).length;
    out.push('  ' + (has ? '✗ still present' : '✓ retired') + ' template ' + k);
  });
  out.push('  ─ invite template for Technician: ' + (typeof LIVEADV_templateFor_ === 'function' ? LIVEADV_templateFor_('Technician') : '?'));
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
