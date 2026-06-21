/**
 * 15_Daily_Digest.gs
 * Frank's European Service — Recruiting OS
 *
 * Single morning email to the hiring manager — the only thing they need to
 * read first thing each day. Per the project's manual-workload rule, this
 * is item #1 of the manager's five daily actions.
 *
 * Sections:
 *   1) KPI cards: total applied today/week, pending decisions, stuck candidates
 *   2) Action items: candidates needing manager decision NOW (Status=MANUAL_REVIEW
 *      with Final Recommendation set)
 *   3) New transcripts graded since last digest
 *   4) Pre-screen queue & high-score candidates
 *   5) System health snapshot (errors past 24h, pending emails)
 *
 * Public functions:
 *   runDailyDigest()       — daily time trigger calls this
 *   DIGEST_previewHtml()   — dry run; returns HTML, sends nothing
 *   DIGEST_sendNow()       — manual fire
 */

/** "Morning Brief" before noon (shop time), otherwise "Afternoon Update". */
function _digestPeriodLabel_() {
  var hr = parseInt(Utilities.formatDate(new Date(), _tz_(), 'H'), 10);
  return (isNaN(hr) || hr < 12) ? 'Morning Brief' : 'Afternoon Update';
}

function runDailyDigest() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('runDailyDigest', 'OK');
  if (!CFG.getBool('DAILY_DIGEST_ENABLED', true)) return '[DIGEST] disabled in Config';
  return withLockOrSkip_('runDailyDigest', function () {
    var html = buildDigestHtml_();
    var period = _digestPeriodLabel_();
    var subj = CFG.get('SHOP_NAME', "Frank's") + ' — Recruiting ' + period + ' — ' + shopDate_();
    var recipient = CFG.get('DIGEST_RECIPIENT_EMAIL') || CFG.get('HIRING_MANAGER_EMAIL');
    var qid = queueEmail_({
      to:           recipient,
      subject:      subj,
      body:         _digestPlainFallback_(html),
      htmlBody:     html,
      templateKey:  '__daily_digest__',
      reason:       'daily digest'
    });
    var sh = getSheetOrNull_(SHEETS.DAILY_DIGEST_LOG);
    if (sh) appendRowByHeader_(sh, {
      'Timestamp':  shopDateTime_(),
      'Recipient':  recipient,
      'Subject':    subj,
      'Items Count': _digestItemsCount_(),
      'Status':     'QUEUED',
      'Message ID': qid,
      'Notes':      ''
    });
    return '[DIGEST] queued Q=' + qid + ' to ' + recipient;
  });
}

function DIGEST_sendNow() {
  return safeRun_('DIGEST_sendNow', function () {
    var html = buildDigestHtml_();
    var subj = CFG.get('SHOP_NAME', "Frank's") + ' — Recruiting Daily Digest — ' + shopDate_();
    var to   = CFG.get('DIGEST_RECIPIENT_EMAIL') || CFG.get('HIRING_MANAGER_EMAIL');
    // Honor the global kill switch even on a manual "send now" (the digest is the
    // one direct-send path; without this it ignores SEND_ENABLED entirely).
    if (!CFG.getBool('SEND_ENABLED', true)) {
      toast_('SEND_ENABLED is FALSE — digest not sent. Preview only.', 'Recruiting OS', 6);
      return '[DIGEST] DIGEST_sendNow skipped — SEND_ENABLED=FALSE';
    }
    // F17: honor the TEST-mode recipient rule even on a direct "send now" so the
    // digest never leaks to the real manager address under a mode the rest of the
    // system is rerouting. The digest is internal, so actualRecipient_ resolves to
    // the recipient in LIVE and to TEST_RECIPIENT_EMAIL in TEST.
    var routed = actualRecipient_(to) || to;
    // Send directly — bypasses the queue and quiet hours so "send now" means NOW.
    GmailApp.sendEmail(routed, subj, _digestPlainFallback_(html), {
      htmlBody: html,
      name:    CFG.get('EMAIL_FROM_NAME', "Frank's Recruiting Team"),
      replyTo: CFG.get('DEFAULT_REPLY_TO_EMAIL', '')
    });
    toast_('Daily digest sent to ' + routed, 'Recruiting OS', 6);
    Logger.log('[DIGEST] DIGEST_sendNow — sent directly to ' + routed + ' (intended ' + to + ')');
  });
}

function DIGEST_previewHtml() {
  var html = buildDigestHtml_();
  Logger.log('[DIGEST] preview length=' + html.length + ' chars');
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildDigestHtml_() {
  var kpi    = _digestKpis_();
  var action = _digestActionItems_();
  var trans  = _digestRecentTranscripts_();
  var top    = _digestTopCandidates_();
  var health = _digestHealth_();
  var leads     = _digestNewLeads_();
  var aiFails   = _digestAiFailures_();
  var backfillQ = _digestBackfillReview_();
  var todayIv   = _digestTodaysInterviews_();
  var unmatched = _digestUnmatchedTranscripts_();
  var aiAuthor  = _digestAiAuthoredSuspects_();
  var refs      = _digestReferenceStatus_();
  var skipped   = _digestSkippedTranscripts_();

  var css = 'font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;';
  var hd  = 'style="background:#0b3d2e;color:#fff;padding:14px 18px;border-radius:6px 6px 0 0;font-size:18px;font-weight:600;"';
  var sec = 'style="background:#fff;border:1px solid #e4e6e8;border-top:0;border-radius:0 0 6px 6px;padding:14px 18px;margin-bottom:18px;"';
  var th  = 'style="text-align:left;padding:6px 10px;background:#f3f4f6;border-bottom:1px solid #e4e6e8;font-size:12px;text-transform:uppercase;color:#555;"';
  var td  = 'style="padding:6px 10px;border-bottom:1px solid #f0f0f0;"';

  function section(title, content) {
    return '<div style="margin-bottom:0;">' +
             '<div ' + hd + '>' + escapeHtml_(title) + '</div>' +
             '<div ' + sec + '>' + content + '</div>' +
           '</div>';
  }

  function table(headers, rows) {
    if (!rows.length) return '<div style="color:#666;font-style:italic;">(nothing to show)</div>';
    var h = '<thead><tr>' + headers.map(function (h) { return '<th ' + th + '>' + escapeHtml_(h) + '</th>'; }).join('') + '</tr></thead>';
    var b = '<tbody>' + rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td ' + td + '>' + escapeHtml_(String(c == null ? '' : c)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return '<table style="width:100%;border-collapse:collapse;">' + h + b + '</table>';
  }

  var kpiHtml = '<table style="width:100%;border-collapse:separate;border-spacing:6px;"><tr>' +
    kpi.map(function (k) {
      return '<td style="background:#f3f4f6;padding:12px;border-radius:4px;width:25%;vertical-align:top;">' +
               '<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">' + escapeHtml_(k.label) + '</div>' +
               '<div style="font-size:24px;font-weight:700;color:#0b3d2e;">' + escapeHtml_(String(k.value)) + '</div>' +
               (k.sub ? '<div style="font-size:11px;color:#888;">' + escapeHtml_(k.sub) + '</div>' : '') +
             '</td>';
    }).join('') + '</tr></table>';

  return '<div style="' + css + '">' +
    '<h2 style="margin:0 0 16px 0;color:#0b3d2e;">Recruiting Daily Digest</h2>' +
    '<div style="color:#666;margin-bottom:18px;">' + escapeHtml_(shopDateTime_()) + ' · Mode: ' +
       (isLiveMode_() ? '<b style="color:#0b3d2e;">LIVE</b>' : '<b style="color:#b25e09;">TEST</b>') + '</div>' +
    section('KPIs', kpiHtml) +
    section('Action items — pick a Manager Decision', table(
      ['Candidate', 'Role', 'Score', 'Risk', 'Recommendation', 'Status'],
      action.map(function (a) { return [a.name, a.role, a.score, a.risk, a.recommendation, a.status]; })
    )) +
    section('Recently graded transcripts', table(
      ['Candidate', 'Role', 'Phase', 'AI Score', 'Risk', 'Date'],
      trans.map(function (t) { return [t.name, t.role, t.phase, t.score, t.risk, t.date]; })
    )) +
    section('Top scoring candidates (not yet decided)', table(
      ['Candidate', 'Role', 'Pre-Screen', 'Tier', 'Status'],
      top.map(function (c) { return [c.name, c.role, c.score, c.tier, c.status]; })
    )) +
    section('Today’s interviews & worksheets', table(
      ['Candidate', 'Role', 'Interview Type', 'Time', 'Worksheet Email'],
      todayIv.map(function (t) { return [t.name, t.role, t.type, t.time, t.emailStatus]; })
    )) +
    section('New email leads (Indeed / ACT) & pre-screen invites', table(
      ['Candidate', 'Source', 'Role', 'Email', 'Invite Status'],
      leads.map(function (l) { return [l.name, l.source, l.role, l.email, l.inviteStatus]; })
    )) +
    section('Reference pipeline', table(
      ['Candidate', 'Role', 'Status', 'Since'],
      refs.map(function (r) { return [r.name, r.role, r.status, r.days]; })
    )) +
    section('AI grading failures — needs manual review', table(
      ['Candidate', 'Role', 'Status', 'Detail'],
      aiFails.map(function (a) { return [a.name, a.role, a.status, a.note]; })
    )) +
    section('Suspected AI-authored pre-screens — probe specifics in person', table(
      ['Candidate', 'Role', 'AI-Authored', 'Why', 'Status'],
      aiAuthor.map(function (a) { return [a.name, a.role, a.score, a.reason, a.status]; })
    )) +
    section('Backfill review queue — unresolved', table(
      ['Source', 'Candidate Hint', 'Email', 'Issue'],
      backfillQ.map(function (b) { return [b.source, b.hint, b.email, b.issue]; })
    )) +
    section('Unmatched transcripts — need a candidate', table(
      ['Meeting Title', 'Meeting Date', 'Participants'],
      unmatched.map(function (u) { return [u.title, u.date, u.participants]; })
    )) +
    section('Skipped transcripts (short / parked / failed) — review', table(
      ['Meeting Title', 'Meeting Date', 'Reason', 'Detail'],
      skipped.map(function (s) { return [s.title, s.date, s.reason, s.detail]; })
    )) +
    section('System health (past 24h)', table(
      ['Metric', 'Count'],
      health.map(function (h) { return [h.label, h.value]; })
    )) +
    '<div style="color:#888;font-size:11px;margin-top:8px;">Powered by Recruiting OS · ' +
      escapeHtml_(CFG.get('SHOP_NAME')) + '</div>' +
  '</div>';
}

function _digestPlainFallback_(html) {
  return _htmlToPlain_(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA QUERIES
// ─────────────────────────────────────────────────────────────────────────────

function _digestKpis_() {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var totalApplied = ac ? Math.max(0, ac.getLastRow() - 1) : 0;
  var todayCount = _countWhere_(ac, 'Date Received', function (v) {
    return shopDate_(v) === shopDate_();
  });
  var pendingDecisions = _countWhere_(ip, 'Status', function (v) {
    return v === STATUS.MANUAL_REVIEW || v === STATUS.RECOMMENDED;
  });
  var stuck = _countStuck_(ac, CFG.getInt('STUCK_CANDIDATE_DAYS', 5));

  return [
    { label: 'Total applied',      value: totalApplied,    sub: 'all-time' },
    { label: 'New today',          value: todayCount,      sub: shopDate_() },
    { label: 'Pending decisions',  value: pendingDecisions, sub: 'manager action needed' },
    { label: 'Stuck candidates',   value: stuck,            sub: '>' + CFG.getInt('STUCK_CANDIDATE_DAYS', 5) + ' days no update' }
  ];
}

function _digestActionItems_() {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return [];
  var last = ip.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(ip);
  var hStatus = headers.indexOf('Status');
  var hName   = headers.indexOf('Full Name');
  var hFirst  = headers.indexOf('First Name');
  var hLast   = headers.indexOf('Last Name');
  var hRole   = headers.indexOf('Role');
  var hScore  = headers.indexOf('Score');
  var hRisk   = headers.indexOf('Risk Score');
  var hRec    = headers.indexOf('Final Recommendation');
  var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var st = String(data[i][hStatus] || '');
    if (st !== STATUS.MANUAL_REVIEW && st !== STATUS.RECOMMENDED) continue;
    var name = (hName !== -1 && data[i][hName]) ? data[i][hName] :
               String((hFirst !== -1 ? data[i][hFirst] || '' : '') + ' ' +
                      (hLast !== -1 ? data[i][hLast] || '' : '')).trim();
    out.push({
      name: name,
      role: hRole !== -1 ? data[i][hRole] : '',
      score: hScore !== -1 ? data[i][hScore] : '',
      risk: hRisk !== -1 ? data[i][hRisk] : '',
      recommendation: hRec !== -1 ? data[i][hRec] : '',
      status: st
    });
  }
  // Newest first
  return out.slice(-10).reverse();
}

function _digestRecentTranscripts_() {
  var sh = getSheetOrNull_(SHEETS.TRANSCRIPT_ARCHIVE);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iName = headers.indexOf('Candidate Name');
  var iRole = headers.indexOf('Role');
  var iPhs  = headers.indexOf('Phase');
  var iScr  = headers.indexOf('AI Score');
  var iRsk  = headers.indexOf('AI Risk Score');
  var iWhen = headers.indexOf('Archived At');
  var out = [];
  // Last 7 with a non-blank AI Score
  for (var i = data.length - 1; i >= 0 && out.length < 7; i--) {
    var s = data[i][iScr];
    if (s === '' || s === null) continue;
    out.push({
      name:  iName !== -1 ? data[i][iName] : '',
      role:  iRole !== -1 ? data[i][iRole] : '',
      phase: iPhs  !== -1 ? data[i][iPhs]  : '',
      score: s,
      risk:  iRsk  !== -1 ? data[i][iRsk]  : '',
      date:  iWhen !== -1 ? data[i][iWhen] : ''
    });
  }
  return out;
}

function _digestTopCandidates_() {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return [];
  var last = ac.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var iName  = headers.indexOf('First Name');
  var iLast  = headers.indexOf('Last Name');
  var iRole  = headers.indexOf('Role');
  var iScore = headers.indexOf('Total Score');
  var iTier  = headers.indexOf('Score Tier');
  var iStat  = headers.indexOf('Status');
  var rows = data.map(function (r) {
    return {
      name:  String((iName !== -1 ? r[iName] || '' : '') + ' ' + (iLast !== -1 ? r[iLast] || '' : '')).trim(),
      role:  iRole !== -1 ? r[iRole] : '',
      score: parseFloat(iScore !== -1 ? r[iScore] : '0') || 0,
      tier:  iTier !== -1 ? r[iTier] : '',
      status: iStat !== -1 ? r[iStat] : ''
    };
  }).filter(function (x) {
    return x.score > 0 && x.status !== STATUS.HIRED && x.status !== STATUS.REJECTED &&
           x.status !== STATUS.ARCHIVED && x.status !== STATUS.IN_DRAWER;
  });
  rows.sort(function (a, b) { return b.score - a.score; });
  return rows.slice(0, 10);
}

function _digestHealth_() {
  var errCount = _countSince_(getSheetOrNull_(SHEETS.ERROR_LOG), 'Timestamp', 24);
  var evtCount = _countSince_(getSheetOrNull_(SHEETS.EVENT_LOG), 'Timestamp', 24);
  var eq = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  var pending = _countWhere_(eq, 'Status', function (v) { return v === 'PENDING'; });
  var sent24  = _countSince_(eq, 'Sent At', 24);
  // F2/F18/F24: the real risk surface, on the morning email.
  var blocked = (typeof queueBlockedCount_ === 'function') ? queueBlockedCount_() : 0;
  var backlog = (typeof queueBacklogDue_ === 'function') ? queueBacklogDue_() : 0;
  var trg     = (typeof assertTriggerSet_ === 'function') ? assertTriggerSet_() : { ok: true, missing: [] };
  var ai      = (typeof assertAiReady_ === 'function') ? assertAiReady_() : { ok: true, detail: '' };
  return [
    { label: 'Errors past 24h',       value: errCount },
    { label: 'Events past 24h',       value: evtCount },
    { label: 'Pending emails (due)',  value: backlog },
    { label: 'Pending emails (all)',  value: pending },
    { label: 'BLOCKED emails',        value: blocked + (blocked ? '  ⚠ run Recover Blocked Email Queue' : '') },
    { label: 'Emails sent past 24h',  value: sent24 },
    { label: 'Triggers missing',      value: trg.ok ? '0' : (trg.missing.length + '  ⚠ ' + trg.missing.join(', ')) },
    { label: 'AI grading',            value: ai.ok ? 'ready' : ('⚠ ' + ai.detail) }
  ];
}

function _digestItemsCount_() {
  return _digestActionItems_().length;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _digestNewLeads_() {
  var sh = getSheetOrNull_(SHEETS.RAW_HIRING_EMAIL_LEADS);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iT = headers.indexOf('Timestamp'), iN = headers.indexOf('Candidate Name'),
      iS = headers.indexOf('Source'), iR = headers.indexOf('Role Applied'),
      iE = headers.indexOf('Candidate Email'), iI = headers.indexOf('Pre-Screen Invite Status');
  var out = [];
  for (var i = data.length - 1; i >= 0 && out.length < 15; i--) {
    if (iT !== -1 && shopDate_(data[i][iT]) !== shopDate_()) continue;
    out.push({ name: iN !== -1 ? data[i][iN] : '', source: iS !== -1 ? data[i][iS] : '',
      role: iR !== -1 ? data[i][iR] : '', email: iE !== -1 ? data[i][iE] : '',
      inviteStatus: iI !== -1 ? (data[i][iI] || 'pending') : '' });
  }
  return out;
}

function _digestAiFailures_() {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return [];
  var last = ac.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(ac);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var iF = headers.indexOf('First Name'), iL = headers.indexOf('Last Name'),
      iR = headers.indexOf('Role'), iSt = headers.indexOf('Status'), iNo = headers.indexOf('Notes');
  var out = [];
  for (var i = 0; i < data.length && out.length < 15; i++) {
    var note = iNo !== -1 ? String(data[i][iNo] || '') : '';
    if (note.indexOf('AI scoring failed') !== 0) continue;
    out.push({ name: String((iF !== -1 ? data[i][iF] || '' : '') + ' ' + (iL !== -1 ? data[i][iL] || '' : '')).trim(),
      role: iR !== -1 ? data[i][iR] : '', status: iSt !== -1 ? data[i][iSt] : '', note: truncate_(note, 120) });
  }
  return out;
}

function _digestBackfillReview_() {
  var sh = getSheetOrNull_(SHEETS.BACKFILL_REVIEW);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iSrc = headers.indexOf('Source Sheet'), iH = headers.indexOf('Candidate Hint'),
      iE = headers.indexOf('Email'), iIss = headers.indexOf('Issue'), iRes = headers.indexOf('Resolved Candidate ID');
  var out = [];
  for (var i = 0; i < data.length && out.length < 15; i++) {
    if (iRes !== -1 && String(data[i][iRes] || '').trim()) continue; // resolved
    out.push({ source: iSrc !== -1 ? data[i][iSrc] : '', hint: iH !== -1 ? data[i][iH] : '',
      email: iE !== -1 ? data[i][iE] : '', issue: iIss !== -1 ? data[i][iIss] : '' });
  }
  return out;
}

function _digestTodaysInterviews_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_WORKSHEETS);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iN = headers.indexOf('Candidate Name'), iR = headers.indexOf('Role'),
      iTy = headers.indexOf('Interview Type'), iD = headers.indexOf('Interview Date'),
      iTime = headers.indexOf('Scheduled Time'), iES = headers.indexOf('Email Status');
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (iD !== -1 && shopDate_(data[i][iD]) !== shopDate_()) continue;
    out.push({ name: iN !== -1 ? data[i][iN] : '', role: iR !== -1 ? data[i][iR] : '',
      type: iTy !== -1 ? data[i][iTy] : '', time: iTime !== -1 ? data[i][iTime] : '',
      emailStatus: iES !== -1 ? data[i][iES] : '' });
  }
  return out;
}

function _digestAiAuthoredSuspects_() {
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return [];
  var last = ac.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(ac);
  var iL = headers.indexOf('AI-Authored Likelihood');
  if (iL === -1) return [];
  var iR = headers.indexOf('AI-Authored Reasoning');
  var iF = headers.indexOf('First Name'), iLn = headers.indexOf('Last Name'),
      iRole = headers.indexOf('Role'), iSt = headers.indexOf('Status');
  var threshold = CFG.getInt('AI_AUTHORED_LIKELIHOOD_THRESHOLD', 70);
  var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < data.length && out.length < 15; i++) {
    var s = parseInt(data[i][iL], 10);
    if (isNaN(s) || s < threshold) continue;
    out.push({
      name:   String((iF !== -1 ? data[i][iF] || '' : '') + ' ' + (iLn !== -1 ? data[i][iLn] || '' : '')).trim(),
      role:   iRole !== -1 ? data[i][iRole] : '',
      score:  s,
      reason: iR !== -1 ? truncate_(String(data[i][iR] || ''), 150) : '',
      status: iSt !== -1 ? data[i][iSt] : ''
    });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

// F12: short / failed / parked transcripts that were SKIPPED — surfaced so they
// are visible and reviewable rather than dropped silently.
function _digestSkippedTranscripts_() {
  var sh = getSheetOrNull_(SHEETS.RAW_OTTER_INTAKE);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iPs = headers.indexOf('Processed Status'), iTit = headers.indexOf('Meeting Title'),
      iD = headers.indexOf('Meeting Date'), iOut = headers.indexOf('Routing Outcome'),
      iErr = headers.indexOf('Error');
  var out = [];
  for (var i = data.length - 1; i >= 0 && out.length < 15; i--) {
    if (iPs === -1 || String(data[i][iPs]).trim().toUpperCase() !== 'SKIPPED') continue;
    out.push({
      title:  iTit !== -1 ? data[i][iTit] : '',
      date:   iD   !== -1 ? data[i][iD]   : '',
      reason: iOut !== -1 ? data[i][iOut] : '',
      detail: iErr !== -1 ? truncate_(String(data[i][iErr] || ''), 80) : ''
    });
  }
  return out;
}

function _digestUnmatchedTranscripts_() {
  var sh = getSheetOrNull_(SHEETS.RAW_OTTER_INTAKE);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(sh);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var iPs = headers.indexOf('Processed Status'), iTit = headers.indexOf('Meeting Title'),
      iD = headers.indexOf('Meeting Date'), iP = headers.indexOf('Participants');
  var out = [];
  for (var i = data.length - 1; i >= 0 && out.length < 15; i--) {
    if (iPs === -1 || String(data[i][iPs]) !== 'UNMATCHED') continue;
    out.push({ title: iTit !== -1 ? data[i][iTit] : '', date: iD !== -1 ? data[i][iD] : '',
      participants: iP !== -1 ? truncate_(String(data[i][iP] || ''), 60) : '' });
  }
  return out;
}

function _digestReferenceStatus_() {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return [];
  var last = ip.getLastRow();
  if (last < 2) return [];
  var headers = getHeaderRow_(ip);
  var hStatus = headers.indexOf('Status');
  var hFirst  = headers.indexOf('First Name');
  var hLast   = headers.indexOf('Last Name');
  var hName   = headers.indexOf('Full Name');
  var hRole   = headers.indexOf('Role');
  var hUpd    = headers.indexOf('Last Updated');
  if (hStatus === -1) return [];
  var data = ip.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  var now = Date.now();
  for (var i = 0; i < data.length; i++) {
    var st = String(data[i][hStatus] || '');
    if (st !== STATUS.REFS_REQUESTED && st !== STATUS.REFS_PENDING && st !== STATUS.REFS_COMPLETE) continue;
    var name = (hName !== -1 && data[i][hName]) ? data[i][hName] :
               String((hFirst !== -1 ? data[i][hFirst] || '' : '') + ' ' +
                      (hLast  !== -1 ? data[i][hLast]  || '' : '')).trim();
    var updDate = hUpd !== -1 ? _coerceDate_(data[i][hUpd]) : new Date(0);
    var ms = now - updDate.getTime();
    var daysElapsed = ms > 0 ? Math.floor(ms / 86400000) : 0;
    out.push({
      name:   name,
      role:   hRole !== -1 ? String(data[i][hRole] || '') : '',
      status: st,
      days:   daysElapsed > 0 ? daysElapsed + 'd ago' : 'today'
    });
  }
  return out;
}

function _countWhere_(sheet, columnName, predicate) {
  if (!sheet) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var col = getColIndex_(sheet, columnName);
  if (!col) return 0;
  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < values.length; i++) if (predicate(values[i][0])) n++;
  return n;
}

function _countSince_(sheet, timestampCol, hours) {
  if (!sheet) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var col = getColIndex_(sheet, timestampCol);
  if (!col) return 0;
  var cutoff = Date.now() - hours * 3600 * 1000;
  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < values.length; i++) {
    var t = _coerceDate_(values[i][0]).getTime();
    if (t >= cutoff) n++;
  }
  return n;
}

function _countStuck_(sheet, days) {
  if (!sheet) return 0;
  var col = getColIndex_(sheet, 'Last Updated');
  if (!col) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var cutoff = Date.now() - days * 24 * 3600 * 1000;
  var values = sheet.getRange(2, col, last - 1, 1).getValues();
  var stat = getColIndex_(sheet, 'Status');
  var statusVals = stat ? sheet.getRange(2, stat, last - 1, 1).getValues() : [];
  var n = 0;
  for (var i = 0; i < values.length; i++) {
    var s = stat ? String(statusVals[i][0]) : '';
    if (s === STATUS.HIRED || s === STATUS.REJECTED || s === STATUS.ARCHIVED) continue;
    var t = _coerceDate_(values[i][0]).getTime();
    if (t > 0 && t < cutoff) n++;
  }
  return n;
}
