/**
 * 27_Hiring_Email_Leads.gs
 * Frank's European Service — Recruiting OS
 *
 * Parses the hiring Gmail inbox for candidates who applied via Indeed or ACT
 * Auto Staffing but never completed the Pre-Screen form, records them in
 * "Raw Hiring Email Leads", creates/links a candidate lead, and sends the
 * Pre-Screen invite — once, respecting TEST/LIVE email safety.
 *
 * Public functions:
 *   runHiringEmailLeadImport()              — daily entrypoint (import + process)
 *   importHiringEmailLeads()                — scan Gmail → Raw Hiring Email Leads
 *   processHiringEmailLeads()               — link candidates + send invites
 *   parseIndeedCandidateEmail_(message)     — returns parsed lead fields
 *   parseActAutoStaffingCandidateEmail_(message)
 *   sendPreScreenInviteToLead_(candidateId)
 *   HIRING_LEADS_selfTest()
 *
 * Dedupe: by Gmail Message ID (no duplicate lead rows), by email+role
 * (candidateIdFromEmail_ is deterministic → no duplicate candidates), and by
 * Pre-Screen Invite Status (no candidate is emailed the invite twice).
 */

// ─────────────────────────────────────────────────────────────────────────────
// DAILY ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────
function runHiringEmailLeadImport() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('runHiringEmailLeadImport', 'OK');
  return safeRun_('runHiringEmailLeadImport', function () {
    if (!CFG.getBool('HIRING_GMAIL_LEAD_IMPORT_ENABLED', true)) return '[LEADS] disabled';
    var imp = importHiringEmailLeads();
    var proc = processHiringEmailLeads();
    var msg = '[LEADS] runHiringEmailLeadImport — ' + imp + ' | ' + proc;
    Logger.log(msg);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT — scan Gmail into Raw Hiring Email Leads
// ─────────────────────────────────────────────────────────────────────────────
function importHiringEmailLeads() {
  return withLock_(function () {
    if (!CFG.getBool('HIRING_GMAIL_LEAD_IMPORT_ENABLED', true)) return 'disabled';
    var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
    var seen = _existingLeadMessageIds_(sh);
    var summary = { indeed: 0, act: 0, parsed: 0, needsReview: 0, duplicates: 0 };

    var sources = [
      { source: 'Indeed', query: CFG.get('INDEED_GMAIL_QUERY', 'from:(indeed.com OR indeedemail.com) newer_than:14d'),
        parser: parseIndeedCandidateEmail_ },
      { source: 'ACT Auto Staffing', query: CFG.get('ACT_AUTO_STAFFING_GMAIL_QUERY', 'from:(actautostaffing.com) newer_than:14d'),
        parser: parseActAutoStaffingCandidateEmail_ }
    ];

    sources.forEach(function (src) {
      var threads;
      try { threads = GmailApp.search(src.query, 0, 50); }
      catch (e) { logError_('importHiringEmailLeads:search', e, '', 'WARN'); return; }
      threads.forEach(function (thread) {
        var threadId = thread.getId();
        thread.getMessages().forEach(function (message) {
          var mid = message.getId();
          if (seen[mid]) { summary.duplicates++; return; }
          seen[mid] = true;

          var parsed = src.parser(message) || {};
          var hasEnough = parsed.email || parsed.phone || parsed.name;
          var status = hasEnough ? 'PARSED' : 'NEEDS REVIEW';
          if (status === 'PARSED') summary.parsed++; else summary.needsReview++;
          if (src.source === 'Indeed') summary.indeed++; else summary.act++;

          appendRowByHeader_(sh, {
            'Timestamp':              shopDateTime_(),
            'Source':                 src.source,
            'Gmail Message ID':       mid,
            'Thread ID':              threadId,
            'Received Date':          message.getDate(),
            'Subject':                message.getSubject(),
            'Sender':                 message.getFrom(),
            'Candidate Name':         parsed.name || '',
            'Candidate Email':        parsed.email || '',
            'Candidate Phone':        parsed.phone || '',
            'Role Applied':           parsed.role ? normalizeRole_(parsed.role) : '',
            'Resume Link':            parsed.resume || '',
            'Raw Snippet':            truncate_(String(message.getPlainBody() || '').replace(/\s+/g, ' ').trim(), 1500),
            'Parsed Status':          status,
            'Candidate ID':           '',
            'Pre-Screen Invite Status': '',
            'Email Sent At':          '',
            'Error':                  '',
            'Notes':                  ''
          });
        });
      });
    });

    var msg = 'imported ' + JSON.stringify(summary);
    Logger.log('[LEADS] ' + msg);
    logEvent_('HIRING_LEADS_IMPORTED', '', summary);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────────────────────
function parseIndeedCandidateEmail_(message) {
  var subject = String(message.getSubject() || '');
  var body    = String(message.getPlainBody() || '');
  var from    = String(message.getFrom() || '');
  var f = _extractLeadFields_(subject, body);

  // Indeed encodes both name AND a working relay address in the From header:
  //   "Michael Brown <conversation-michaelbrown-xxxxx@indeedemail.com>"
  // The @indeedemail.com address is the *correct* contact — Indeed forwards it
  // to the candidate; their real address is intentionally hidden.
  var fromMatch = from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (fromMatch) {
    if (!f.name)  f.name  = fromMatch[1].trim();
    if (!f.email) f.email = normalizeEmail_(fromMatch[2]);
  }

  // Indeed subjects:
  //   "[Action required] New application for <Role>, Las Vegas, NV"
  //   "Jane Doe applied to <Role>"
  if (!f.name) {
    var m = subject.match(/^(.+?)\s+(?:applied|has applied)/i);
    if (m) f.name = m[1].trim();
  }
  if (!f.role) {
    var r = subject.match(/new application for\s+(.+?)(?:,\s*[A-Za-z .]+,\s*[A-Z]{2}|$)/i) ||
            subject.match(/applied (?:to|for)(?: the)?\s+(.+?)(?:\s+(?:at|position|role)\b|$)/i) ||
            // "New Message from <Name> - <Role>" — candidate reply to a prior invite;
            // role appears in the subject after the dash.
            subject.match(/^new message from\s+.+?\s+[-–]\s+(.+)$/i) ||
            body.match(/applied to the\s+(.+?)\s+position/i);
    if (r) f.role = r[1].trim();
  }
  // "Ben Orr and 9 others applied" — bundled digest, not actionable per-candidate.
  if (/and\s+\d+\s+others?\s+applied/i.test(subject) || /and\s+\d+\s+others?\s+applied/i.test(body)) {
    f.name = ''; f.email = ''; // force NEEDS REVIEW
  }
  return f;
}

function parseActAutoStaffingCandidateEmail_(message) {
  var subject = String(message.getSubject() || '');
  var body    = String(message.getPlainBody() || '');
  var f = _extractLeadFields_(subject, body);
  // ACT subjects vary; try "Candidate: Name - Role" or "Name applied"
  if (!f.name) {
    var m = subject.match(/candidate[:\-]\s*([A-Za-z][A-Za-z .'\-]+)/i) ||
            subject.match(/^([A-Za-z][A-Za-z .'\-]+?)\s+(?:applied|submitted)/i);
    if (m) f.name = m[1].trim();
  }
  if (!f.role) {
    var r = subject.match(/(?:for|position|role)[:\-]?\s+([A-Za-z][A-Za-z /&\-]+)$/i);
    if (r) f.role = r[1].trim();
  }
  return f;
}

/** Shared best-effort field extraction from subject + plain body. */
function _extractLeadFields_(subject, body) {
  var text = subject + '\n' + body;
  var out = { name: '', email: '', phone: '', role: '', resume: '', snippet: truncate_(body.replace(/\s+/g, ' ').trim(), 500) };

  // Email — first address that is not an obvious notification/no-reply.
  // NB: indeedemail.com / actautostaffing.com are NOT excluded here — those are
  // working relay addresses that forward to the candidate. The Indeed/ACT
  // parsers can still override this with the From-header relay address.
  var emails = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  var blocked = /(frankseuropeanservice\.com|no-?reply|notification|employers-noreply)/i;
  for (var i = 0; i < emails.length; i++) {
    if (!blocked.test(emails[i])) { out.email = normalizeEmail_(emails[i]); break; }
  }

  // Phone
  var phone = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  if (phone) out.phone = normalizePhone_(phone[0]);

  // Name from body labels like "Name: Jane Doe" / "Candidate Name: ..."
  var nm = body.match(/(?:candidate\s+name|applicant|name)\s*[:\-]\s*([A-Za-z][A-Za-z .'\-]{1,60})/i);
  if (nm) out.name = nm[1].trim();

  // Resume / application link
  var link = text.match(/https?:\/\/\S*(?:resume|cv|application|apply|profile)\S*/i);
  if (link) out.resume = link[0].replace(/[)>\].,]+$/, '');

  return out;
}

/**
 * Re-parse every existing Raw Hiring Email Lead row by re-fetching the Gmail
 * message and running the (improved) parser. Updates only fields we extracted;
 * leaves Pre-Screen Invite Status untouched so invites aren't re-fired. Safe
 * to re-run.
 */
function reparseHiringEmailLeads() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
    var last = sh.getLastRow();
    if (last < 2) return 'no leads';
    var headers = getHeaderRow_(sh);
    var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var summary = { scanned: 0, reparsed: 0, missing: 0, errors: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var rowNum = i + 2;
      var mid = String(data[i][idx['Gmail Message ID']] || '').trim();
      var src = String(data[i][idx['Source']] || '');
      if (!mid) { summary.missing++; continue; }
      try {
        var msg = GmailApp.getMessageById(mid);
        if (!msg) { summary.missing++; continue; }
        var parsed = (src === 'Indeed' ? parseIndeedCandidateEmail_(msg)
                    : src === 'ACT Auto Staffing' ? parseActAutoStaffingCandidateEmail_(msg)
                    : _extractLeadFields_(msg.getSubject() || '', msg.getPlainBody() || '')) || {};
        var updates = {
          'Candidate Name':  parsed.name  || data[i][idx['Candidate Name']] || '',
          'Candidate Email': parsed.email || data[i][idx['Candidate Email']] || '',
          'Candidate Phone': parsed.phone || data[i][idx['Candidate Phone']] || '',
          'Role Applied':    parsed.role  ? normalizeRole_(parsed.role) : (data[i][idx['Role Applied']] || ''),
          'Resume Link':     parsed.resume || data[i][idx['Resume Link']] || '',
          'Raw Snippet':     truncate_(String(msg.getPlainBody() || '').replace(/\s+/g, ' ').trim(), 1500),
          'Parsed Status':   (parsed.email || parsed.name) ? 'PARSED' : 'NEEDS REVIEW'
        };
        batchUpdateRow_(sh, rowNum, updates);
        summary.reparsed++;
      } catch (e) {
        summary.errors++;
        logError_('reparseHiringEmailLeads:row' + rowNum, e, '', 'WARN');
      }
    }
    var msg = 'reparsed ' + JSON.stringify(summary);
    Logger.log('[LEADS] ' + msg);
    logEvent_('HIRING_LEADS_REPARSED', '', summary);
    toast_('Re-parsed ' + summary.reparsed + ' leads', 'Recruiting OS', 6);
    return msg;
  });
}

/**
 * Reset Pre-Screen Invite Status on lead rows that were "INVITE SENT" in TEST
 * mode so processHiringEmailLeads will pick them up again. Does NOT send any
 * emails — that happens when you re-run processHiringEmailLeads + flushEmailQueue
 * (in whatever mode the system is in at that time).
 *
 * Safety: only resets rows where invite was marked SENT and a Candidate ID is
 * present (i.e., the lead is fully linked). Leaves NEEDS REVIEW / NEEDS EMAIL /
 * ERROR / ALREADY COMPLETED rows untouched.
 */
function resendQueuedLeadInvites() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
    var last = sh.getLastRow();
    if (last < 2) return 'no leads';
    var headers = getHeaderRow_(sh);
    var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var reset = 0;
    for (var i = 0; i < data.length; i++) {
      var status = String(data[i][idx['Pre-Screen Invite Status']] || '').trim().toUpperCase();
      var cid    = String(data[i][idx['Candidate ID']] || '').trim();
      if (status !== 'INVITE SENT' || !cid) continue;
      batchUpdateRow_(sh, i + 2, {
        'Pre-Screen Invite Status': '',
        'Email Sent At':            '',
        'Notes':                    'Reset from TEST INVITE SENT for live resend at ' + shopDateTime_()
      });
      reset++;
    }
    var msg = 'reset ' + reset + ' lead row(s) — now run processHiringEmailLeads (and flushEmailQueue) to invite them';
    Logger.log('[LEADS] ' + msg);
    logEvent_('HIRING_LEADS_RESET_FOR_RESEND', '', { reset: reset });
    toast_(msg, 'Recruiting OS', 8);
    return msg;
  });
}

/**
 * For every lead with a linked Candidate ID and a real Role Applied, update
 * the candidate's Role in All Candidates. Use this after reparseHiringEmailLeads
 * to fix candidates that were created earlier with Role='Unknown' because the
 * lead row hadn't been parsed yet. Does not send any emails.
 */
function syncLeadRolesToCandidates() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
    var last = sh.getLastRow();
    if (last < 2) return 'no leads';
    var headers = getHeaderRow_(sh);
    var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var summary = { scanned: 0, updated: 0, skippedNoChange: 0, missingCandidate: 0, skippedNoRole: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var cid  = String(data[i][idx['Candidate ID']] || '').trim();
      var role = String(data[i][idx['Role Applied']] || '').trim();
      if (!cid) { summary.missingCandidate++; continue; }
      if (!role) { summary.skippedNoRole++; continue; }
      var canon = normalizeRole_(role);
      var hits = findRowsByColumnValue_(ac, 'Candidate ID', cid);
      if (!hits.length) { summary.missingCandidate++; continue; }
      var current = String(hits[0].data['Role'] || '').trim();
      if (current === canon) { summary.skippedNoChange++; continue; }
      updateRowWhere_(ac, 'Candidate ID', cid, { 'Role': canon, 'Last Updated': shopDateTime_() });
      summary.updated++;
    }
    var msg = 'sync ' + JSON.stringify(summary);
    Logger.log('[LEADS] ' + msg);
    logEvent_('HIRING_LEADS_ROLE_SYNC', '', summary);
    toast_('Synced ' + summary.updated + ' candidate roles from leads', 'Recruiting OS', 6);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS — link candidates + send Pre-Screen invites
// ─────────────────────────────────────────────────────────────────────────────
function processHiringEmailLeads() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
    var last = sh.getLastRow();
    if (last < 2) return 'no leads';
    var headers = getHeaderRow_(sh);
    var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
    var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
    var inviteEnabled = CFG.getBool('PRESCREEN_INVITE_FOR_IMPORTED_LEADS_ENABLED', true);
    var summary = { scanned: 0, alreadyCompleted: 0, invited: 0, linkedExisting: 0, createdNew: 0, needsEmail: 0, skipped: 0, errors: 0 };

    for (var i = 0; i < data.length; i++) {
      summary.scanned++;
      var rowNum = i + 2;
      var r = data[i];
      var inviteStatus = String(r[idx['Pre-Screen Invite Status']] || '').trim();
      if (String(r[idx['Parsed Status']]) === 'NEEDS REVIEW') { summary.skipped++; continue; }
      if (inviteStatus) { summary.skipped++; continue; } // already handled in a prior run

      var email = String(r[idx['Candidate Email']] || '').trim();
      var phone = String(r[idx['Candidate Phone']] || '').trim();
      var name  = String(r[idx['Candidate Name']] || '').trim();
      var role  = String(r[idx['Role Applied']] || '').trim() || 'Unknown';

      if (!email) {
        _setLeadStatus_(sh, rowNum, idx, '', 'NEEDS EMAIL', '', 'No candidate email parsed — cannot invite');
        summary.needsEmail++;
        continue;
      }

      try {
        // Resolve an existing candidate (email → phone → name+role).
        var res = _resolveBackfillCandidate_({ email: email, phone: phone, name: name, role: role });
        var cid = res.cid;
        var createdNew = false;

        if (cid) {
          var cand = _getCandidateRow_(cid) || {};
          if (_hasCompletedPreScreen_(cand)) {
            _setLeadStatus_(sh, rowNum, idx, cid, 'ALREADY COMPLETED', '', 'Candidate already completed pre-screen — no action');
            summary.alreadyCompleted++;
            continue;
          }
          summary.linkedExisting++;
        } else {
          cid = _upsertLeadCandidate_({ email: email, phone: phone, name: name, role: role,
            source: String(r[idx['Source']] || ''), resume: String(r[idx['Resume Link']] || '') });
          createdNew = true;
          summary.createdNew++;
        }

        if (!inviteEnabled) {
          _setLeadStatus_(sh, rowNum, idx, cid, 'INVITE DISABLED', '', 'PRESCREEN_INVITE_FOR_IMPORTED_LEADS_ENABLED is FALSE');
          continue;
        }

        sendPreScreenInviteToLead_(cid);
        _setLeadStatus_(sh, rowNum, idx, cid, 'INVITE SENT', shopDateTime_(),
          (createdNew ? 'New lead created; ' : 'Linked existing; ') + 'pre-screen invite queued');
        summary.invited++;
      } catch (e) {
        summary.errors++;
        _setLeadStatus_(sh, rowNum, idx, '', 'ERROR', '', e.message);
        logError_('processHiringEmailLeads:row' + rowNum, e, '', 'WARN');
      }
    }

    var msg = 'processed ' + JSON.stringify(summary);
    Logger.log('[LEADS] ' + msg);
    logEvent_('HIRING_LEADS_PROCESSED', '', summary);
    toast_('Leads: invited ' + summary.invited + ', already-done ' + summary.alreadyCompleted +
           ', need email ' + summary.needsEmail, 'Recruiting OS', 8);
    return msg;
  });
}

/** Queue the Pre-Screen invite to a candidate. Send safety (TEST/LIVE) is enforced by the queue. */
function sendPreScreenInviteToLead_(candidateId) {
  var cand = _getCandidateRow_(candidateId);
  if (!cand) throw new Error('sendPreScreenInviteToLead_: candidate not found: ' + candidateId);
  var email = String(cand['Email'] || '').trim();
  if (!email) throw new Error('sendPreScreenInviteToLead_: candidate has no email: ' + candidateId);

  var link = CFG.get('PRESCREEN_FORM_URL') || (typeof getFormUrl_ === 'function' ? getFormUrl_('PRESCREEN') : '');
  var qid = sendTemplatedEmail_('prescreen_invite', email, candidateId,
    { PrescreenFormLink: link },
    { reason: 'imported lead pre-screen invite' });

  // Mark the candidate as invited so we never double-send.
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  updateRowWhere_(ac, 'Candidate ID', candidateId, {
    'Form Sent':    shopDateTime_(),
    'Status':       STATUS.PRESCREEN_SENT,
    'Last Updated': shopDateTime_()
  });
  logEvent_('PRESCREEN_INVITE_QUEUED', candidateId, { to: email, queueId: qid });
  return qid;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _existingLeadMessageIds_(sh) {
  var seen = {};
  var last = sh.getLastRow();
  if (last < 2) return seen;
  var headers = getHeaderRow_(sh);
  var mi = headers.indexOf('Gmail Message ID');
  if (mi === -1) return seen;
  var vals = sh.getRange(2, mi + 1, last - 1, 1).getValues();
  vals.forEach(function (v) { var s = String(v[0] || '').trim(); if (s) seen[s] = true; });
  return seen;
}

/**
 * A candidate has completed pre-screen if Form Completed is set, the status is
 * past the invite stage, OR a sibling candidate row (same name + role) has
 * completed it. The sibling check handles the Indeed-relay flow: the relay
 * candidate's "email" is the indeedemail.com forwarder, but when the candidate
 * actually fills out the form they use their real email — creating a second
 * candidate row under that real address. Without name-matching we'd keep
 * inviting the relay candidate forever.
 */
function _hasCompletedPreScreen_(cand) {
  var notDone = { '': 1, 'NEW': 1, 'PRESCREEN_SENT': 1 };
  if (String(cand['Form Completed'] || '').trim()) return true;
  var st = String(cand['Status'] || '').trim().toUpperCase();
  if (!notDone[st]) return true;

  var name = String((cand['First Name'] || '') + ' ' + (cand['Last Name'] || '')).trim().toLowerCase();
  if (!name) return false;
  var role = String(cand['Role'] || '').trim().toLowerCase();
  var selfId = String(cand['Candidate ID'] || '').trim();

  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac) return false;
  var last = ac.getLastRow();
  if (last < 2) return false;
  var headers = getHeaderRow_(ac);
  var iF  = headers.indexOf('First Name'),  iL = headers.indexOf('Last Name'),
      iR  = headers.indexOf('Role'),        iC = headers.indexOf('Candidate ID'),
      iFC = headers.indexOf('Form Completed'), iSt = headers.indexOf('Status');
  if (iF === -1 || iL === -1) return false;
  var rows = ac.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (iC !== -1 && String(rows[i][iC] || '').trim() === selfId) continue;
    var rName = String((rows[i][iF] || '') + ' ' + (rows[i][iL] || '')).trim().toLowerCase();
    if (rName !== name) continue;
    if (role && iR !== -1 && String(rows[i][iR] || '').trim().toLowerCase() !== role) continue;
    if (iFC !== -1 && String(rows[i][iFC] || '').trim()) return true;
    var rSt = iSt !== -1 ? String(rows[i][iSt] || '').trim().toUpperCase() : '';
    if (rSt && !notDone[rSt]) return true;
  }
  return false;
}

/** Create or link an All Candidates lead row. Deterministic Candidate ID → no duplicates. */
function _upsertLeadCandidate_(f) {
  var ac = getSheet_(SHEETS.ALL_CANDIDATES);
  var role = f.role || 'Unknown';
  var cid = candidateIdFromEmail_(f.email, role);
  var parts = String(f.name || '').trim().split(/\s+/);
  var first = parts.shift() || '';
  var lastN = parts.join(' ');

  var existing = findRowsByColumnValue_(ac, 'Candidate ID', cid);
  if (existing.length) {
    updateRowWhere_(ac, 'Candidate ID', cid, { 'Last Updated': shopDateTime_() });
    return cid;
  }
  appendRowByHeader_(ac, {
    'Date Received': shopDateTime_(),
    'Role':          normalizeRole_(role),
    'First Name':    first,
    'Last Name':     lastN,
    'Email':         f.email,
    'Phone':         f.phone || '',
    'Source':        f.source || 'Email Import',
    'Resume Link':   f.resume || '',
    'Status':        STATUS.NEW,
    'Candidate ID':  cid,
    'Hiring Manager': CFG.get('HIRING_MANAGER_NAME'),
    'Last Updated':  shopDateTime_(),
    'Notes':         'Imported from ' + (f.source || 'email') + ' — pre-screen not completed'
  });
  return cid;
}

function _setLeadStatus_(sh, rowNum, idx, cid, inviteStatus, sentAt, note) {
  var updates = {};
  if (cid) updates['Candidate ID'] = cid;
  updates['Pre-Screen Invite Status'] = inviteStatus;
  if (sentAt) updates['Email Sent At'] = sentAt;
  if (inviteStatus === 'ERROR') updates['Error'] = note; else updates['Notes'] = note;
  batchUpdateRow_(sh, rowNum, updates);
}

/** No-arg diagnostic: find the first Indeed APPLICATION (subject contains
 *  "New application") and dump what the parser sees. */
function debugParseFirstIndeedLead() {
  var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
  var last = sh.getLastRow();
  if (last < 2) return 'no leads';
  var headers = getHeaderRow_(sh);
  var iSrc = headers.indexOf('Source'),
      iMid = headers.indexOf('Gmail Message ID'),
      iSub = headers.indexOf('Subject');
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][iSrc]) !== 'Indeed') continue;
    var mid = String(data[i][iMid] || '').trim();
    var sub = String(data[i][iSub] || '');
    if (!mid) continue;
    if (!/new application for/i.test(sub)) continue;
    Logger.log('[DEBUG] using lead row ' + (i + 2) + ' messageId=' + mid);
    return debugParseLead(mid);
  }
  return 'no Indeed application lead found (only "New Message from..." correspondence)';
}

/** No-arg diagnostic: parse the first ACT Auto Staffing lead row's Gmail message. */
function debugParseFirstActLead() {
  var sh = getSheet_(SHEETS.RAW_HIRING_EMAIL_LEADS);
  var last = sh.getLastRow();
  if (last < 2) return 'no leads';
  var headers = getHeaderRow_(sh);
  var iSrc = headers.indexOf('Source'), iMid = headers.indexOf('Gmail Message ID');
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][iSrc]) !== 'ACT Auto Staffing') continue;
    var mid = String(data[i][iMid] || '').trim();
    if (!mid) continue;
    Logger.log('[DEBUG] using lead row ' + (i + 2) + ' messageId=' + mid);
    var msg = GmailApp.getMessageById(mid);
    if (!msg) return 'message not found';
    Logger.log('[DEBUG] SUBJECT: >>>' + msg.getSubject() + '<<<');
    Logger.log('[DEBUG] FROM:    >>>' + msg.getFrom() + '<<<');
    Logger.log('[DEBUG] BODY[0..600]: >>>' + String(msg.getPlainBody() || '').substring(0, 600) + '<<<');
    var parsed = parseActAutoStaffingCandidateEmail_(msg);
    Logger.log('[DEBUG] parsed: ' + JSON.stringify(parsed));
    return JSON.stringify(parsed);
  }
  return 'no ACT Auto Staffing lead row found yet — run importHiringEmailLeads after your first ACT email arrives';
}

/** Diagnostic: dump what the Indeed parser sees for one Gmail message ID. */
function debugParseLead(gmailMessageId) {
  var msg = GmailApp.getMessageById(String(gmailMessageId || '').trim());
  if (!msg) { Logger.log('[DEBUG] message not found: ' + gmailMessageId); return 'not found'; }
  Logger.log('[DEBUG] SUBJECT: >>>' + msg.getSubject() + '<<<');
  Logger.log('[DEBUG] FROM:    >>>' + msg.getFrom() + '<<<');
  Logger.log('[DEBUG] BODY[0..400]: >>>' + String(msg.getPlainBody() || '').substring(0, 400) + '<<<');
  var roleMatch = (msg.getSubject() || '').match(/new application for\s+(.+?)(?:,\s*[A-Za-z .]+,\s*[A-Z]{2}|$)/i);
  Logger.log('[DEBUG] roleRegex match: ' + (roleMatch ? JSON.stringify({whole: roleMatch[0], group1: roleMatch[1]}) : 'NULL'));
  var parsed = parseIndeedCandidateEmail_(msg);
  Logger.log('[DEBUG] parsed: ' + JSON.stringify(parsed));
  return JSON.stringify(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST
// ─────────────────────────────────────────────────────────────────────────────
function HIRING_LEADS_selfTest() {
  var out = ['[LEADS] selfTest (read-only)…'];
  out.push('  ─ HIRING_GMAIL_LEAD_IMPORT_ENABLED       : ' + CFG.getBool('HIRING_GMAIL_LEAD_IMPORT_ENABLED', true));
  out.push('  ─ PRESCREEN_INVITE_FOR_IMPORTED_LEADS_ENABLED : ' + CFG.getBool('PRESCREEN_INVITE_FOR_IMPORTED_LEADS_ENABLED', true));
  out.push('  ─ INDEED_GMAIL_QUERY : ' + CFG.get('INDEED_GMAIL_QUERY'));
  out.push('  ─ ACT_AUTO_STAFFING_GMAIL_QUERY : ' + CFG.get('ACT_AUTO_STAFFING_GMAIL_QUERY'));
  out.push('  ─ Mode : ' + (isTestMode_() ? 'TEST → ' + CFG.get('TEST_RECIPIENT_EMAIL') : 'LIVE → candidate'));
  var sh = getSheetOrNull_(SHEETS.RAW_HIRING_EMAIL_LEADS);
  out.push('  ' + (sh ? '✓' : '✗') + ' Raw Hiring Email Leads tab present');
  out.push('  ' + (_loadEmailTemplate_('prescreen_invite') ? '✓' : '✗') + ' prescreen_invite template present');
  // Parser smoke test (no Gmail call)
  var fake = {
    getSubject: function () { return 'Jane Doe applied to Service Advisor'; },
    getPlainBody: function () { return 'Phone: (702) 555-1212\nEmail: jane.doe@example.com\nResume: https://indeed.com/r/resume/abc'; },
    getFrom: function () { return 'noreply@indeed.com'; },
    getId: function () { return 'TESTID'; }, getDate: function () { return new Date(); }
  };
  var p = parseIndeedCandidateEmail_(fake);
  out.push('  ─ parser demo → name="' + p.name + '" email="' + p.email + '" phone="' + p.phone + '" role="' + p.role + '"');
  out.push('[LEADS] selfTest done. Run importHiringEmailLeads() then processHiringEmailLeads().');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
