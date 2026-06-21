/**
 * 17_Errors_Logs.gs
 * Frank's European Service — Recruiting OS
 *
 * Centralized logging primitives. Three classes of events:
 *   - Errors   → Error Log    (severity: INFO | WARN | ERROR | CRITICAL)
 *   - Events   → Event Log    (business events: applied, scored, emailed, etc.)
 *   - Quick    → Logger.log() (always, in addition to sheet logging)
 *
 * Design rules:
 *   - These helpers MUST NEVER throw. A logging failure cannot break a caller.
 *   - All writes go through appendRowByHeader_ so column order can evolve.
 *   - CRITICAL errors also fire an email alert (one per hour per label,
 *     gated by ERROR_ALERT_RECIPIENTS and the SEND_ENABLED master switch).
 *   - Log sheets are pruned on demand by pruneLogs() to keep size sane.
 *
 * Public functions:
 *   logError_(label, errOrMessage, candidateId, severity)
 *   logEvent_(eventName, candidateId, details)
 *   pruneLogs(maxRows)
 *   viewRecentErrors(n)
 *   ERRORS_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: logError_
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an error or warning. Safe to call from anywhere — never throws.
 *
 * @param {string} label         Short tag identifying the caller (e.g. 'intake:onPreScreenSubmit')
 * @param {Error|string} errOrMessage  Error object (preferred) or string message
 * @param {string=} candidateId  Optional candidate ID to associate
 * @param {string=} severity     'INFO' | 'WARN' | 'ERROR' (default) | 'CRITICAL'
 */
function logError_(label, errOrMessage, candidateId, severity) {
  try {
    severity = String(severity || 'ERROR').toUpperCase();
    var msg = '', stack = '';
    if (errOrMessage && typeof errOrMessage === 'object') {
      msg   = String(errOrMessage.message || errOrMessage);
      stack = String(errOrMessage.stack  || '');
    } else {
      msg = String(errOrMessage == null ? '' : errOrMessage);
    }

    // Always emit to Logger so it shows in Execution log even if sheet write fails
    Logger.log('[' + severity + '] ' + String(label) + ' — ' + msg);

    // Lean architecture: one System Log for events + errors + overrides + skips.
    var sh = getSheetOrNull_(SHEETS.SYSTEM_LOG) || getSheetOrNull_(SHEETS.ERROR_LOG);
    if (sh) {
      appendRowByHeader_(sh, {
        'Timestamp':         shopDateTime_(),
        'Type':              'ERROR',
        'Severity':          severity,
        'Label / Event':     String(label || ''),
        'Candidate ID':      String(candidateId || ''),
        'Function':          _callerHint_(stack),
        'Message / Details': truncate_(msg, 1000),
        // back-compat with the old Error Log schema if that's still the target
        'Label':             String(label || ''),
        'Message':           truncate_(msg, 1000),
        'Stack':             truncate_(stack, 4000),
        'Notes':             ''
      });
    }

    if (severity === 'CRITICAL') _maybeAlertCritical_(label, msg);
  } catch (e) {
    // Last-resort: never let logging itself crash a caller
    try { Logger.log('logError_ itself failed: ' + e); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: logEvent_
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a normal business event.
 *
 * @param {string} eventName     e.g. 'CANDIDATE_INTAKE', 'EMAIL_QUEUED', 'TRANSCRIPT_MATCHED'
 * @param {string=} candidateId
 * @param {object|string=} details  Object → JSON.stringified. String → used as-is.
 */
function logEvent_(eventName, candidateId, details) {
  try {
    var detailsStr = '';
    if (details && typeof details === 'object') {
      try { detailsStr = JSON.stringify(details); } catch (e) { detailsStr = String(details); }
    } else {
      detailsStr = String(details == null ? '' : details);
    }
    Logger.log('[EVENT] ' + String(eventName) + (candidateId ? ' (' + candidateId + ')' : '') +
               (detailsStr ? ' — ' + truncate_(detailsStr, 200) : ''));

    var sh = getSheetOrNull_(SHEETS.SYSTEM_LOG) || getSheetOrNull_(SHEETS.EVENT_LOG);
    if (sh) {
      appendRowByHeader_(sh, {
        'Timestamp':         shopDateTime_(),
        'Type':              'EVENT',
        'Severity':          'INFO',
        'Label / Event':     String(eventName || ''),
        'Candidate ID':      String(candidateId || ''),
        'Function':          _callerHint_(),
        'Message / Details': truncate_(detailsStr, 4000),
        // back-compat with the old Event Log schema if that's still the target
        'Event':             String(eventName || ''),
        'Details':           truncate_(detailsStr, 4000),
        'Notes':             ''
      });
    }
  } catch (e) {
    try { Logger.log('logEvent_ failed: ' + e); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL ALERTS — at most one per (label) per hour, gated by SEND_ENABLED
// ─────────────────────────────────────────────────────────────────────────────
function _maybeAlertCritical_(label, msg) {
  try {
    // F9: internal CRITICAL alerts are NOT gated by SEND_ENABLED. They are not
    // candidate-facing, and the moments the system is most likely broken (kill
    // switch off / pre-launch) are exactly when these alerts matter most.
    var recipients = CFG.getList('ERROR_ALERT_RECIPIENTS');
    if (!recipients.length) {
      Logger.log('[CRITICAL alert NOT sent — ERROR_ALERT_RECIPIENTS is empty in Config] ' + label);
      return;
    }

    // Rate-limit by label
    var props = PropertiesService.getScriptProperties();
    var key = 'CRIT_ALERT_LAST::' + String(label).substring(0, 80);
    var lastIso = props.getProperty(key);
    if (lastIso) {
      var ageH = hoursSince_(lastIso);
      if (ageH < 1) {
        Logger.log('[CRITICAL alert suppressed — already sent within 1 hour for label "' + label + '"]');
        return;
      }
    }
    props.setProperty(key, nowISO_());

    var subj = '[Recruiting OS CRITICAL] ' + truncate_(String(label), 80);
    var body =
'CRITICAL error in Recruiting OS.\n\n' +
'Label   : ' + label + '\n' +
'Time    : ' + shopDateTime_() + '\n' +
'Mode    : ' + (isLiveMode_() ? 'LIVE' : 'TEST') + '\n' +
'Message : ' + msg + '\n\n' +
'See Error Log tab for full stack trace.\n' +
'(Rate-limited: at most one alert per hour per label.)';

    // Internal alerts are not candidate-facing, so they go to recipients as-is
    // even in TEST mode — that's the whole point of CRITICAL alerts.
    // Using GmailApp (mail.google.com scope) — MailApp would need a separate scope.
    recipients.forEach(function (to) {
      try {
        GmailApp.sendEmail(to, subj, body, {
          name: CFG.get('EMAIL_FROM_NAME', "Frank's Recruiting OS")
        });
      } catch (e) { Logger.log('CRITICAL alert send failed for ' + to + ': ' + e); }
    });
  } catch (e) {
    try { Logger.log('_maybeAlertCritical_ failed: ' + e); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prune the four log sheets to at most maxRows recent rows. Default 5000.
 * Removes oldest rows first. Safe to run any time.
 */
function pruneLogs(maxRows) {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('pruneLogs', 'OK');
  maxRows = parseInt(maxRows, 10) || 5000;
  var sheets = [
    SHEETS.SYSTEM_LOG, SHEETS.NOTIFICATION_LOG, SHEETS.AI_GRADING_LOGS,
    SHEETS.DAILY_DIGEST_LOG
  ];
  var summary = {};
  sheets.forEach(function (name) {
    safeRun_('pruneLogs:' + name, function () {
      summary[name] = _pruneSheet_(name, maxRows);
    });
  });
  var msg = '[LOGS] pruneLogs(' + maxRows + ') → ' + JSON.stringify(summary);
  Logger.log(msg);
  return msg;
}

function _pruneSheet_(sheetName, maxRows) {
  var sh = getSheetOrNull_(sheetName);
  if (!sh) return { kept: 0, deleted: 0, status: 'MISSING' };
  var dataRows = sh.getLastRow() - 1; // exclude header
  if (dataRows <= maxRows) return { kept: dataRows, deleted: 0 };
  var toDelete = dataRows - maxRows;
  // Delete from row 2 downward (oldest at top assuming chronological writes)
  sh.deleteRows(2, toDelete);
  return { kept: maxRows, deleted: toDelete };
}

/** Quick view of the most recent N errors/warnings from the System Log. Default 10. */
function viewRecentErrors(n) {
  n = parseInt(n, 10) || 10;
  var sh = getSheetOrNull_(SHEETS.SYSTEM_LOG) || getSheetOrNull_(SHEETS.ERROR_LOG);
  if (!sh) return '[LOGS] System Log sheet missing.';
  var last = sh.getLastRow();
  if (last < 2) return '[LOGS] no rows logged.';
  var headers = getHeaderRow_(sh);
  function col() { for (var i = 0; i < arguments.length; i++) { var idx = headers.indexOf(arguments[i]); if (idx !== -1) return idx; } return -1; }
  var cTs = col('Timestamp'), cSev = col('Severity'), cLab = col('Label / Event', 'Label', 'Event'),
      cMsg = col('Message / Details', 'Message', 'Details'), cType = col('Type');
  // Read the whole table (logs are pruned, so this stays bounded) and keep the
  // most recent rows that are errors/warnings.
  var rows = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var hits = [];
  for (var i = rows.length - 1; i >= 0 && hits.length < n; i--) {
    var sev = cSev !== -1 ? String(rows[i][cSev] || '').toUpperCase() : '';
    var type = cType !== -1 ? String(rows[i][cType] || '').toUpperCase() : '';
    var isErr = (type === 'ERROR') || sev === 'ERROR' || sev === 'CRITICAL' || sev === 'WARN';
    if (cType === -1 && cSev === -1) isErr = true; // legacy Error Log: every row counts
    if (!isErr) continue;
    hits.push('  · ' + (cTs !== -1 ? rows[i][cTs] : '') + ' [' + sev + '] ' +
              (cLab !== -1 ? rows[i][cLab] : '') + ' — ' + truncate_(String(cMsg !== -1 ? rows[i][cMsg] : ''), 140));
  }
  var s = ['[LOGS] last ' + hits.length + ' error/warning(s):'].concat(hits).join('\n');
  Logger.log(s);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort caller hint from a stack trace. Returns 'unknown' if none.
 * Looks for the first user function frame after logError_/_callerHint_.
 */
function _callerHint_(stack) {
  try {
    if (!stack) {
      try { throw new Error('x'); } catch (e) { stack = e.stack || ''; }
    }
    var lines = String(stack).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/_callerHint_|logError_|logEvent_|^Error/.test(ln)) continue;
      var m = ln.match(/at\s+(\S+)\s*\(/);
      if (m && m[1] && m[1] !== 'Object') return m[1];
    }
    return 'unknown';
  } catch (e) { return 'unknown'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — writes three rows then leaves them (real log entries).
// Safe to run any time. Touches no candidate data.
// ─────────────────────────────────────────────────────────────────────────────
function ERRORS_selfTest() {
  var out = ['[ERRORS] selfTest starting…'];
  var sys = getSheetOrNull_(SHEETS.SYSTEM_LOG) || getSheetOrNull_(SHEETS.ERROR_LOG);
  out.push('  ─ System Log sheet : ' + (sys ? 'OK' : 'MISSING — run bootstrapSystem()'));

  var before = sys ? sys.getLastRow() : 0;

  // 1) String form (WARN)
  logError_('ERRORS_selfTest', 'Test WARNING (ignore)', '', 'WARN');
  // 2) Error object form (ERROR)
  try { JSON.parse('{not valid'); } catch (e) {
    logError_('ERRORS_selfTest:parseDemo', e, 'FES-TEST-00000000', 'ERROR');
  }
  // 3) Event with object details (EVENT)
  logEvent_('SELFTEST_EVENT', '', { source: 'ERRORS_selfTest', mode: isLiveMode_() ? 'LIVE' : 'TEST' });

  var after = sys ? sys.getLastRow() : 0;
  out.push('  ' + (after - before === 3 ? '✓' : '✗') + ' System Log rows added: ' + (after - before) + ' (expected 3 — 2 error/warn + 1 event)');

  // 4) Quick view
  out.push('  ─ viewRecentErrors(3) output below:');
  out.push(viewRecentErrors(3));

  out.push('[ERRORS] selfTest done. Test log entries left in place for review.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
