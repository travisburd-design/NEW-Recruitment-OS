/**
 * 28_Pipeline_Dedup.gs
 * Frank's European Service — Recruiting OS
 *
 * Duplicate-candidate cleanup + unattended self-maintenance.
 *
 * WHY: A person becomes two rows when (a) they apply on Indeed (relay email
 * conversation-xxx@indeedemail.com, no resume/score) AND later fill the
 * pre-screen with their real email, or (b) role wording drift produced two
 * Candidate IDs (FES-VAL vs FES-CXV). This module merges those rows back into
 * one — keeping the richest data — and runs the same cleanup automatically.
 *
 * Public functions:
 *   previewPipelineDedup()        — dry run, deletes nothing, logs the plan
 *   dedupePipelineCandidates(opts)— merge duplicate candidates (one per person)
 *   autoMaintenance()             — scheduled: silent dedup + purge stale junk
 *   PIPELINE_DEDUP_selfTest()
 *
 * Matching rules (transitive — union-find):
 *   • same real email (non-relay)            -> same person
 *   • same phone (last 10 digits)            -> same person
 *   • same normalized name, when at least    -> same person
 *     one side has NO real email (an Indeed
 *     shell attaching to a real submission)
 * Two rows with two DIFFERENT real emails are never merged on name alone.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: PREVIEW + EXECUTE
// ─────────────────────────────────────────────────────────────────────────────

/** Dry run: show what dedupePipelineCandidates() would merge/remove. */
function previewPipelineDedup() {
  return safeRun_('previewPipelineDedup', function () {
    var plan = _planPipelineCandidateDedup_();
    if (!plan) return 'Interview Pipeline sheet missing';
    var out = ['[DEDUP] pipeline PREVIEW (nothing changed):'];
    out.push('  Rows: ' + plan.totalRows + '  ->  unique people: ' + plan.keepers.length +
             '  (would remove ' + plan.toDelete.length + ' duplicate row(s))');
    plan.groups.forEach(function (g) {
      if (g.deleteRows.length === 0) return;
      out.push('  - ' + g.name + '  [keep row ' + g.keepRow + ' / ' + g.keepId + ']' +
               '  merge+remove rows ' + g.deleteRows.join(', '));
    });
    var msg = out.join('\n');
    Logger.log(msg);
    toast_('Preview: would merge ' + plan.toDelete.length + ' duplicate row(s) into ' +
           plan.keepers.length + ' people. See log.', 'Recruiting OS', 10);
    return msg;
  });
}

/**
 * Merge duplicate candidates so each person has exactly one Interview Pipeline
 * row. Blank cells on the surviving row are filled from the duplicates first
 * (so no booking date or score is lost), then the duplicate rows are deleted.
 * Idempotent. Pass { silent:true } to suppress the toast (used by autopilot).
 */
function dedupePipelineCandidates(opts) {
  opts = opts || {};
  return safeRun_('dedupePipelineCandidates', function () {
    var plan = _planPipelineCandidateDedup_();
    if (!plan) return 'Interview Pipeline sheet missing';
    if (!plan.toDelete.length) {
      if (!opts.silent) toast_('No duplicate candidates found.', 'Recruiting OS', 6);
      return 'no duplicates (rows: ' + plan.totalRows + ')';
    }
    var sh = getSheet_(SHEETS.INTERVIEW_PIPELINE);

    // 1) Fill blank cells on each keeper from its duplicates (richest-first).
    plan.mergeWrites.forEach(function (w) {
      if (w.updates && Object.keys(w.updates).length) batchUpdateRow_(sh, w.rowNum, w.updates);
    });

    // 2) Delete duplicate rows bottom-up so row numbers stay valid.
    plan.toDelete.slice().sort(function (a, b) { return b - a; }).forEach(function (rn) { sh.deleteRow(rn); });

    var msg = 'merged ' + plan.toDelete.length + ' duplicate row(s); ' +
              plan.keepers.length + ' unique candidate(s) remain';
    Logger.log('[DEDUP] pipeline — ' + msg);
    if (!opts.silent) toast_('Duplicates merged: ' + msg, 'Recruiting OS', 10);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN BUILDER  (shared by preview + executor)
// ─────────────────────────────────────────────────────────────────────────────

function _planPipelineCandidateDedup_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!sh) return null;
  var last = sh.getLastRow();
  var headers = getHeaderRow_(sh);
  var H = {};
  headers.forEach(function (h, i) { H[h] = i; });
  var plan = { totalRows: 0, toDelete: [], keepers: [], groups: [], mergeWrites: [] };
  if (last < 2 || H['Candidate ID'] === undefined) return plan;

  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  plan.totalRows = data.length;

  // Build identity keys per row.
  var info = data.map(function (r, i) {
    return {
      idx:    i,
      rowNum: i + 2,
      id:     _cellStr_(r, H, 'Candidate ID'),
      name:   _candidateName_(r, H),
      email:  _realEmailKey_(_cellStr_(r, H, 'Email')),
      phone:  _phoneKey_(_cellStr_(r, H, 'Phone')),
      score:  _richness_(r, H)
    };
  });

  // Union-find over row indices. Email/phone are strong keys, but we still
  // require name compatibility before merging — otherwise two different people
  // who happen to share an address (e.g. a reused test email) would be merged.
  var parent = info.map(function (_, i) { return i; });
  var emailRep = {}, phoneRep = {}, nameRep = {};
  info.forEach(function (a) {
    if (a.email) {
      if (emailRep[a.email] !== undefined) {
        if (_nameCompatible_(a.name, info[emailRep[a.email]].name)) _ufUnion_(parent, a.idx, emailRep[a.email]);
      } else { emailRep[a.email] = a.idx; }
    }
    if (a.phone) {
      if (phoneRep[a.phone] !== undefined) {
        if (_nameCompatible_(a.name, info[phoneRep[a.phone]].name)) _ufUnion_(parent, a.idx, phoneRep[a.phone]);
      } else { phoneRep[a.phone] = a.idx; }
    }
  });
  // Name union only attaches rows where at least one side has no real email
  // (i.e. an Indeed shell joining a real submission) — never two real emails.
  info.forEach(function (a) {
    if (!a.name) return;
    var prev = nameRep[a.name];
    if (prev !== undefined) {
      var b = info[prev];
      if (!a.email || !b.email) _ufUnion_(parent, a.idx, prev);
    } else {
      nameRep[a.name] = a.idx;
    }
  });

  // Collect groups.
  var groups = {};
  info.forEach(function (a) {
    var root = _ufFind_(parent, a.idx);
    (groups[root] = groups[root] || []).push(a);
  });

  Object.keys(groups).forEach(function (root) {
    var members = groups[root];
    // Richest row is the keeper; tie -> earliest row number.
    members.sort(function (a, b) { return (b.score - a.score) || (a.rowNum - b.rowNum); });
    var keep = members[0];
    var losers = members.slice(1);

    // Fill blank keeper cells from losers (richest loser first).
    var updates = {};
    if (losers.length) {
      var keepRow = data[keep.idx];
      headers.forEach(function (col, c) {
        var cur = keepRow[c];
        if (cur !== '' && cur !== null && cur !== undefined) return;   // keeper already has a value
        for (var k = 0; k < losers.length; k++) {
          var v = data[losers[k].idx][c];
          if (v !== '' && v !== null && v !== undefined) { updates[col] = v; break; }
        }
      });
    }

    plan.keepers.push(keep.rowNum);
    plan.groups.push({
      name:       keep.name || keep.id,
      keepRow:    keep.rowNum,
      keepId:     keep.id,
      deleteRows: losers.map(function (l) { return l.rowNum; })
    });
    if (Object.keys(updates).length) plan.mergeWrites.push({ rowNum: keep.rowNum, updates: updates });
    losers.forEach(function (l) { plan.toDelete.push(l.rowNum); });
  });

  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY + RICHNESS HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _cellStr_(row, H, col) {
  return (H[col] === undefined) ? '' : String(row[H[col]] === undefined ? '' : row[H[col]]).trim();
}

function _candidateName_(row, H) {
  var full = _cellStr_(row, H, 'Full Name');
  if (!full) full = (_cellStr_(row, H, 'First Name') + ' ' + _cellStr_(row, H, 'Last Name')).trim();
  return full.replace(/[^A-Za-z\s]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Real email key, or '' for relay/notification/no-reply addresses. */
function _realEmailKey_(email) {
  var e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return '';
  if (e.indexOf('indeedemail.com') !== -1) return '';
  if (e.indexOf('no-reply') !== -1 || e.indexOf('noreply') !== -1 || e.indexOf('notification') !== -1) return '';
  return e;
}

/**
 * True if two normalized names plausibly belong to the same person: same
 * surname AND a matching/nickname first name (one a prefix of the other).
 * Empty names (Indeed shells) are treated as compatible so they can attach.
 */
function _nameCompatible_(a, b) {
  if (!a || !b) return true;
  var ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return true;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false;          // surnames differ
  var fa = ta[0], fb = tb[0];
  return fa === fb || fa.indexOf(fb) === 0 || fb.indexOf(fa) === 0;     // first name equal or nickname-prefix
}

/** Last 10 digits of a phone, or '' if not a usable number. */
function _phoneKey_(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return '';
  return d.slice(-10);
}

var _DEDUP_STAGE_RANK = {
  'NEW': 1, 'MANUAL_REVIEW': 1, 'ARCHIVED': 1, 'IN_DRAWER': 2, 'REJECTED': 2,
  'PRESCREEN_SENT': 2, 'PRESCREEN_RECEIVED': 3, 'SCORED': 3, 'AUTO_BOOK_SENT': 4,
  'PHONE_BOOKED': 5, 'PHONE_DONE': 6, 'FULL_BOOKED': 7, 'FULL_DONE': 8,
  'WORKING_SCHEDULED': 9, 'REFS_REQUESTED': 9, 'REFS_PENDING': 9, 'REFS_COMPLETE': 10, 'RECOMMENDED': 10,
  'OFFER_PENDING': 11, 'HIRED': 12
};

/** How much usable data a row carries — higher wins the keeper slot. */
function _richness_(row, H) {
  var score = 0;
  if (_realEmailKey_(_cellStr_(row, H, 'Email'))) score += 1000;
  var ps = _cellStr_(row, H, 'Pre-Screen Score');
  if (ps !== '' && !isNaN(Number(ps))) score += 500;
  if (_phoneKey_(_cellStr_(row, H, 'Phone'))) score += 200;
  score += (_DEDUP_STAGE_RANK[_cellStr_(row, H, 'Status')] || 0) * 10;
  var lu = _coerceDate_(_cellStr_(row, H, 'Last Updated'));
  if (lu && !isNaN(lu.getTime())) score += lu.getTime() / 1e13;   // tiny recency tiebreak
  return score;
}

// Union-find primitives.
function _ufFind_(parent, i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
function _ufUnion_(parent, a, b) { var ra = _ufFind_(parent, a), rb = _ufFind_(parent, b); if (ra !== rb) parent[ra] = rb; }

// ─────────────────────────────────────────────────────────────────────────────
// UNATTENDED SELF-MAINTENANCE  (scheduled daily)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One unattended housekeeping pass. Installed as a daily trigger so the system
 * stays clean with zero manual upkeep:
 *   1. merge duplicate candidates (silent)
 *   2. purge stale Indeed relay shells that never matched a real applicant
 *   3. trim already-sent rows out of the Email Queue
 * Everything is gated by config and safe to re-run.
 */
function autoMaintenance() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('autoMaintenance', 'OK');
  return safeRun_('autoMaintenance', function () {
    if (!CFG.getBool('AUTO_MAINTENANCE_ENABLED', true)) return '[MAINT] disabled';
    var parts = [];

    // F24: daily fail-loud self-audit — blocked email, dead triggers, AI key,
    // failed grades, deferred jobs, unmatched/skipped transcripts. Emails a
    // CRITICAL alert (un-gated from SEND_ENABLED) if anything is wrong.
    if (typeof systemSelfAudit_ === 'function') {
      safeRun_('autoMaintenance:selfAudit', function () {
        var audit = systemSelfAudit_();
        parts.push('self-audit: ' + (audit.ok ? 'clean' : audit.issues.length + ' issue(s)'));
      });
    }
    // F2: auto-recover any recoverable BLOCKED email so the queue self-heals daily.
    if (typeof recoverBlockedQueue_ === 'function') {
      safeRun_('autoMaintenance:recoverQueue', function () {
        var rec = recoverBlockedQueue_();
        if (rec && rec.recovered) parts.push('queue recovered: ' + rec.recovered);
      });
    }

    if (CFG.getBool('AUTO_DEDUP_ENABLED', true)) {
      parts.push('dedup: ' + dedupePipelineCandidates({ silent: true }));
    }
    // Keep the live pipeline clean: move closed candidates (Rejected / Archived /
    // In Drawer) off the Interview Pipeline into the Pipeline Archive tab. Runs
    // after dedup so duplicates are merged before anyone is swept.
    if (CFG.getBool('PIPELINE_SWEEP_ENABLED', true) && typeof sweepInterviewPipeline === 'function') {
      parts.push('sweep: ' + sweepInterviewPipeline({ silent: true }));
    }
    parts.push('shells: ' + _purgeStaleIndeedShells_());
    parts.push('queue: ' + _purgeOldEmailQueueRows_());

    if (typeof sendReferenceDeadlineReminders === 'function') {
      parts.push('refReminders: ' + sendReferenceDeadlineReminders());
    }

    var msg = '[MAINT] autoMaintenance — ' + parts.join(' | ');
    Logger.log(msg);
    return msg;
  });
}

/**
 * Delete Indeed relay "shell" rows that carry no usable data (relay email, no
 * score, never progressed past MANUAL_REVIEW/NEW) and are older than
 * PURGE_STALE_SHELL_DAYS. After dedup these are the leftovers that never matched
 * a real applicant, so they are pure noise. Conservative: only relay addresses.
 */
function _purgeStaleIndeedShells_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!sh) return 'pipeline missing';
  var last = sh.getLastRow();
  if (last < 2) return '0';
  var headers = getHeaderRow_(sh);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  if (H['Candidate ID'] === undefined) return '0';

  var days = CFG.getInt('PURGE_STALE_SHELL_DAYS', 30);
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var del = [];
  for (var i = 0; i < data.length; i++) {
    var email = _cellStr_(data[i], H, 'Email');
    if (email.toLowerCase().indexOf('indeedemail.com') === -1) continue;   // relay shells only
    if (_realEmailKey_(email)) continue;
    var ps = _cellStr_(data[i], H, 'Pre-Screen Score');
    if (ps !== '' && !isNaN(Number(ps))) continue;                          // has a score -> keep
    var status = _cellStr_(data[i], H, 'Status');
    if (status !== STATUS.MANUAL_REVIEW && status !== STATUS.NEW && status !== '') continue;
    var age = _coerceDate_(_cellStr_(data[i], H, 'Date Promoted') || _cellStr_(data[i], H, 'Last Updated'));
    if (!age || isNaN(age.getTime()) || age.getTime() > cutoff.getTime()) continue;  // too recent
    del.push(i + 2);
  }
  del.sort(function (a, b) { return b - a; }).forEach(function (rn) { sh.deleteRow(rn); });
  return String(del.length);
}

/**
 * Trim the Email Queue: delete rows that are already finished (SENT / BLOCKED /
 * CANCELLED / FAILED) and older than EMAIL_QUEUE_RETENTION_DAYS. PENDING rows
 * are always kept so nothing waiting to send is ever lost.
 */
function _purgeOldEmailQueueRows_() {
  var sh = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (!sh) return 'queue missing';
  var last = sh.getLastRow();
  if (last < 2) return '0';
  var headers = getHeaderRow_(sh);
  var H = {}; headers.forEach(function (h, i) { H[h] = i; });
  if (H['Status'] === undefined) return '0';

  var days = CFG.getInt('EMAIL_QUEUE_RETENTION_DAYS', 30);
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  var done = { 'SENT': 1, 'BLOCKED': 1, 'CANCELLED': 1, 'FAILED': 1 };
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var del = [];
  for (var i = 0; i < data.length; i++) {
    var status = _cellStr_(data[i], H, 'Status').toUpperCase();
    if (!done[status]) continue;                                  // keep PENDING / unknown
    var when = _coerceDate_(_cellStr_(data[i], H, 'Sent At') || _cellStr_(data[i], H, 'Created At'));
    if (!when || isNaN(when.getTime()) || when.getTime() > cutoff.getTime()) continue;
    del.push(i + 2);
  }
  del.sort(function (a, b) { return b - a; }).forEach(function (rn) { sh.deleteRow(rn); });
  return String(del.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────

function PIPELINE_DEDUP_selfTest() {
  var out = ['[DEDUP] selfTest (read-only)…'];
  out.push('  - AUTO_MAINTENANCE_ENABLED   : ' + CFG.getBool('AUTO_MAINTENANCE_ENABLED', true));
  out.push('  - AUTO_DEDUP_ENABLED         : ' + CFG.getBool('AUTO_DEDUP_ENABLED', true));
  out.push('  - PURGE_STALE_SHELL_DAYS     : ' + CFG.getInt('PURGE_STALE_SHELL_DAYS', 30));
  out.push('  - EMAIL_QUEUE_RETENTION_DAYS : ' + CFG.getInt('EMAIL_QUEUE_RETENTION_DAYS', 30));
  var plan = _planPipelineCandidateDedup_();
  if (plan) {
    out.push('  - Pipeline rows              : ' + plan.totalRows);
    out.push('  - Unique people after dedup  : ' + plan.keepers.length);
    out.push('  - Duplicate rows to merge    : ' + plan.toDelete.length);
  } else {
    out.push('  ! Interview Pipeline sheet not found');
  }
  out.push('  Run previewPipelineDedup() to see the full per-person plan.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
