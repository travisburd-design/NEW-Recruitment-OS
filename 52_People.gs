/**
 * 52_People.gs
 * Frank's European Service — Recruiting OS
 *
 * ONE PERSON = ONE RECORD, AND A DO-NOT-CONTACT LIST THAT IS ACTUALLY ENFORCED.
 * (Built 9/25/26 after Travis found duplicates, former employees re-entering the
 * pipeline, and no way to protect a candidate he booked by phone.)
 *
 * 1) PEOPLE REGISTRY tab — everyone the automation must never treat as a fresh
 *    applicant. Flag values:
 *        Current Employee | Former Employee | Do Not Contact | Cleared to Apply
 *    • Synced daily from the payroll workbook (Employee_Master + Employee_Archive).
 *    • Manual rows (Source = Manual / Confirm Hire) always win over payroll.
 *    • "Confirm Hire" adds the person automatically as Current Employee.
 *    • Anyone matched (email, phone, or name incl. nicknames/aliases):
 *        - gets NO candidate email (hard gate inside queueEmail_)
 *        - never lands on the Interview Pipeline (gate in _ensureInterviewPipelineRow_)
 *        - is held (All Candidates Status = REGISTRY_HOLD) and shown in the digest
 *    • To let a former employee through, set their Flag to "Cleared to Apply".
 *
 * 2) ONE RECORD PER PERSON — PEOPLE_findPerson_ matches by real email (any role),
 *    phone, then name (nickname-aware). Intake + lead import reuse the existing
 *    record and add the role to "Roles Applied" instead of creating a new person.
 *    PEOPLE_mergeDuplicates merges existing duplicates (losers are moved to the
 *    "Merged Duplicates" tab — nothing is lost).
 *
 * 3) MANUAL INTERVIEW — Manager Decision "Interview Booked (Manual)" or the
 *    "Quick Add Candidate" menu → Status INTERVIEW_BOOKED. Protected: never
 *    auto-emailed, auto-advanced, reminded, archived, or re-routed by scoring.
 *
 * Public: PEOPLE_SETUP_RUN_ONCE, PEOPLE_previewCleanup, PEOPLE_applyCleanup,
 *         PEOPLE_daily, PEOPLE_syncRegistry, PEOPLE_mergeDuplicates,
 *         PEOPLE_openQuickAdd, PEOPLE_quickAddSubmit, PEOPLE_selfTest
 */

var PEOPLE_SHEET        = 'People Registry';
var PEOPLE_MERGED_SHEET = 'Merged Duplicates';
var PEOPLE_HEADERS = ['Person Name', 'Aliases', 'Email', 'Alt Emails', 'Phone', 'Flag', 'Rehire Eligible',
  'Role / Dept', 'Start Date', 'End Date', 'Source', 'Last Applied', 'Last Applied Role', 'Times Applied',
  'Notes', 'Last Synced'];
var PEOPLE_FLAGS = ['Current Employee', 'Former Employee', 'Do Not Contact', 'Cleared to Apply'];

var STATUS_INTERVIEW_BOOKED = 'INTERVIEW_BOOKED';
var STATUS_REGISTRY_HOLD    = 'REGISTRY_HOLD';

var PEOPLE_PAYROLL_ID_DEFAULT = '1NlsTGSFaJPOOGnB4na0LddjsFWaChfUqxqRTvR0hrdQ';

// Candidate is past the automated stage — scoring / lead import must never
// change their status or email them automatically.
var PEOPLE_PROTECTED_STATUSES = {
  'INTERVIEW_BOOKED': 1, 'PHONE_BOOKED': 1, 'PHONE_DONE': 1, 'FULL_BOOKED': 1, 'FULL_DONE': 1,
  'WORKING_SCHEDULED': 1, 'REFS_REQUESTED': 1, 'REFS_PENDING': 1, 'REFS_COMPLETE': 1,
  'RECOMMENDED': 1, 'OFFER_PENDING': 1, 'HIRED': 1, 'REGISTRY_HOLD': 1
};

// Automated candidate templates blocked for a protected (manually handled) candidate.
var PEOPLE_AUTO_TEMPLATES = {
  'application_confirmation': 1, 'prescreen_invite': 1, 'prescreen_reminder_technician': 1,
  'phone_screen_booking': 1, 'we_are_reviewing': 1, 'technician_post_prescreen': 1,
  'not_currently_hiring': 1, 'live_interview_booking': 1, 'live_interview_booking_technician': 1,
  'live_interview_booking_reminder': 1, 'live_interview_no_response_close': 1
};

// Nickname → canonical first name.
var PEOPLE_NICK = {
  tony: 'anthony', ant: 'anthony', antonio: 'anthony', mike: 'michael', mikey: 'michael', mick: 'michael',
  bill: 'william', billy: 'william', will: 'william', willy: 'william', liam: 'william', buddy: 'william',
  bob: 'robert', bobby: 'robert', rob: 'robert', robbie: 'robert', bert: 'robert',
  jim: 'james', jimmy: 'james', jimmie: 'james', jamie: 'james',
  joe: 'joseph', joey: 'joseph', jose: 'jose', chris: 'christopher', topher: 'christopher',
  matt: 'matthew', mat: 'matthew', mathew: 'matthew', dave: 'david', davey: 'david',
  dan: 'daniel', danny: 'daniel', alex: 'alexander', al: 'alexander', xander: 'alexander',
  nick: 'nicholas', nicky: 'nicholas', steve: 'steven', stephen: 'steven', stevie: 'steven',
  tom: 'thomas', tommy: 'thomas', jon: 'jonathan', johnny: 'john', jack: 'john',
  ed: 'edward', eddie: 'edward', eddy: 'edward', rick: 'richard', ricky: 'richard', rich: 'richard',
  richie: 'richard', dick: 'richard', andy: 'andrew', drew: 'andrew', josh: 'joshua',
  ben: 'benjamin', benny: 'benjamin', sam: 'samuel', sammy: 'samuel', greg: 'gregory',
  jeff: 'jeffrey', jeffery: 'jeffrey', geoff: 'jeffrey', ken: 'kenneth', kenny: 'kenneth',
  ray: 'raymond', tim: 'timothy', timmy: 'timothy', sonja: 'sonia', sonya: 'sonia',
  gabe: 'gabriel', manny: 'manuel', rafa: 'raphael', rafael: 'raphael', frankie: 'frank',
  fran: 'francis', pat: 'patrick', paddy: 'patrick', larry: 'lawrence', vince: 'vincent',
  zach: 'zachary', zack: 'zachary', kate: 'katherine', katie: 'katherine', kathy: 'katherine',
  liz: 'elizabeth', beth: 'elizabeth', becky: 'rebekah', rebecca: 'rebekah', jen: 'jennifer',
  jenny: 'jennifer', vlad: 'vladimir', hank: 'henry', harry: 'henry', charlie: 'charles',
  chuck: 'charles', sal: 'salvador', lou: 'louis', luis: 'luis'
};

// ─────────────────────────────────────────────────────────────────────────────
// NAME / KEY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function PEOPLE_nameKey_(first, last) {
  var toks = String((first || '') + ' ' + (last || '')).toLowerCase()
    .replace(/[—–].*$/, ' ')                          // "Travis Burd — Frank's…" → name only
    .replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '').split(/\s+/).filter(Boolean)
    .filter(function (t) { return !/^(jr|sr|ii|iii|iv|v)$/.test(t); });
  if (!toks.length) return { first: '', last: '', key: '' };
  var f = toks[0], l = toks.length > 1 ? toks[toks.length - 1] : '';
  var cf = PEOPLE_NICK[f] || f;
  return { first: cf, last: l, key: (cf && l) ? cf + ' ' + l : '' };
}

function PEOPLE_emailKey_(email) {
  var e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return '';
  if (/@indeedemail\.com$/.test(e) || /^conversation-/.test(e)) return '';
  if (/no-?reply|notification/.test(e)) return '';
  return e;
}

function PEOPLE_phoneKey_(p) {
  var d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function _PEOPLE_stageRank_(st) {
  st = String(st || '').toUpperCase();
  if (st === 'INTERVIEW_BOOKED') return 7;
  if (st === 'REGISTRY_HOLD') return 3;
  return (typeof _DEDUP_STAGE_RANK !== 'undefined' && _DEDUP_STAGE_RANK[st]) || 0;
}

function PEOPLE_isProtectedStatus_(status) {
  return !!PEOPLE_PROTECTED_STATUSES[String(status || '').trim().toUpperCase()];
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY (read with a per-execution cache)
// ─────────────────────────────────────────────────────────────────────────────

var _PEOPLE_REG_CACHE_ = null;
function PEOPLE_clearCache_() { _PEOPLE_REG_CACHE_ = null; }

function _PEOPLE_ensureRegistry_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PEOPLE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PEOPLE_SHEET);
    sh.getRange(1, 1, 1, PEOPLE_HEADERS.length).setValues([PEOPLE_HEADERS]).setFontWeight('bold')
      .setBackground('#7f1d1d').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange(2, 6, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(PEOPLE_FLAGS, true).setAllowInvalid(false).build());
    sh.getRange(2, 7, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Yes', 'No', 'Review'], true).build());
    sh.setColumnWidth(1, 180); sh.setColumnWidth(15, 320);
    try { sh.setTabColor('#7f1d1d'); } catch (e) {}
  }
  return sh;
}

function _PEOPLE_readRegistry_() {
  if (_PEOPLE_REG_CACHE_) return _PEOPLE_REG_CACHE_;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PEOPLE_SHEET);
  var out = { rows: [], byEmail: {}, byPhone: {}, byName: {} };
  if (!sh || sh.getLastRow() < 2) { _PEOPLE_REG_CACHE_ = out; return out; }
  var headers = getHeaderRow_(sh);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  data.forEach(function (r, i) {
    var name = String(r[H['Person Name']] || '').trim();
    if (!name) return;
    var rec = {
      rowNum: i + 2, name: name, flag: String(r[H['Flag']] || '').trim(),
      rehire: String(r[H['Rehire Eligible']] || '').trim(), source: String(r[H['Source']] || '').trim(),
      email: String(r[H['Email']] || '').trim()
    };
    out.rows.push(rec);
    var emails = [r[H['Email']]].concat(String(r[H['Alt Emails']] || '').split(','));
    emails.forEach(function (e) { var k = PEOPLE_emailKey_(e); if (k) out.byEmail[k] = rec; });
    var p = PEOPLE_phoneKey_(r[H['Phone']]); if (p) out.byPhone[p] = rec;
    [name].concat(String(r[H['Aliases']] || '').split(',')).forEach(function (n) {
      var k = PEOPLE_nameKey_(n, '').key; if (k) out.byName[k] = rec;
    });
  });
  _PEOPLE_REG_CACHE_ = out;
  return out;
}

/**
 * Registry row that blocks this person, or null. "Cleared to Apply" never blocks.
 * @param {{email?, phone?, firstName?, lastName?, name?}} who
 */
function PEOPLE_registryMatch_(who) {
  who = who || {};
  var reg = _PEOPLE_readRegistry_();
  if (!reg.rows.length) return null;
  var hit = null;
  var e = PEOPLE_emailKey_(who.email);
  if (e && reg.byEmail[e]) hit = reg.byEmail[e];
  var p = PEOPLE_phoneKey_(who.phone);
  if (!hit && p && reg.byPhone[p]) hit = reg.byPhone[p];
  if (!hit) {
    var nk = who.name ? PEOPLE_nameKey_(who.name, '') : PEOPLE_nameKey_(who.firstName, who.lastName);
    if (nk.key && reg.byName[nk.key]) hit = reg.byName[nk.key];
  }
  if (!hit || hit.flag === 'Cleared to Apply' || !hit.flag) return null;
  return hit;
}

/** Registry match for a candidate row object (All Candidates / Pipeline shape). */
function PEOPLE_registryMatchForCandidate_(c) {
  if (!c) return null;
  return PEOPLE_registryMatch_({ email: c['Email'], phone: c['Phone'],
    firstName: c['First Name'], lastName: c['Last Name'],
    name: (!c['First Name'] && c['Full Name']) ? c['Full Name'] : '' });
}

/** Record that a registry person applied again (feeds the digest). */
function PEOPLE_touchRegistry_(rec, role) {
  if (!rec) return;
  try {
    var sh = _PEOPLE_ensureRegistry_();
    var H = getHeaderMap_(sh);
    var times = parseInt(sh.getRange(rec.rowNum, H['times applied']).getValue(), 10) || 0;
    sh.getRange(rec.rowNum, H['last applied']).setValue(shopDateTime_());
    sh.getRange(rec.rowNum, H['last applied role']).setValue(role || '');
    sh.getRange(rec.rowNum, H['times applied']).setValue(times + 1);
  } catch (e) { logError_('PEOPLE_touchRegistry_', e, '', 'WARN'); }
}

/**
 * Hold a candidate because they are on the registry. Writes REGISTRY_HOLD on
 * All Candidates (and removes any Interview Pipeline row), cancels their pending
 * automated emails, and touches the registry row for the digest.
 */
function PEOPLE_holdCandidate_(candidateId, rec, role) {
  var note = 'Held — People Registry: ' + rec.flag + (rec.rehire ? ' (Rehire: ' + rec.rehire + ')' : '') +
             ' — no emails, not on pipeline. ' + shopDateTime_();
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (ac && candidateId) {
    var prev = findRowsByColumnValue_(ac, 'Candidate ID', candidateId);
    var prevNote = prev.length ? String(prev[0].data['Notes'] || '') : '';
    updateRowWhere_(ac, 'Candidate ID', candidateId, { 'Status': STATUS_REGISTRY_HOLD,
      'Notes': (note + (prevNote ? ' | ' + prevNote : '')).slice(0, 480), 'Last Updated': shopDateTime_() });
  }
  if (candidateId) {
    _PEOPLE_removeFromPipeline_(candidateId, STATUS_REGISTRY_HOLD, note);
    _PEOPLE_cancelPending_(candidateId, null);
  }
  PEOPLE_touchRegistry_(rec, role);
  logEvent_('PEOPLE_REGISTRY_HOLD', candidateId || '', { person: rec.name, flag: rec.flag, role: role || '' });
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL GATE — called at the top of queueEmail_ (14_Email_Queue)
// ─────────────────────────────────────────────────────────────────────────────

/** @return {string} a reason to suppress, or '' to allow. */
function PEOPLE_emailSuppressReason_(opts) {
  opts = opts || {};
  var tpl = String(opts.templateKey || '');
  if (tpl.indexOf('__') === 0) return '';                         // internal / manager emails
  var to = PEOPLE_emailKey_(opts.to) || String(opts.to || '').trim().toLowerCase();
  var mgr = [CFG.get('HIRING_MANAGER_EMAIL'), CFG.get('DIGEST_RECIPIENT_EMAIL'), CFG.get('TEST_RECIPIENT_EMAIL')]
    .map(function (x) { return String(x || '').trim().toLowerCase(); });
  if (to && mgr.indexOf(to) !== -1) return '';                    // never block mail to the hiring manager

  var cand = opts.candidateId ? _getCandidateRow_(opts.candidateId) : null;
  var who = cand ? { email: opts.to || cand['Email'], phone: cand['Phone'], firstName: cand['First Name'],
                     lastName: cand['Last Name'] } : { email: opts.to };
  var rec = PEOPLE_registryMatch_(who);
  if (!rec && cand) rec = PEOPLE_registryMatchForCandidate_(cand);
  if (rec) return 'People Registry: ' + rec.name + ' is ' + rec.flag;

  if (cand && PEOPLE_AUTO_TEMPLATES[tpl]) {
    var st = String(cand['Status'] || '').toUpperCase();
    if (st === STATUS_INTERVIEW_BOOKED || st === STATUS_REGISTRY_HOLD || st === 'HIRED') {
      return 'Automated email blocked — candidate status ' + st;
    }
  }
  return '';
}

/** Write a SUPPRESSED row so the block is visible in the Email Queue. */
function PEOPLE_logSuppressed_(opts, reason) {
  var qid = 'Q-' + Utilities.getUuid().substring(0, 8).toUpperCase();
  try {
    appendRowByHeader_(getSheet_(SHEETS.EMAIL_QUEUE), {
      'Queue ID': qid, 'Created At': shopDateTime_(), 'Send At': '', 'To (Intended)': String(opts.to || ''),
      'To (Actual)': '', 'Subject': String(opts.subject || ''), 'Body HTML': '',
      'Template Key': String(opts.templateKey || ''), 'Candidate ID': String(opts.candidateId || ''),
      'Reason': String(opts.reason || ''), 'Status': 'SUPPRESSED', 'Sent At': '', 'Error': '', 'Notes': reason
    });
  } catch (e) {}
  logEvent_('EMAIL_SUPPRESSED', opts.candidateId || '', { templateKey: opts.templateKey || '', reason: reason });
  return qid;
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE RECORD PER PERSON
// ─────────────────────────────────────────────────────────────────────────────

var _PEOPLE_AC_CACHE_ = null;
function _PEOPLE_readAc_(fresh) {
  if (_PEOPLE_AC_CACHE_ && !fresh) return _PEOPLE_AC_CACHE_;
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var headers = getHeaderRow_(ac);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  var data = ac.getLastRow() >= 2 ? ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues() : [];
  _PEOPLE_AC_CACHE_ = { sheet: ac, headers: headers, H: H, data: data };
  return _PEOPLE_AC_CACHE_;
}

function _PEOPLE_rowInfo_(r, H) {
  return {
    cid: String(r[H['Candidate ID']] || '').trim(),
    email: PEOPLE_emailKey_(r[H['Email']]),
    rawEmail: String(r[H['Email']] || '').trim(),
    phone: PEOPLE_phoneKey_(r[H['Phone']]),
    name: PEOPLE_nameKey_(r[H['First Name']], r[H['Last Name']]),
    status: String(r[H['Status']] || '').trim().toUpperCase(),
    role: String(r[H['Role']] || '').trim()
  };
}

/**
 * Same-person rule. Strong keys (real email, phone) link when names don't
 * clearly conflict. A name-only match links unless BOTH sides have a different
 * real email AND a different phone (then it is only a "possible duplicate").
 * @return {string} 'same' | 'possible' | ''
 */
function PEOPLE_compare_(a, b) {
  var nameEq = a.name.key && a.name.key === b.name.key;
  var lastEq = a.name.last && a.name.last === b.name.last;
  var nameConflict = a.name.key && b.name.key && !lastEq;
  if (a.email && a.email === b.email && !nameConflict) return 'same';
  if (a.phone && a.phone === b.phone && !nameConflict) return 'same';
  if (!nameEq) return '';
  var emailsDiffer = a.email && b.email && a.email !== b.email;
  var phonesDiffer = a.phone && b.phone && a.phone !== b.phone;
  if (emailsDiffer && phonesDiffer) return 'possible';
  return 'same';
}

/**
 * Find the existing All Candidates record for this person (any role).
 * @param {{email, phone, firstName, lastName}} f
 * @return {string} Candidate ID or ''
 */
function PEOPLE_findPerson_(f) {
  var snap = _PEOPLE_readAc_(true);
  var probe = { email: PEOPLE_emailKey_(f.email), phone: PEOPLE_phoneKey_(f.phone),
                name: PEOPLE_nameKey_(f.firstName, f.lastName) };
  var best = null, bestRank = -1;
  snap.data.forEach(function (r) {
    var info = _PEOPLE_rowInfo_(r, snap.H);
    if (!info.cid) return;
    if (PEOPLE_compare_(probe, info) !== 'same') return;
    var rank = (info.status === 'ARCHIVED' ? 0 : 20) + _PEOPLE_stageRank_(info.status) + (info.email ? 5 : 0);
    if (rank > bestRank) { best = info; bestRank = rank; }
  });
  return best ? best.cid : '';
}

/** Add a role to a person's "Roles Applied" list (and keep Role = latest role). */
function PEOPLE_addRoleApplied_(candidateId, role, opts) {
  if (!candidateId || !role) return;
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  _PEOPLE_ensureCol_(ac, 'Roles Applied');
  var hit = findRowsByColumnValue_(ac, 'Candidate ID', candidateId);
  if (!hit.length) return;
  var cur = String(hit[0].data['Roles Applied'] || hit[0].data['Role'] || '').split(/\s*,\s*/).filter(Boolean);
  if (cur.indexOf(role) === -1) cur.push(role);
  var upd = { 'Roles Applied': cur.join(', '), 'Last Updated': shopDateTime_() };
  if (opts && opts.setRole && hit[0].data['Role'] !== role) upd['Role'] = role;
  batchUpdateRow_(ac, hit[0].rowNum, upd);
}

function _PEOPLE_ensureCol_(sheet, name) {
  var headers = getHeaderRow_(sheet);
  if (headers.indexOf(name) !== -1) return;
  sheet.getRange(1, headers.length + 1).setValue(name).setFontWeight('bold');
  if (typeof _HEADER_CACHE !== 'undefined') delete _HEADER_CACHE[sheet.getName()];
}

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE MERGE (All Candidates + Interview Pipeline)
// ─────────────────────────────────────────────────────────────────────────────

function _PEOPLE_planMerge_() {
  var snap = _PEOPLE_readAc_(true);
  var H = snap.H, data = snap.data;
  var info = data.map(function (r, i) { var x = _PEOPLE_rowInfo_(r, H); x.idx = i; x.rowNum = i + 2; return x; })
    .filter(function (x) { return x.cid && !/^TEST-/.test(x.cid); });
  var parent = {}; info.forEach(function (x) { parent[x.idx] = x.idx; });
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  var possible = [];
  for (var a = 0; a < info.length; a++) {
    for (var b = a + 1; b < info.length; b++) {
      var c = PEOPLE_compare_(info[a], info[b]);
      if (c === 'same') { var ra = find(info[a].idx), rb = find(info[b].idx); if (ra !== rb) parent[ra] = rb; }
      else if (c === 'possible') possible.push([info[a], info[b]]);
    }
  }
  var groups = {};
  info.forEach(function (x) { var g = find(x.idx); (groups[g] = groups[g] || []).push(x); });

  var plan = { groups: [], possible: possible, totalRows: info.length };
  Object.keys(groups).forEach(function (g) {
    var m = groups[g];
    if (m.length < 2) return;
    m.forEach(function (x) {
      var r = data[x.idx];
      x.rich = (x.status === 'ARCHIVED' ? 0 : 5000) + (x.email ? 1000 : 0) +
        (_PEOPLE_stageRank_(x.status) * 100) +
        (String(r[H['AI Score']] || r[H['Total Score']] || '') !== '' ? 300 : 0) + (x.phone ? 50 : 0);
    });
    m.sort(function (p, q) { return q.rich - p.rich || p.rowNum - q.rowNum; });
    plan.groups.push({ keep: m[0], losers: m.slice(1) });
  });
  return plan;
}

function PEOPLE_mergeDuplicates(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var plan = _PEOPLE_planMerge_();
  var snap = _PEOPLE_readAc_();
  var H = snap.H, data = snap.data, headers = snap.headers, ac = snap.sheet;
  var out = ['[PEOPLE] duplicate merge ' + (dryRun ? 'PREVIEW' : 'EXECUTE') + ' — ' + plan.groups.length +
             ' person(s) with duplicate rows'];
  function label(x) { var r = data[x.idx]; return (r[H['First Name']] + ' ' + r[H['Last Name']]).trim() + ' [' + x.role + ' / ' + x.status + ']'; }
  plan.groups.forEach(function (g) {
    out.push('  KEEP ' + label(g.keep) + '  ← merge ' + g.losers.map(label).join(' + '));
  });
  if (plan.possible.length) {
    out.push('  POSSIBLE duplicates (same name, different email AND phone — left alone, review):');
    plan.possible.forEach(function (p) { out.push('    ? ' + label(p[0]) + '  vs  ' + label(p[1])); });
  }
  if (dryRun || !plan.groups.length) { var m0 = out.join('\n'); Logger.log(m0); return m0; }

  // Merged Duplicates tab
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var md = ss.getSheetByName(PEOPLE_MERGED_SHEET);
  if (!md) {
    md = ss.insertSheet(PEOPLE_MERGED_SHEET);
    md.getRange(1, 1, 1, headers.length + 2).setValues([['Merged Into', 'Merged At'].concat(headers)]).setFontWeight('bold');
    md.setFrozenRows(1);
  }
  _PEOPLE_ensureCol_(ac, 'Roles Applied');
  var H2 = {}; getHeaderRow_(ac).forEach(function (h, i) { H2[h] = i; });
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var deleteRows = [];

  plan.groups.forEach(function (g) {
    var keepRow = data[g.keep.idx];
    var updates = {};
    headers.forEach(function (col, c) {
      var cur = keepRow[c];
      if (cur !== '' && cur !== null && cur !== undefined) return;
      for (var k = 0; k < g.losers.length; k++) {
        var v = data[g.losers[k].idx][c];
        if (v !== '' && v !== null && v !== undefined) { updates[col] = v; break; }
      }
    });
    // real email beats a relay address
    if (!g.keep.email) {
      for (var k2 = 0; k2 < g.losers.length; k2++) if (g.losers[k2].email) { updates['Email'] = g.losers[k2].rawEmail; break; }
    }
    var roles = [];
    [g.keep].concat(g.losers).forEach(function (x) {
      String(data[x.idx][H2['Roles Applied']] || x.role || '').split(/\s*,\s*/).forEach(function (r) {
        if (r && roles.indexOf(r) === -1) roles.push(r);
      });
    });
    updates['Roles Applied'] = roles.join(', ');
    updates['Notes'] = (String(keepRow[H['Notes']] || '') + ' | Merged duplicates ' + shopDate_() + ': ' +
      g.losers.map(function (l) { return l.cid; }).join(', ')).replace(/^ \| /, '').slice(0, 480);
    updates['Last Updated'] = shopDateTime_();
    batchUpdateRow_(ac, g.keep.rowNum, updates);

    g.losers.forEach(function (l) {
      md.appendRow([g.keep.cid, shopDateTime_()].concat(data[l.idx]));
      deleteRows.push(l.rowNum);
      if (ip) _PEOPLE_repointPipeline_(ip, l.cid, g.keep.cid);
      _PEOPLE_repointQueue_(l.cid, g.keep.cid);
    });
    logEvent_('PEOPLE_MERGED', g.keep.cid, { merged: g.losers.map(function (l) { return l.cid; }) });
  });

  deleteRows.sort(function (a, b) { return b - a; }).forEach(function (rn) { ac.deleteRow(rn); });
  _PEOPLE_AC_CACHE_ = null;
  out.push('  ✓ merged ' + deleteRows.length + ' duplicate row(s) — originals kept on "' + PEOPLE_MERGED_SHEET + '"');
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Loser pipeline row: re-key to keeper if keeper has none, else fill keeper blanks and delete. */
function _PEOPLE_repointPipeline_(ip, fromCid, toCid) {
  var lo = findRowsByColumnValue_(ip, 'Candidate ID', fromCid);
  if (!lo.length) return;
  var ke = findRowsByColumnValue_(ip, 'Candidate ID', toCid);
  if (!ke.length) { batchUpdateRow_(ip, lo[0].rowNum, { 'Candidate ID': toCid }); return; }
  var upd = {};
  Object.keys(lo[0].data).forEach(function (k) {
    var kv = ke[0].data[k], lv = lo[0].data[k];
    if ((kv === '' || kv === null) && lv !== '' && lv !== null && k !== 'Candidate ID') upd[k] = lv;
  });
  if (Object.keys(upd).length) batchUpdateRow_(ip, ke[0].rowNum, upd);
  ip.deleteRow(lo[0].rowNum);
}

function _PEOPLE_repointQueue_(fromCid, toCid) {
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh || sh.getLastRow() < 2) return;
  var col = getColIndex_(sh, 'Candidate ID');
  if (!col) return;
  var vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  vals.forEach(function (v, i) { if (String(v[0]) === fromCid) sh.getRange(i + 2, col).setValue(toCid); });
}

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Move a candidate's pipeline row to Pipeline Archive (via the sweep tab) and remove it. */
function _PEOPLE_removeFromPipeline_(candidateId, status, note) {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip) return false;
  var hit = findRowsByColumnValue_(ip, 'Candidate ID', candidateId);
  if (!hit.length) return false;
  batchUpdateRow_(ip, hit[0].rowNum, { 'Status': status, 'Notes': note || '', 'Last Updated': shopDateTime_() });
  var arch = getSheetOrNull_(SHEETS.PIPELINE_ARCHIVE || 'Pipeline Archive');
  if (arch) {
    var ah = getHeaderRow_(arch);
    var row = ah.map(function (h) {
      if (h === 'Archived At') return shopDateTime_();
      if (h === 'Archived Status') return status;
      if (h === 'Archived From') return 'People Registry';
      if (h === 'Status') return status;
      var v = hit[0].data[h]; return v === undefined ? '' : v;
    });
    arch.appendRow(row);
  }
  ip.deleteRow(hit[0].rowNum);
  return true;
}

function _PEOPLE_cancelPending_(candidateId, onlyTemplates) {
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  var n = 0;
  if (sh && sh.getLastRow() >= 2) {
    var headers = getHeaderRow_(sh);
    var hC = headers.indexOf('Candidate ID'), hT = headers.indexOf('Template Key'),
        hS = headers.indexOf('Status'), hN = headers.indexOf('Notes');
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
    data.forEach(function (r, i) {
      if (String(r[hC]) !== candidateId || String(r[hS]).toUpperCase() !== 'PENDING') return;
      var tpl = String(r[hT] || '');
      if (tpl.indexOf('__') === 0) return;
      if (onlyTemplates && !onlyTemplates[tpl]) return;
      sh.getRange(i + 2, hS + 1).setValue('CANCELLED');
      if (hN !== -1) sh.getRange(i + 2, hN + 1).setValue('Cancelled by People rules ' + shopDateTime_());
      n++;
    });
  }
  if (typeof LIVEADV_cancel === 'function') safeRun_('PEOPLE:liveadvCancel', function () { LIVEADV_cancel(candidateId); });
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGER DECISIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Manager Decision "Interview Booked (Manual)": protect, no email. */
function PEOPLE_dispatchInterviewBooked_(candidateId, candidate) {
  var cancelled = _PEOPLE_cancelPending_(candidateId, PEOPLE_AUTO_TEMPLATES);
  _setBothStatuses_(candidateId, STATUS_INTERVIEW_BOOKED,
    'Interview booked manually by hiring manager — automation paused, no emails. ' + shopDateTime_() +
    (cancelled ? ' (cancelled ' + cancelled + ' pending auto email[s])' : ''));
  logEvent_('INTERVIEW_BOOKED_MANUAL', candidateId, { cancelled: cancelled });
  toast_('Protected: no automated emails, no auto-archive.', 'Recruiting OS', 6);
  return { action: 'INTERVIEW_BOOKED', emailQueued: false };
}

/** Confirm Hire → add to registry as Current Employee (blocks all candidate emails). */
function PEOPLE_registerHire_(candidateId, candidate) {
  var sh = _PEOPLE_ensureRegistry_();
  var name = String((candidate['First Name'] || '') + ' ' + (candidate['Last Name'] || '')).trim() || candidate['Full Name'] || '';
  var existing = PEOPLE_registryMatch_({ email: candidate['Email'], phone: candidate['Phone'],
    firstName: candidate['First Name'], lastName: candidate['Last Name'] });
  var reg = _PEOPLE_readRegistry_();
  var anyRow = existing || reg.byEmail[PEOPLE_emailKey_(candidate['Email'])] ||
    reg.byName[PEOPLE_nameKey_(candidate['First Name'], candidate['Last Name']).key];
  var vals = { 'Person Name': name, 'Email': PEOPLE_emailKey_(candidate['Email']) || '',
    'Phone': candidate['Phone'] || '', 'Flag': 'Current Employee', 'Rehire Eligible': '',
    'Role / Dept': candidate['Role'] || '', 'Start Date': '', 'End Date': '', 'Source': 'Confirm Hire',
    'Notes': 'Added automatically on Confirm Hire ' + shopDate_() + ' (' + candidateId + ')', 'Last Synced': shopDateTime_() };
  if (anyRow) {
    batchUpdateRow_(sh, anyRow.rowNum, { 'Flag': 'Current Employee', 'Source': 'Confirm Hire',
      'Notes': vals['Notes'], 'End Date': '', 'Last Synced': shopDateTime_() });
  } else {
    appendRowByHeader_(sh, vals);
  }
  PEOPLE_clearCache_();
  _PEOPLE_cancelPending_(candidateId, null);
  logEvent_('PEOPLE_HIRE_REGISTERED', candidateId, { name: name });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYROLL SYNC
// ─────────────────────────────────────────────────────────────────────────────

function PEOPLE_syncRegistry() {
  var sh = _PEOPLE_ensureRegistry_();
  var id = CFG.get('PAYROLL_WORKBOOK_ID', PEOPLE_PAYROLL_ID_DEFAULT);
  var summary = { added: 0, updated: 0, skippedManual: 0 };
  var src;
  try { src = SpreadsheetApp.openById(id); }
  catch (e) { logError_('PEOPLE_syncRegistry', 'cannot open payroll workbook ' + id + ': ' + e, '', 'WARN'); return '[PEOPLE] sync skipped — payroll workbook not reachable'; }

  var people = [];
  [['Employee_Master', false], ['Employee_Archive', true]].forEach(function (t) {
    var s = src.getSheetByName(t[0]);
    if (!s || s.getLastRow() < 2) return;
    var hd = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String);
    function ci(n) { return hd.indexOf(n); }
    var vals = s.getRange(2, 1, s.getLastRow() - 1, hd.length).getValues();   // only named columns below are used
    vals.forEach(function (r) {
      var name = String(r[ci('Employee Name')] || '').trim();
      if (!name || /evaluator/i.test(name)) return;
      var active = String(r[ci('Active Status')] || '').trim().toUpperCase() === 'ACTIVE' && !t[1];
      people.push({ name: name, pref: String(r[ci('Preferred Name')] || '').trim(),
        role: String(r[ci('Role')] || r[ci('Department')] || '').trim(), active: active,
        start: r[ci('Hire Date')] || '', end: r[ci('Termination Date')] || '',
        email: PEOPLE_emailKey_(r[ci('Email')]) });
    });
  });

  PEOPLE_clearCache_();
  var reg = _PEOPLE_readRegistry_();
  people.forEach(function (p) {
    var nk = PEOPLE_nameKey_(p.name, '').key;
    var rec = (p.email && reg.byEmail[p.email]) || (nk && reg.byName[nk]);
    var flag = p.active ? 'Current Employee' : 'Former Employee';
    var lastTok = p.name.split(/\s+/).slice(-1)[0];
    var alias = (p.pref && PEOPLE_nameKey_(p.pref, lastTok).key !== nk) ? p.pref + ' ' + lastTok : '';
    if (rec) {
      if (rec.source && rec.source !== 'Payroll') { summary.skippedManual++; return; }
      batchUpdateRow_(sh, rec.rowNum, { 'Flag': flag, 'Role / Dept': p.role, 'Start Date': p.start,
        'End Date': p.end, 'Last Synced': shopDateTime_() });
      summary.updated++;
    } else {
      appendRowByHeader_(sh, { 'Person Name': p.name, 'Aliases': alias, 'Email': p.email || '',
        'Flag': flag, 'Rehire Eligible': p.active ? '' : 'Review', 'Role / Dept': p.role,
        'Start Date': p.start, 'End Date': p.end, 'Source': 'Payroll', 'Last Synced': shopDateTime_() });
      summary.added++;
    }
  });
  PEOPLE_clearCache_();
  var msg = '[PEOPLE] registry sync ' + JSON.stringify(summary);
  logEvent_('PEOPLE_REGISTRY_SYNC', '', summary);
  Logger.log(msg);
  return msg;
}

/** Upsert a manual registry row (manual rows are never overwritten by payroll). */
function PEOPLE_setManual_(name, flag, rehire, notes, extra) {
  var sh = _PEOPLE_ensureRegistry_();
  PEOPLE_clearCache_();
  var reg = _PEOPLE_readRegistry_();
  var rec = reg.byName[PEOPLE_nameKey_(name, '').key];
  var vals = { 'Flag': flag, 'Rehire Eligible': rehire || '', 'Source': 'Manual',
               'Notes': notes || '', 'Last Synced': shopDateTime_() };
  Object.keys(extra || {}).forEach(function (k) { vals[k] = extra[k]; });
  if (rec) batchUpdateRow_(sh, rec.rowNum, vals);
  else { vals['Person Name'] = name; appendRowByHeader_(sh, vals); }
  PEOPLE_clearCache_();
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY RUN + CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

/** Sweep: hold every non-held candidate who is on the registry; release "Cleared to Apply". */
function _PEOPLE_sweepRegistryMatches_(dryRun) {
  PEOPLE_clearCache_();
  var reg = _PEOPLE_readRegistry_();
  var snap = _PEOPLE_readAc_(true);
  var H = snap.H;
  var held = [], released = [];
  snap.data.forEach(function (r) {
    var cid = String(r[H['Candidate ID']] || '').trim();
    if (!cid || /^TEST-/.test(cid)) return;
    var st = String(r[H['Status']] || '').toUpperCase();
    var obj = { 'Email': r[H['Email']], 'Phone': r[H['Phone']], 'First Name': r[H['First Name']], 'Last Name': r[H['Last Name']] };
    var rec = PEOPLE_registryMatchForCandidate_(obj);
    var name = (r[H['First Name']] + ' ' + r[H['Last Name']]).trim();
    // Only candidates still in the AUTOMATED stage are held — anyone the manager is
    // actively handling (Interview Booked, Full Booked, Offer…) is left alone.
    if (rec && !PEOPLE_isProtectedStatus_(st) && st !== 'ARCHIVED' && st !== 'REJECTED') {
      held.push(name + ' (' + st + ') → ' + rec.flag);
      if (!dryRun) PEOPLE_holdCandidate_(cid, rec, r[H['Role']]);
    } else if (!rec && st === STATUS_REGISTRY_HOLD) {
      // Registry now says "Cleared to Apply" (or row removed) → back into normal flow.
      released.push(name);
      if (!dryRun) {
        updateRowWhere_(snap.sheet, 'Candidate ID', cid, { 'Status': STATUS.PRESCREEN_RECEIVED,
          'Notes': 'Released from People Registry hold ' + shopDateTime_(), 'Last Updated': shopDateTime_() });
        if (typeof scorePreScreenV2 === 'function') safeRun_('PEOPLE:release', function () { scorePreScreenV2(cid); });
      }
    }
  });
  // Also: any HIRED candidate still on the pipeline comes off it.
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  var hiredOff = [];
  if (ip && ip.getLastRow() >= 2) {
    var ih = getHeaderRow_(ip), IH = {}; ih.forEach(function (h, i) { IH[h] = i; });
    ip.getRange(2, 1, ip.getLastRow() - 1, ih.length).getValues().forEach(function (r) {
      if (String(r[IH['Status']] || '').toUpperCase() === 'HIRED') hiredOff.push(String(r[IH['Candidate ID']]));
    });
    if (!dryRun) hiredOff.forEach(function (cid) { _PEOPLE_removeFromPipeline_(cid, 'HIRED', 'Hired — moved off pipeline'); });
  }
  return { held: held, released: released, hiredOff: hiredOff.length };
}

function PEOPLE_daily() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('PEOPLE_daily', 'OK');
  return withLockOrSkip_('PEOPLE_daily', function () {
    var out = [];
    out.push(safeRun_('PEOPLE:sync', PEOPLE_syncRegistry) || 'sync failed');
    var s = _PEOPLE_sweepRegistryMatches_(false);
    out.push('held ' + s.held.length + ', released ' + s.released.length + ', hired moved off ' + s.hiredOff);
    if (CFG.getBool('PEOPLE_AUTO_MERGE_ENABLED', true)) {
      out.push(safeRun_('PEOPLE:merge', function () { return PEOPLE_mergeDuplicates({ dryRun: false }).split('\n').slice(-1)[0]; }) || 'merge failed');
    }
    var msg = '[PEOPLE] daily — ' + out.join(' | ');
    logEvent_('PEOPLE_DAILY', '', { detail: msg });
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DIGEST SECTION (called from 15_Daily_Digest)
// ─────────────────────────────────────────────────────────────────────────────

function PEOPLE_digestSection_(section, table) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PEOPLE_SHEET);
    var rows = [];
    if (sh && sh.getLastRow() >= 2) {
      var hd = getHeaderRow_(sh), H = {}; hd.forEach(function (h, i) { H[h] = i; });
      var since = Date.now() - 36 * 3600 * 1000;
      sh.getRange(2, 1, sh.getLastRow() - 1, hd.length).getValues().forEach(function (r) {
        var d = r[H['Last Applied']]; var t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
        if (!isNaN(t) && t >= since) rows.push([r[H['Person Name']], r[H['Flag']], r[H['Rehire Eligible']] || '', r[H['Last Applied Role']] || '']);
      });
    }
    var poss = _PEOPLE_planMerge_().possible.map(function (p) {
      var a = _PEOPLE_readAc_(), H2 = a.H;
      return [(a.data[p[0].idx][H2['First Name']] + ' ' + a.data[p[0].idx][H2['Last Name']]).trim(),
              p[0].role + ' / ' + p[1].role, 'same name, different email + phone'];
    });
    if (!rows.length && !poss.length) return '';
    var html = '';
    if (rows.length) html += table(['Person', 'Registry Flag', 'Rehire', 'Applied For'], rows) +
      '<div style="color:#666;font-size:12px;margin:6px 0 10px;">Held automatically — no emails sent, not on the pipeline. ' +
      'To consider them, set their Flag to "Cleared to Apply" on the People Registry tab.</div>';
    if (poss.length) html += table(['Possible duplicate', 'Roles', 'Why not auto-merged'], poss);
    return section('🚫 Held — former employees / possible duplicates', html);
  } catch (e) { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK ADD (menu) — candidate booked by phone
// ─────────────────────────────────────────────────────────────────────────────

function PEOPLE_openQuickAdd() {
  var roles = (typeof ROLES !== 'undefined' ? ROLES : ['Technician', 'Service Advisor', 'CX / Valet Porter Driver']);
  var opts = roles.map(function (r) { return '<option>' + r + '</option>'; }).join('');
  var html = HtmlService.createHtmlOutput(
    '<style>body{font-family:Arial;font-size:13px;margin:12px}label{display:block;margin-top:8px;font-weight:bold}' +
    'input,select,textarea{width:100%;padding:6px;box-sizing:border-box}button{margin-top:14px;padding:8px 16px;' +
    'background:#0b3d2e;color:#fff;border:0;border-radius:4px;font-size:14px}#msg{margin-top:10px}</style>' +
    '<div>Adds (or updates) the candidate as <b>Interview Booked (Manual)</b>. No emails are sent and automation will not archive them.</div>' +
    '<form id="f"><label>First name *</label><input name="firstName" required>' +
    '<label>Last name *</label><input name="lastName" required>' +
    '<label>Phone</label><input name="phone"><label>Email</label><input name="email" type="email">' +
    '<label>Role *</label><select name="role">' + opts + '</select>' +
    '<label>Interview date &amp; time</label><input name="interviewAt" type="datetime-local">' +
    '<label>Notes</label><textarea name="notes" rows="2"></textarea>' +
    '<button type="submit">Add candidate</button></form><div id="msg"></div>' +
    '<script>document.getElementById("f").onsubmit=function(e){e.preventDefault();var b=this.querySelector("button");b.disabled=true;' +
    'document.getElementById("msg").textContent="Saving…";google.script.run.withSuccessHandler(function(r){' +
    'document.getElementById("msg").innerHTML=r;b.disabled=false;}).withFailureHandler(function(err){' +
    'document.getElementById("msg").textContent="Error: "+err.message;b.disabled=false;}).PEOPLE_quickAddSubmit({' +
    'firstName:this.firstName.value,lastName:this.lastName.value,phone:this.phone.value,email:this.email.value,' +
    'role:this.role.value,interviewAt:this.interviewAt.value,notes:this.notes.value});};</script>'
  ).setWidth(380).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Quick Add Candidate (booked by phone)');
}

function PEOPLE_quickAddSubmit(form) {
  return withLock_(function () {
    var f = {
      firstName: String(form.firstName || '').trim(), lastName: String(form.lastName || '').trim(),
      phone: normalizePhone_(form.phone), email: normalizeEmail_(form.email),
      role: (typeof normalizeRole_ === 'function' ? normalizeRole_(form.role) : form.role) || form.role,
      notes: String(form.notes || '').trim(), when: form.interviewAt ? new Date(form.interviewAt) : null
    };
    if (!f.firstName || !f.lastName) throw new Error('First and last name are required.');

    var rec = PEOPLE_registryMatch_(f);
    var warn = rec ? '<div style="color:#b45309">⚠ On People Registry as <b>' + rec.flag + '</b> — added anyway because you booked them. Emails stay blocked.</div>' : '';

    var cid = PEOPLE_findPerson_(f);
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var whenTxt = f.when && !isNaN(f.when.getTime()) ? shopDateTime_(f.when) : '';
    var note = 'Quick Add — interview booked by phone' + (whenTxt ? ' for ' + whenTxt : '') + (f.notes ? ' — ' + f.notes : '');
    var created = false;
    if (cid) {
      var upd = { 'Status': STATUS_INTERVIEW_BOOKED, 'Notes': note, 'Last Updated': shopDateTime_() };
      var cur = _getCandidateRow_(cid) || {};
      if (f.email && !PEOPLE_emailKey_(cur['Email'])) upd['Email'] = f.email;
      if (f.phone && !PEOPLE_phoneKey_(cur['Phone'])) upd['Phone'] = f.phone;
      updateRowWhere_(ac, 'Candidate ID', cid, upd);
      PEOPLE_addRoleApplied_(cid, f.role, { setRole: true });
    } else {
      cid = f.email ? candidateIdFromEmail_(f.email, f.role) : genCandidateId_();
      appendRowByHeader_(ac, {
        'Date Received': shopDateTime_(), 'Role': f.role, 'First Name': f.firstName, 'Last Name': f.lastName,
        'Email': f.email, 'Phone': f.phone, 'Source': 'Phone / Direct (Quick Add)', 'Status': STATUS_INTERVIEW_BOOKED,
        'Notes': note, 'Candidate ID': cid, 'Hiring Manager': CFG.get('HIRING_MANAGER_NAME'),
        'Last Updated': shopDateTime_(), 'Roles Applied': f.role
      });
      created = true;
    }
    _PEOPLE_cancelPending_(cid, PEOPLE_AUTO_TEMPLATES);
    // Pipeline row (bypasses the registry gate on purpose — the manager booked them).
    var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
    if (ip) {
      if (!findRowsByColumnValue_(ip, 'Candidate ID', cid).length) {
        appendRowByHeader_(ip, { 'Date Promoted': shopDateTime_(), 'Days in Stage': 0, 'Role': f.role,
          'First Name': f.firstName, 'Last Name': f.lastName, 'Email': f.email, 'Phone': f.phone,
          'Stage': 'Interview booked by phone', 'Candidate ID': cid, 'Full Name': f.firstName + ' ' + f.lastName,
          'Status': STATUS_INTERVIEW_BOOKED, 'Hiring Manager': CFG.get('HIRING_MANAGER_NAME'),
          'Notes / Next Action': note, 'Last Updated': shopDateTime_(), 'Full Interview Booked': whenTxt });
      } else {
        updateRowWhere_(ip, 'Candidate ID', cid, { 'Status': STATUS_INTERVIEW_BOOKED, 'Stage': 'Interview booked by phone',
          'Notes / Next Action': note, 'Full Interview Booked': whenTxt, 'Last Updated': shopDateTime_() });
      }
    }
    logEvent_('QUICK_ADD_CANDIDATE', cid, { created: created, role: f.role, when: whenTxt });
    return '<div style="color:#0b3d2e"><b>✓ ' + (created ? 'Added' : 'Updated existing record for') + ' ' +
      f.firstName + ' ' + f.lastName + '</b> (' + cid + ').<br>Status: Interview Booked (Manual). No emails sent.</div>' + warn;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME SETUP + CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

/** Manual registry seeds known on 9/25/26 (payroll roster is partly stale). */
function _PEOPLE_manualSeeds_() {
  return [
    ['Tony McClendon', 'Former Employee', 'No', 'Hired Aug 2026, let go — do not re-hire (Travis 9/25/26)', { 'Aliases': 'Anthony McClendon', 'Role / Dept': 'CX' }],
    ['Sonia Ramirez', 'Former Employee', 'No', 'Hired, let go — do not re-hire (Travis 9/25/26)', { 'Aliases': 'Sonja Ramirez', 'Role / Dept': 'CX' }],
    ['Juan Corona', 'Current Employee', '', 'CX Specialist, start 9/28/26', { 'Aliases': 'Juan Manuel Corona Arcos', 'Role / Dept': 'CX' }],
    ['Vladimir Bonev', 'Current Employee', '', 'Technician — offer accepted 9/2026', { 'Role / Dept': 'Technician' }],
    ['Aaron Ramirez', 'Current Employee', '', 'CX Assistant — rehired 9/2026', { 'Role / Dept': 'CX' }],
    ['David Ellis', 'Current Employee', '', 'Service Advisor — returned 9/8/26', { 'Role / Dept': 'Service Advisor' }],
    ['Hector Callejas', 'Former Employee', 'Review', 'CX — parted ways 9/23/26 (payroll still shows ACTIVE)', { 'Role / Dept': 'CX' }],
    ['Jeffrey Shanahan', 'Former Employee', 'Review', 'Service Advisor — resigned (two-week notice late Aug 2026; payroll still shows ACTIVE)', { 'Aliases': 'Jeff Shanahan', 'Role / Dept': 'Service Advisor' }]
  ];
}

function PEOPLE_previewCleanup() {
  var out = ['[PEOPLE] CLEANUP PREVIEW (nothing changed)'];
  out.push('Registry: payroll sync + manual seeds: ' + _PEOPLE_manualSeeds_().map(function (s) { return s[0] + ' = ' + s[1]; }).join('; '));
  var s = _PEOPLE_sweepRegistryMatches_(true);
  out.push('Would HOLD (registry match, off pipeline, no emails): ' + (s.held.join('; ') || 'none') +
           '  [note: payroll people are only known after the sync runs]');
  out.push('Would move HIRED off pipeline: ' + s.hiredOff);
  out.push(PEOPLE_mergeDuplicates({ dryRun: true }));
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

function PEOPLE_applyCleanup() {
  var out = [];
  out.push(PEOPLE_syncRegistry());
  _PEOPLE_manualSeeds_().forEach(function (s) { PEOPLE_setManual_(s[0], s[1], s[2], s[3], s[4]); });
  out.push('manual seeds: ' + _PEOPLE_manualSeeds_().length);
  var sw = _PEOPLE_sweepRegistryMatches_(false);
  out.push('held: ' + (sw.held.join('; ') || 'none') + ' | hired moved off pipeline: ' + sw.hiredOff);
  out.push(PEOPLE_mergeDuplicates({ dryRun: false }));
  var msg = '[PEOPLE] CLEANUP APPLIED\n' + out.join('\n'); Logger.log(msg);
  logEvent_('PEOPLE_CLEANUP_APPLIED', '', { detail: msg.slice(0, 900) });
  return msg;
}

/**
 * Run once after pulling the files:
 *  - creates People Registry tab + Roles Applied column
 *  - adds the "Interview Booked (Manual)" Manager Decision option
 *  - installs PEOPLE_daily (5 AM)
 *  - logs the cleanup preview (apply with PEOPLE_applyCleanup)
 */
function PEOPLE_SETUP_RUN_ONCE() {
  var out = [];
  _PEOPLE_ensureRegistry_(); out.push('✓ People Registry tab ready');
  _PEOPLE_ensureCol_(getSheet_(SHEETS.ALL_CANDIDATES), 'Roles Applied'); out.push('✓ Roles Applied column ready');
  if (!CFG.has('DECISION_INTERVIEW_BOOKED')) CFG.set('DECISION_INTERVIEW_BOOKED', 'Interview Booked (Manual)');
  if (!CFG.has('PAYROLL_WORKBOOK_ID')) CFG.set('PAYROLL_WORKBOOK_ID', PEOPLE_PAYROLL_ID_DEFAULT);
  CFG.reset();
  if (typeof _applyManagerDecisionDropdown_ === 'function') { _applyManagerDecisionDropdown_(); out.push('✓ Manager Decision dropdown refreshed'); }
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'PEOPLE_daily'; });
  if (!has) { ScriptApp.newTrigger('PEOPLE_daily').timeBased().everyDays(1).atHour(5).create(); out.push('✓ daily trigger installed (5 AM)'); }
  out.push(PEOPLE_previewCleanup());
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

function PEOPLE_selfTest() {
  var out = ['[PEOPLE] selfTest (read-only)'];
  var t = PEOPLE_nameKey_('Tony', 'McClendon').key === PEOPLE_nameKey_('Anthony', 'Mcclendon').key;
  out.push('  nickname Tony=Anthony: ' + t);
  out.push('  suffix Jose Torres Jr: ' + (PEOPLE_nameKey_('Jose', 'Torres Jr').key === 'jose torres'));
  out.push('  compare relay+real same name: ' + PEOPLE_compare_(
    { email: '', phone: '', name: PEOPLE_nameKey_('Joey', 'Thompson') },
    { email: 'joey@x.com', phone: '', name: PEOPLE_nameKey_('Joseph', 'Thompson') }));
  out.push('  registry rows: ' + _PEOPLE_readRegistry_().rows.length);
  var msg = out.join('\n'); Logger.log(msg); return msg;
}

/** Read-only: shows what the email gate would decide for a few real records. */
function PEOPLE_testGates() {
  var snap = _PEOPLE_readAc_(true), H = snap.H, out = ['[PEOPLE] gate test (read-only, nothing sent)'];
  snap.data.slice(0).forEach(function (r) {
    var cid = String(r[H['Candidate ID']] || ''), name = (r[H['First Name']] + ' ' + r[H['Last Name']]).trim();
    if (!/sonia|mcclendon|fleming|bonev|callejas/i.test(name)) return;
    var why = PEOPLE_emailSuppressReason_({ to: r[H['Email']], templateKey: 'application_confirmation', candidateId: cid });
    out.push('  ' + name + ' [' + r[H['Status']] + '] → ' + (why || 'ALLOWED'));
  });
  var msg = out.join('\n'); Logger.log(msg); return msg;
}
