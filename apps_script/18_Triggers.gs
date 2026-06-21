/**
 * 18_Triggers.gs
 * Frank's European Service — Recruiting OS
 *
 * Single owner of all installable triggers. Run installAllTriggers() once
 * after pasting every other file. Safe to re-run any time — old triggers are
 * removed before new ones are installed.
 *
 * Triggers installed:
 *   • onPipelineEdit         spreadsheet onEdit              (manager dropdown actions)
 *   • Form submit per form   per-form onFormSubmit           (PRESCREEN, CULTURE_FIT,
 *                                                              REFERENCE_SUBMISSION,
 *                                                              REFERENCE_CHECK, SKILLS_TEST)
 *   • flushEmailQueue        daily at EMAIL_QUEUE_FLUSH_HOUR
 *   • runDailyDigest         twice daily at DAILY_DIGEST_AM_HOUR and _PM_HOUR
 *   • processRawOtterIntake  every 15 minutes
 *   • gradePendingTranscripts every 30 minutes
 *   • pollCalendarBookings   every 30 minutes
 *   • updateRecommendationEngineForAll  every hour
 *   • pruneLogs              daily 2am
 *   • autoMaintenance        daily 3am  (dedup + purge stale junk +
 *                                        reference/culture deadline reminders)
 *
 * Public functions:
 *   installAllTriggers()
 *   auditTriggers()          — refresh Trigger Health sheet
 *   removeAllTriggers()      — nuke every trigger this project owns
 *   TRIGGERS_selfTest()
 */

function installAllTriggers() {
  return withLock_(function () {
    // 1) Remove everything first to avoid duplicates
    _removeAllInstallable_();

    var summary = { installed: 0, forms: 0, time: 0, edit: 0, errors: 0, byName: {} };

    function add(name, fn) {
      try { fn(); summary.installed++; summary.byName[name] = 'OK'; }
      catch (e) { summary.errors++; summary.byName[name] = 'FAIL: ' + e.message;
                  logError_('installAllTriggers:' + name, e, '', 'ERROR'); }
    }

    var ss = SpreadsheetApp.getActive();

    // onEdit for Manager Decision (16_Dropdown_Actions)
    add('onPipelineEdit', function () {
      ScriptApp.newTrigger('onPipelineEdit').forSpreadsheet(ss).onEdit().create();
      summary.edit++;
    });

    // Per-form onFormSubmit
    if (typeof installAllFormTriggers === 'function') {
      add('formTriggers', function () {
        var res = installAllFormTriggers();
        Logger.log('formTriggers result: ' + res);
        summary.forms += getActiveFormKeys_().length;
      });
    }

    // Time-based triggers
    // F3: flush every 15 minutes (was once-daily) so delayed / quiet-hour /
    // future-dated emails actually leave and a backlog can drain. The flush is
    // lock-guarded and capped (MAX_PER_FLUSH), so frequent runs are safe.
    add('flushEmailQueue', function () {
      ScriptApp.newTrigger('flushEmailQueue').timeBased().everyMinutes(15).create();
      summary.time++;
    });

    // Digest goes out twice a day: a morning brief and an afternoon wrap-up.
    add('runDailyDigest:AM', function () {
      var amHour = CFG.getInt('DAILY_DIGEST_AM_HOUR', 7);
      ScriptApp.newTrigger('runDailyDigest').timeBased().everyDays(1).atHour(amHour).create();
      summary.time++;
    });
    add('runDailyDigest:PM', function () {
      var pmHour = CFG.getInt('DAILY_DIGEST_PM_HOUR', 16);
      ScriptApp.newTrigger('runDailyDigest').timeBased().everyDays(1).atHour(pmHour).create();
      summary.time++;
    });

    add('processRawOtterIntake', function () {
      ScriptApp.newTrigger('processRawOtterIntake').timeBased().everyMinutes(15).create();
      summary.time++;
    });

    add('gradePendingTranscripts', function () {
      ScriptApp.newTrigger('gradePendingTranscripts').timeBased().everyMinutes(30).create();
      summary.time++;
    });

    // Pull-based Gmail/Drive transcript ingestion (no-op until a Transcript
    // Sources row is set Active=TRUE; lock-guarded so it overlaps safely).
    if (typeof importTranscriptsFromSources === 'function') {
      add('importTranscriptsFromSources', function () {
        ScriptApp.newTrigger('importTranscriptsFromSources').timeBased().everyMinutes(30).create();
        summary.time++;
      });
    }

    add('pollCalendarBookings', function () {
      ScriptApp.newTrigger('pollCalendarBookings').timeBased().everyMinutes(30).create();
      summary.time++;
    });

    add('updateRecommendationEngineForAll', function () {
      ScriptApp.newTrigger('updateRecommendationEngineForAll').timeBased().everyHours(1).create();
      summary.time++;
    });

    add('runWorksheetDigest', function () {
      var wh = CFG.getInt('WORKSHEET_EMAIL_HOUR', 7);
      ScriptApp.newTrigger('runWorksheetDigest').timeBased().everyDays(1).atHour(wh).create();
      summary.time++;
    });

    add('runHiringEmailLeadImport', function () {
      ScriptApp.newTrigger('runHiringEmailLeadImport').timeBased().everyDays(1).atHour(6).create();
      summary.time++;
    });

    add('pruneLogs', function () {
      ScriptApp.newTrigger('pruneLogs').timeBased().everyDays(1).atHour(2).create();
      summary.time++;
    });

    add('autoMaintenance', function () {
      ScriptApp.newTrigger('autoMaintenance').timeBased().everyDays(1).atHour(3).create();
      summary.time++;
    });

    auditTriggers(); // refresh Trigger Health
    var msg = '[TRIGGERS] installAllTriggers — ' + JSON.stringify(summary);
    Logger.log(msg);
    toast_('Installed ' + summary.installed + ' triggers (' + summary.errors + ' errors)', 'Recruiting OS', 6);
    return msg;
  });
}

/** Remove every installable trigger this project owns. */
function removeAllTriggers() {
  var n = _removeAllInstallable_();
  Logger.log('[TRIGGERS] removeAllTriggers — removed ' + n);
  toast_('Removed ' + n + ' trigger(s)', 'Recruiting OS', 5);
  return '[TRIGGERS] removed ' + n;
}

function _removeAllInstallable_() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    try { ScriptApp.deleteTrigger(t); } catch (_) {}
  });
  return triggers.length;
}

/**
 * Refresh Trigger Health sheet with currently-installed triggers.
 * F10: real last-fired heartbeats (stamped by each handler via _triggerHeartbeat_)
 * are PRESERVED across an audit — keyed by handler Function — so a re-audit never
 * resets a healthy trigger's history. Also asserts the full expected trigger set
 * is installed and stamps a "Last Status" of MISSING for any expected handler
 * that is not actually installed, so a dead trigger looks different from a live one.
 */
function auditTriggers() {
  var sh = getSheetOrNull_(SHEETS.TRIGGER_HEALTH);
  if (!sh) return '[TRIGGERS] Trigger Health sheet missing';

  // 1) Snapshot existing heartbeats by Function before we rewrite.
  var prior = {}; // function -> { lastFired, lastStatus, notes }
  if (sh.getLastRow() > 1) {
    var ph = getHeaderRow_(sh);
    var pFn = ph.indexOf('Function'), pLF = ph.indexOf('Last Fired'),
        pLS = ph.indexOf('Last Status'), pNo = ph.indexOf('Notes');
    var pData = sh.getRange(2, 1, sh.getLastRow() - 1, ph.length).getValues();
    pData.forEach(function (r) {
      var fn = pFn !== -1 ? String(r[pFn] || '') : '';
      if (!fn) return;
      var lf = pLF !== -1 ? r[pLF] : '';
      // keep the most recent heartbeat we have seen for this function
      if (!prior[fn] || (lf && _coerceDate_(lf) > _coerceDate_(prior[fn].lastFired || 0))) {
        prior[fn] = { lastFired: lf, lastStatus: pLS !== -1 ? r[pLS] : '', notes: pNo !== -1 ? r[pNo] : '' };
      }
    });
  }

  // 2) Wipe data, keep header.
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();

  var triggers = ScriptApp.getProjectTriggers();
  var installedFns = {};
  triggers.forEach(function (t) {
    var type   = t.getEventType().toString();
    var fn     = t.getHandlerFunction();
    installedFns[fn] = true;
    var source = '';
    try {
      if (type === 'CLOCK')         source = 'time';
      else if (type === 'ON_FORM_SUBMIT' || type === 'ON_EDIT' || type === 'ON_CHANGE' || type === 'ON_OPEN') {
        source = t.getTriggerSourceId() || '';
      }
    } catch (_) { source = ''; }
    var p = prior[fn] || {};
    appendRowByHeader_(sh, {
      'Trigger Name':   t.getUniqueId(),
      'Function':       fn,
      'Type':           type,
      'Source':         source,
      'Last Installed': shopDateTime_(),
      'Last Fired':     p.lastFired || '',
      'Last Status':    p.lastStatus || 'INSTALLED (awaiting first run)',
      'Notes':          p.notes || ''
    });
  });

  // 3) Surface any EXPECTED handler that is NOT installed as a MISSING row.
  var expected = (typeof EXPECTED_TRIGGER_HANDLERS !== 'undefined') ? EXPECTED_TRIGGER_HANDLERS : [];
  var missing = [];
  expected.forEach(function (fn) {
    if (installedFns[fn]) return;
    missing.push(fn);
    appendRowByHeader_(sh, {
      'Trigger Name':   '(not installed)',
      'Function':       fn,
      'Type':           'EXPECTED',
      'Source':         '',
      'Last Installed': '',
      'Last Fired':     '',
      'Last Status':    'MISSING — run Install All Triggers',
      'Notes':          'Expected handler is not installed'
    });
  });

  return '[TRIGGERS] audit wrote ' + triggers.length + ' rows' +
         (missing.length ? ' — MISSING: ' + missing.join(', ') : '');
}

function TRIGGERS_selfTest() {
  var out = ['[TRIGGERS] selfTest (read-only)…'];
  var triggers = ScriptApp.getProjectTriggers();
  out.push('  ─ Total installed triggers: ' + triggers.length);
  var byHandler = {};
  triggers.forEach(function (t) {
    var k = t.getHandlerFunction();
    byHandler[k] = (byHandler[k] || 0) + 1;
  });
  Object.keys(byHandler).sort().forEach(function (k) {
    out.push('       · ' + k + ' × ' + byHandler[k]);
  });
  out.push('  ─ Run installAllTriggers() to install/repair the full set.');
  var msg = out.join('\n');
  Logger.log(msg); return msg;
}
