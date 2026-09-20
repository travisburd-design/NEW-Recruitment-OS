/**
 * 49_Go_Live_Tonight.gs  (v2 — STAGED cutover)
 * Frank's European Service — Recruiting OS
 *
 * WHY v2: the v1 orchestrator ran install + dedup + verify + a 20-call AI
 * re-score + a 50-tab reorganization in ONE execution. On a workbook this size,
 * with the 15-minute triggers also writing, Google threw
 * "Service Spreadsheets timed out while accessing document".
 *
 * v2 runs the SAME cutover as a chain of short stages. Each stage:
 *   • runs in its own execution (never near any time limit),
 *   • records its result to the "Go-Live Report" tab,
 *   • schedules a one-shot trigger for the next stage (~1 min later),
 *   • on a Sheets timeout, retries ITSELF up to 3 times before moving on.
 * The chain is fully unattended: press the button once, walk away, get an
 * email when the cutover is complete. Every stage is idempotent — pressing
 * the button again after a failure is always safe.
 *
 * STAGES
 *   1  Backstop enforce → TRUE, then V2_INSTALL (idempotent)
 *   2  Dedup — All Candidates (archive-based, reversible)
 *   3  Dedup — Interview Pipeline (existing 28_Pipeline_Dedup engine)
 *   4  V2_VERIFY (full pass/fail)
 *   5  Re-score open roles — batches of 8, repeats until every active
 *      Technician/Service Advisor has a Grade Detail row; candidates with no
 *      pre-screen on file are reported, not looped on forever
 *   6  Organize + color tabs
 *   7  Final report → Go-Live Report tab + email to the hiring manager
 *
 * Public functions:
 *   TONIGHT_GO_LIVE()            — start (or resume) the staged cutover
 *   TONIGHT_stageStep()          — the chain's trigger target (do not run by hand)
 *   TONIGHT_abortCutover()       — stop the chain, clear state
 *   TONIGHT_status()             — self-diagnosing snapshot, run anytime
 *   TONIGHT_dedupAllCandidates() — archive-based dedup (also callable alone)
 *   V2_organizeTabs()            — order + color + hide (also callable alone)
 */

var TONIGHT_REPORT_SHEET = 'Go-Live Report';
var CUTOVER_PROP         = 'CUTOVER_STATE';
var CUTOVER_RESCORE_CAP  = 8;     // AI calls per stage-5 execution (~100s, safe)
var CUTOVER_MAX_RETRIES  = 3;     // per-stage retries on a Sheets timeout

var CUTOVER_STAGE_NAMES = Object.freeze([
  'Backstop enforce + V2 install',
  'Dedup — All Candidates',
  'Dedup — Interview Pipeline',
  'Verification',
  'Re-score open roles',
  'Organize tabs',
  'Final report + email'
]);

// Progress rank for choosing which duplicate row survives.
var TONIGHT_STATUS_RANK = Object.freeze({
  'ARCHIVED': -2, 'REJECTED': -1, 'IN_DRAWER': 0, 'WITHDRAWN': 0,
  'NEW': 1, 'PRESCREEN_SENT': 2, 'PRESCREEN_RECEIVED': 3, 'SCORED': 4,
  'MANUAL_REVIEW': 5, 'AUTO_BOOK_SENT': 6, 'PHONE_BOOKED': 7, 'PHONE_DONE': 8,
  'FULL_BOOKED': 9, 'FULL_DONE': 10, 'WORKING_SCHEDULED': 11,
  'REFS_REQUESTED': 12, 'REFS_PENDING': 12, 'REFS_COMPLETE': 13,
  'RECOMMENDED': 14, 'OFFER_PENDING': 15, 'HIRED': 16
});

// ─────────────────────────────────────────────────────────────────────────────
// START / RESUME / ABORT
// ─────────────────────────────────────────────────────────────────────────────

function TONIGHT_GO_LIVE() {
  var props = PropertiesService.getScriptProperties();
  var chainPending = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'TONIGHT_stageStep';
  });
  var raw = props.getProperty(CUTOVER_PROP);

  if (raw && chainPending) {
    var st = JSON.parse(raw);
    var msg = 'Cutover already running — currently on stage ' + (st.stage + 1) + ' of ' +
              CUTOVER_STAGE_NAMES.length + ' (' + CUTOVER_STAGE_NAMES[st.stage] + ').\n' +
              'It continues on its own; watch the Go-Live Report tab.\n' +
              'To force a restart: run TONIGHT_abortCutover(), then press GO LIVE again.';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert('Go-Live', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
    return msg;
  }

  // Fresh start (also recovers cleanly from a previous failed/aborted run).
  TONIGHT_clearCutoverTriggers_();
  var state = {
    stage: 0, attempts: 0, prevRemaining: -1,
    startedAt: shopDateTime_(), summaries: []
  };
  props.setProperty(CUTOVER_PROP, JSON.stringify(state));

  var sh = getOrCreateSheet_(TONIGHT_REPORT_SHEET, ['Report']);
  sh.appendRow(['════ STAGED CUTOVER STARTED — ' + shopDateTime_() +
                ' ════\nStages run one at a time, about a minute apart. ' +
                'You will receive an email when the cutover is complete. ' +
                'This tab records every stage as it lands.']);
  logEvent_('CUTOVER_STARTED', '', {});

  var kickoff = 'Cutover started. Stage 1 is running now; the rest chain automatically. ' +
                'Watch the Go-Live Report tab — completion email lands when stage 7 finishes.';
  try { toast_(kickoff, 'Recruiting OS', 10); } catch (e) {}

  // Run stage 1 immediately in this execution; the chain takes over from there.
  return TONIGHT_stageStep();
}

function TONIGHT_abortCutover() {
  TONIGHT_clearCutoverTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(CUTOVER_PROP);
  var sh = getOrCreateSheet_(TONIGHT_REPORT_SHEET, ['Report']);
  sh.appendRow(['✋ CUTOVER ABORTED by user — ' + shopDateTime_()]);
  logEvent_('CUTOVER_ABORTED', '', {});
  var msg = 'Cutover chain stopped and state cleared. Press GO LIVE to start fresh (all stages are idempotent).';
  try { toast_(msg, 'Recruiting OS', 8); } catch (e) {}
  return msg;
}

function TONIGHT_clearCutoverTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'TONIGHT_stageStep' || fn === 'TONIGHT_resumeRescore') ScriptApp.deleteTrigger(t);
  });
}

function TONIGHT_scheduleStep_(delaySeconds) {
  TONIGHT_clearCutoverTriggers_();   // never stack chain triggers
  ScriptApp.newTrigger('TONIGHT_stageStep').timeBased().after(delaySeconds * 1000).create();
}

/** Legacy v1 continuation target — kept so any stray old trigger dies quietly. */
function TONIGHT_resumeRescore() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'TONIGHT_resumeRescore') ScriptApp.deleteTrigger(t);
  });
  return 'v1 rescore trigger retired — the staged cutover (TONIGHT_GO_LIVE) owns re-scoring now.';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CHAIN
// ─────────────────────────────────────────────────────────────────────────────

function TONIGHT_stageStep() {
  // One-shot triggers do not delete themselves — clean up whichever fired us.
  TONIGHT_clearCutoverTriggers_();

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(CUTOVER_PROP);
  if (!raw) return '[CUTOVER] no active state — start with TONIGHT_GO_LIVE()';
  var state = JSON.parse(raw);
  var stage = state.stage;
  if (stage >= CUTOVER_STAGE_NAMES.length) { props.deleteProperty(CUTOVER_PROP); return '[CUTOVER] already complete'; }

  var name = CUTOVER_STAGE_NAMES[stage];
  var result, failed = false, stayOnStage = false;

  try {
    switch (stage) {
      case 0: result = TONIGHT_stage_installAndEnforce_(); break;
      case 1: result = TONIGHT_dedupAllCandidates();       break;
      case 2: result = TONIGHT_stage_pipelineDedup_();     break;
      case 3: result = V2_VERIFY();                        break;
      case 4:
        var r = TONIGHT_rescoreBatch_(CUTOVER_RESCORE_CAP);
        result = r.text;
        // Keep re-running this stage while genuine progress is being made.
        if (r.remaining > 0 && (state.prevRemaining === -1 || r.remaining < state.prevRemaining)) {
          stayOnStage = true;
          state.prevRemaining = r.remaining;
        } else if (r.remaining > 0) {
          result += '\n⚠ ' + r.remaining + ' candidate(s) cannot be graded (no pre-screen response on file). ' +
                    'They are marked MANUAL_REVIEW — moving on.';
        }
        break;
      case 5: result = V2_organizeTabs();                  break;
      case 6: result = TONIGHT_stage_finalReport_(state);  break;
    }
  } catch (e) {
    failed = true;
    result = '✗ ' + e.message;
    var isTimeout = /timed out|timeout|Service Spreadsheets|Service error/i.test(e.message);
    logError_('CUTOVER:stage' + (stage + 1), e, '', 'ERROR');
    if (isTimeout && state.attempts < CUTOVER_MAX_RETRIES) {
      state.attempts++;
      props.setProperty(CUTOVER_PROP, JSON.stringify(state));
      TONIGHT_appendReport_('⏳ STAGE ' + (stage + 1) + ' — ' + name + ' — Sheets timed out (attempt ' +
                            state.attempts + '/' + CUTOVER_MAX_RETRIES + '). Retrying in ~2 minutes.\n' + e.message);
      TONIGHT_scheduleStep_(120);
      return '[CUTOVER] stage ' + (stage + 1) + ' timed out — retry ' + state.attempts + ' scheduled';
    }
  }

  // Record the stage outcome.
  var mark = failed ? '✗' : '✓';
  TONIGHT_appendReport_(mark + ' STAGE ' + (stage + 1) + '/' + CUTOVER_STAGE_NAMES.length +
                        ' — ' + name + ' — ' + shopDateTime_() + '\n' + String(result));
  state.summaries.push(mark + ' ' + name + (failed ? ' — FAILED: ' + String(result).substring(0, 160) : ''));

  // Advance (or repeat stage 5's batch).
  if (!stayOnStage) { state.stage = stage + 1; state.attempts = 0; if (stage === 4) state.prevRemaining = -1; }
  props.setProperty(CUTOVER_PROP, JSON.stringify(state));

  if (state.stage >= CUTOVER_STAGE_NAMES.length) {
    props.deleteProperty(CUTOVER_PROP);
    logEvent_('CUTOVER_COMPLETE', '', { failedStages: state.summaries.filter(function (s) { return s.indexOf('✗') === 0; }).length });
    return '[CUTOVER] complete';
  }
  TONIGHT_scheduleStep_(stayOnStage ? 45 : 60);
  return '[CUTOVER] stage ' + (stage + 1) + ' done → ' +
         (stayOnStage ? 'same stage continues (re-score batch)' : 'stage ' + (state.stage + 1) + ' scheduled');
}

function TONIGHT_appendReport_(text) {
  try {
    var sh = getOrCreateSheet_(TONIGHT_REPORT_SHEET, ['Report']);
    sh.appendRow([truncate_(text, 45000)]);
  } catch (e) { Logger.log('report append failed: ' + e.message + '\n' + text); }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE BODIES
// ─────────────────────────────────────────────────────────────────────────────

function TONIGHT_stage_installAndEnforce_() {
  var before = CFG.get('DETERMINISTIC_BACKSTOP_ENFORCE', 'FALSE');
  CFG.set('DETERMINISTIC_BACKSTOP_ENFORCE', 'TRUE');
  logEvent_('BACKSTOP_ENFORCE_ON', '', { before: before });
  var install = V2_INSTALL();
  return 'DETERMINISTIC_BACKSTOP_ENFORCE: ' + before + ' → TRUE (can force manual review; can never reject)\n\n' + install;
}

function TONIGHT_stage_pipelineDedup_() {
  if (typeof dedupePipelineCandidates !== 'function') return 'pipeline dedup module not present — skipped';
  var preview = (typeof previewPipelineDedup === 'function') ? String(previewPipelineDedup()) : '';
  var result = String(dedupePipelineCandidates({ silent: true }));
  return preview + '\n' + result;
}

function TONIGHT_stage_finalReport_(state) {
  var status = '';
  try { status = TONIGHT_status(); } catch (e) { status = '(status snapshot failed: ' + e.message + ')'; }
  var failures = state.summaries.filter(function (s) { return s.indexOf('✗') === 0; });
  var body =
    '════ GO-LIVE COMPLETE — ' + shopDateTime_() + ' ════\n' +
    'Started: ' + state.startedAt + '\n' +
    'Mode: ' + CFG.get('SYSTEM_MODE') + ' · SEND_ENABLED=' + CFG.get('SEND_ENABLED') +
    ' · V2=' + CFG.get('GRADING_V2_ENABLED', 'TRUE') +
    ' · AutoAdvance=' + CFG.get('AUTO_ADVANCE_LIVE_ENABLED', 'TRUE') +
    ' · BackstopEnforce=' + CFG.get('DETERMINISTIC_BACKSTOP_ENFORCE') + '\n\n' +
    'STAGES:\n  ' + state.summaries.join('\n  ') + '\n\n' +
    (failures.length
      ? '⚠ ' + failures.length + ' stage(s) failed — full detail is in the Go-Live Report tab.\n\n'
      : 'All stages passed.\n\n') +
    status + '\n\n' +
    'Morning routine: 🩺 System Status → open the Hiring Console → call from the top of the ranking.';

  safeRun_('cutover:email', function () {
    queueEmail_({
      to: CFG.get('HIRING_MANAGER_EMAIL'),
      subject: "Recruiting OS — GO-LIVE " + (failures.length ? 'finished with ' + failures.length + ' issue(s)' : 'COMPLETE') + ' — ' + shopDate_(),
      body: body,
      templateKey: '__go_live_report__', reason: 'staged cutover completion'
    });
    if (typeof flushEmailQueue === 'function') flushEmailQueue();
  });
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-SCORE BATCH — only candidates not yet graded by V2
// ─────────────────────────────────────────────────────────────────────────────

/** IDs of active open-role candidates (with email) lacking a Grade Detail row. */
function TONIGHT_ungradedIds_() {
  var graded = {};
  var gd = getSheetOrNull_(GRADE_DETAIL_SHEET);
  if (gd && gd.getLastRow() >= 2) {
    var gh = getHeaderRow_(gd), gc = gh.indexOf('Candidate ID');
    gd.getRange(2, 1, gd.getLastRow() - 1, gh.length).getValues().forEach(function (r) {
      graded[String(r[gc] || '').trim()] = true;
    });
  }
  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (!ac || ac.getLastRow() < 2) return [];
  var h = getHeaderRow_(ac);
  var cId = h.indexOf('Candidate ID'), cRole = h.indexOf('Role'),
      cStatus = h.indexOf('Status'), cEmail = h.indexOf('Email');
  var ids = [];
  ac.getRange(2, 1, ac.getLastRow() - 1, h.length).getValues().forEach(function (r) {
    var role = String(r[cRole] || '').toLowerCase();
    if (role.indexOf('technician') === -1 && role.indexOf('advisor') === -1) return;
    var status = String(r[cStatus] || '').toUpperCase();
    if (status === 'ARCHIVED' || status === 'REJECTED' || status === 'HIRED' ||
        status === 'IN_DRAWER' || status === 'WITHDRAWN') return;
    if (!String(r[cEmail] || '').trim()) return;
    var id = String(r[cId] || '').trim();
    if (id && !graded[id]) ids.push(id);
  });
  return ids;
}

function TONIGHT_countUngraded_() { return TONIGHT_ungradedIds_().length; }

/** Grade up to `cap` ungraded open-role candidates. Returns {text, remaining}. */
function TONIGHT_rescoreBatch_(cap) {
  var ids = TONIGHT_ungradedIds_();
  var summary = { queued: ids.length, processed: 0, autoBook: 0, review: 0, rejected: 0, notScored: 0, errors: 0 };
  var lines = [];

  for (var i = 0; i < ids.length && summary.processed < cap; i++) {
    try {
      var res = withLock_(function () { return scorePreScreenV2(ids[i]); });
      summary.processed++;
      if (!res || res.score === null || res.score === undefined) {
        summary.notScored++;
        lines.push('  — ' + ids[i] + ': not scored (' + ((res && res.reason) || 'unknown') + ')');
      } else if (res.action === 'AUTO_BOOK') {
        summary.autoBook++; lines.push('  ★ ' + ids[i] + ': ' + res.score + ' → AUTO_BOOK');
      } else if (res.action === 'HARD_REJECT') {
        summary.rejected++; lines.push('  ✗ ' + ids[i] + ': ' + res.score + ' → declined');
      } else {
        summary.review++; lines.push('  · ' + ids[i] + ': ' + res.score + ' → review (' + (res.reason || '') + ')');
      }
    } catch (e) {
      summary.errors++;
      lines.push('  ! ' + ids[i] + ': ' + e.message);
      logError_('TONIGHT_rescoreBatch_:' + ids[i], e, ids[i], 'WARN');
    }
  }

  var remaining = TONIGHT_ungradedIds_().length;
  var text = 'Batch: processed ' + summary.processed + ' of ' + summary.queued + ' ungraded — ' +
             summary.autoBook + ' auto-book · ' + summary.review + ' review · ' +
             summary.rejected + ' declined · ' + summary.notScored + ' not-scorable · ' +
             summary.errors + ' errors · remaining ' + remaining + '\n' + lines.join('\n');
  logEvent_('CUTOVER_RESCORE_BATCH', '', { processed: summary.processed, remaining: remaining });
  return { text: text, remaining: remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-DIAGNOSING STATUS — run anytime, especially tomorrow morning
// ─────────────────────────────────────────────────────────────────────────────

function TONIGHT_status() {
  var out = ['════ RECRUITING OS STATUS — ' + shopDateTime_() + ' ════'];

  out.push('MODE: ' + CFG.get('SYSTEM_MODE') + ' · SEND_ENABLED=' + CFG.get('SEND_ENABLED') +
           ' · V2=' + CFG.get('GRADING_V2_ENABLED', 'TRUE') +
           ' · AutoAdvance=' + CFG.get('AUTO_ADVANCE_LIVE_ENABLED', 'TRUE') +
           ' · BackstopEnforce=' + CFG.get('DETERMINISTIC_BACKSTOP_ENFORCE'));

  var cutover = PropertiesService.getScriptProperties().getProperty(CUTOVER_PROP);
  if (cutover) {
    var cs = JSON.parse(cutover);
    out.push('CUTOVER: in progress — stage ' + (cs.stage + 1) + '/' + CUTOVER_STAGE_NAMES.length +
             ' (' + CUTOVER_STAGE_NAMES[cs.stage] + ')');
  }

  var ac = getSheetOrNull_(SHEETS.ALL_CANDIDATES);
  if (ac && ac.getLastRow() >= 2) {
    var headers = getHeaderRow_(ac);
    var data = ac.getRange(2, 1, ac.getLastRow() - 1, headers.length).getValues();
    function col(n) { return headers.indexOf(n); }
    var cRole = col('Role'), cStatus = col('Status'), cScore = col('AI Score'),
        cFn = col('First Name'), cLn = col('Last Name');
    var tally = { tech: { n: 0, scored: 0, hot: [] }, adv: { n: 0, scored: 0, hot: [] } };
    data.forEach(function (r) {
      var role = String(r[cRole] || '').toLowerCase();
      var status = String(r[cStatus] || '').toUpperCase();
      if (status === 'ARCHIVED' || status === 'REJECTED' || status === 'IN_DRAWER') return;
      var slot = role.indexOf('technician') !== -1 ? tally.tech
               : role.indexOf('advisor') !== -1 ? tally.adv : null;
      if (!slot) return;
      slot.n++;
      var s = parseFloat(r[cScore]);
      if (!isNaN(s)) {
        slot.scored++;
        if (s >= 80) slot.hot.push(((r[cFn] || '') + ' ' + (r[cLn] || '')).trim() + ' (' + s + ', ' + status + ')');
      }
    });
    out.push('');
    out.push('OPEN ROLES:');
    out.push('  Technicians     : ' + tally.tech.n + ' active, ' + tally.tech.scored + ' graded' +
             (tally.tech.hot.length ? '  ★ ' + tally.tech.hot.join(' · ') : ''));
    out.push('  Service Advisors: ' + tally.adv.n + ' active, ' + tally.adv.scored + ' graded' +
             (tally.adv.hot.length ? '  ★ ' + tally.adv.hot.join(' · ') : ''));
    var ungraded = TONIGHT_countUngraded_();
    out.push('  Awaiting V2 grade: ' + ungraded + (ungraded ? '  (re-score still working, or some lack a pre-screen)' : '  ✓'));
  }

  out.push('');
  out.push('HEALTH:');
  var eq = getSheetOrNull_(SHEETS.EMAIL_QUEUE);
  if (eq && eq.getLastRow() >= 2) {
    var h = getHeaderRow_(eq), cS = h.indexOf('Status'), counts = {};
    eq.getRange(2, 1, eq.getLastRow() - 1, h.length).getValues().forEach(function (r) {
      var s = String(r[cS] || ''); counts[s] = (counts[s] || 0) + 1;
    });
    out.push('  Email queue     : ' + Object.keys(counts).map(function (k) { return k + '=' + counts[k]; }).join(' · '));
    if (counts['BLOCKED']) out.push('  ⚠ BLOCKED mail present — run 🩹 Apply All Audit Fixes to recover it');
  }
  var q = getSheetOrNull_(AUTOADV_SHEET);
  if (q && q.getLastRow() >= 2) {
    var qh = getHeaderRow_(q), qS = qh.indexOf('Status'), qc = {};
    q.getRange(2, 1, q.getLastRow() - 1, qh.length).getValues().forEach(function (r) {
      var s = String(r[qS] || ''); qc[s] = (qc[s] || 0) + 1;
    });
    out.push('  Auto-advance    : ' + Object.keys(qc).map(function (k) { return k + '=' + qc[k]; }).join(' · '));
  } else {
    out.push('  Auto-advance    : queue empty (nothing at PHONE_DONE over the bar yet)');
  }
  var el = getSheetOrNull_(SHEETS.ERROR_LOG);
  if (el && el.getLastRow() >= 2) {
    var eh = getHeaderRow_(el), eT = eh.indexOf('Timestamp'), eSev = eh.indexOf('Severity');
    var recent = 0, cutoff = Date.now() - 24 * 3600 * 1000;
    var lastN = Math.min(200, el.getLastRow() - 1);
    el.getRange(el.getLastRow() - lastN + 1, 1, lastN, eh.length).getValues().forEach(function (r) {
      var d = new Date(r[eT]);
      if (!isNaN(d.getTime()) && d.getTime() > cutoff && String(r[eSev]).toUpperCase() === 'ERROR') recent++;
    });
    out.push('  Errors (24h)    : ' + recent + (recent ? '  ⚠ check the Error Log tab' : '  ✓'));
  }
  var gl = getSheetOrNull_(SHEETS.AI_GRADING_LOGS);
  if (gl && gl.getLastRow() >= 2) {
    var gh = getHeaderRow_(gl), gP = gh.indexOf('Parse OK'), gPh = gh.indexOf('Phase');
    var v2ok = 0, v2fail = 0;
    gl.getRange(2, 1, gl.getLastRow() - 1, gh.length).getValues().forEach(function (r) {
      if (String(r[gPh] || '').indexOf('prescreen_v2') !== 0) return;
      if (String(r[gP]).toUpperCase() === 'TRUE') v2ok++; else v2fail++;
    });
    out.push('  V2 AI calls     : ' + v2ok + ' ok / ' + v2fail + ' failed' +
             (v2ok + v2fail === 0 ? '  (none yet)' : v2fail > v2ok / 4 ? '  ⚠ high failure rate' : '  ✓'));
  }
  var trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  out.push('  Triggers        : ' + trig.length + ' installed' +
           (trig.indexOf('AUTOADV_run') !== -1 ? ' · AUTOADV ✓' : ' · ⚠ AUTOADV_run MISSING'));

  var msg = out.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Recruiting OS — Status', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL CANDIDATES DEDUP — archive-based, reversible
// ─────────────────────────────────────────────────────────────────────────────

function TONIGHT_dedupAllCandidates() {
  return withLock_(function () {
    var ac = getSheet_(SHEETS.ALL_CANDIDATES);
    var last = ac.getLastRow();
    if (last < 2) return 'no candidates';

    var headers = getHeaderRow_(ac);
    var data = ac.getRange(2, 1, last - 1, headers.length).getValues();
    function col(n) { return headers.indexOf(n); }
    var cId = col('Candidate ID'), cFn = col('First Name'), cLn = col('Last Name'),
        cEmail = col('Email'), cPhone = col('Phone'), cRole = col('Role'),
        cStatus = col('Status'), cScore = col('AI Score'), cUpd = col('Last Updated'),
        cNotes = col('Notes');

    var rows = data.map(function (r, i) {
      var email = normalizeEmail_(r[cEmail]);
      var isRelay = /@indeedemail\.com$/i.test(email) || /^conversation-/i.test(email);
      return {
        idx: i, rowNum: i + 2,
        id: String(r[cId] || '').trim(),
        name: ((r[cFn] || '') + ' ' + (r[cLn] || '')).trim().toLowerCase().replace(/\s+/g, ' '),
        email: isRelay ? '' : email,
        phone: String(r[cPhone] || '').replace(/\D/g, '').slice(-10),
        role: String(r[cRole] || '').trim(),
        status: String(r[cStatus] || '').trim().toUpperCase(),
        score: parseFloat(r[cScore]),
        updated: new Date(r[cUpd] || 0).getTime() || 0
      };
    }).filter(function (r) { return r.id; });

    // Union-find. Hard identifiers (email, phone) always link.
    var parent = rows.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    var byKey = {};
    rows.forEach(function (r, i) {
      [r.email && 'e:' + r.email, r.phone && r.phone.length === 10 && 'p:' + r.phone]
        .forEach(function (k) {
          if (!k) return;
          if (byKey[k] !== undefined) union(i, byKey[k]); else byKey[k] = i;
        });
    });
    // Name links ONLY when one side has no real email (an Indeed relay shell
    // attaching to the real submission). Two rows with two DIFFERENT real
    // emails are never merged on name alone — same rule as 28_Pipeline_Dedup.
    var byName = {};
    rows.forEach(function (r, i) {
      if (!r.name || r.name.length <= 4) return;
      (byName[r.name] = byName[r.name] || []).push(i);
    });
    Object.keys(byName).forEach(function (nm) {
      var idxs = byName[nm];
      for (var a = 0; a < idxs.length; a++) {
        for (var b = a + 1; b < idxs.length; b++) {
          var A = rows[idxs[a]], B = rows[idxs[b]];
          if (!A.email || !B.email || A.email === B.email) union(idxs[a], idxs[b]);
        }
      }
    });

    var groups = {};
    rows.forEach(function (r, i) { var g = find(i); (groups[g] = groups[g] || []).push(r); });

    var archived = [], crossRole = [];
    Object.keys(groups).forEach(function (g) {
      var members = groups[g];
      if (members.length < 2) return;

      var byRole = {};
      members.forEach(function (m) {
        var role = (!m.role || /^unknown$/i.test(m.role)) ? '__any__' : m.role.toLowerCase();
        (byRole[role] = byRole[role] || []).push(m);
      });
      var realRoles = Object.keys(byRole).filter(function (k) { return k !== '__any__'; });
      if (byRole['__any__']) {
        var dest = realRoles.length ? byRole[realRoles[0]] : null;
        if (dest) { byRole['__any__'].forEach(function (m) { dest.push(m); }); delete byRole['__any__']; }
      }
      realRoles = Object.keys(byRole);

      if (realRoles.length > 1) {
        crossRole.push(members[0].name + ' → ' + members.map(function (m) { return m.id; }).join(', ') +
                       ' (multiple roles — both kept)');
      }

      realRoles.forEach(function (roleKey) {
        var group = byRole[roleKey];
        if (group.length < 2) {
          if (realRoles.length > 1) TONIGHT_appendNote_(ac, cNotes, group[0],
            'Same person as ' + members.filter(function (m) { return m !== group[0]; })
              .map(function (m) { return m.id; }).join(', ') + ' (multi-role applicant)');
          return;
        }
        group.sort(function (a, b) {
          var ra = TONIGHT_STATUS_RANK[a.status] || 0, rb = TONIGHT_STATUS_RANK[b.status] || 0;
          if (rb !== ra) return rb - ra;
          var sa = isNaN(a.score) ? -1 : a.score, sb = isNaN(b.score) ? -1 : b.score;
          if ((sb >= 0) !== (sa >= 0)) return (sb >= 0) ? 1 : -1;
          return b.updated - a.updated;
        });
        var keeper = group[0];
        group.slice(1).forEach(function (dupe) {
          TONIGHT_fillBlanks_(ac, headers, keeper.rowNum, dupe.rowNum);
          updateRowWhere_(ac, 'Candidate ID', dupe.id, {
            'Status': STATUS.ARCHIVED,
            'Notes':  truncate_('Duplicate of ' + keeper.id + ' — archived by dedup ' + shopDateTime_() +
                                '. (Reversible: change Status back if this was wrong.)', 400),
            'Last Updated': shopDateTime_()
          });
          TONIGHT_appendNote_(ac, cNotes, keeper, 'Absorbed duplicate ' + dupe.id + ' (' + shopDate_() + ')');
          archived.push(dupe.id + ' → kept ' + keeper.id);
          logEvent_('DEDUP_ARCHIVED', dupe.id, { keeper: keeper.id });
        });
      });
    });

    var out = ['All Candidates dedup:'];
    out.push('  archived ' + archived.length + ' duplicate row(s)' +
             (archived.length ? ':\n    ' + archived.join('\n    ') : ''));
    out.push('  multi-role applicants kept live: ' + crossRole.length +
             (crossRole.length ? ':\n    ' + crossRole.join('\n    ') : ''));
    return out.join('\n');
  }, 60000);
}

function TONIGHT_appendNote_(sheet, cNotes, rowRec, text) {
  if (cNotes < 0) return;
  try {
    var cur = String(sheet.getRange(rowRec.rowNum, cNotes + 1).getValue() || '');
    if (cur.indexOf(text) !== -1) return;
    sheet.getRange(rowRec.rowNum, cNotes + 1).setValue(truncate_((cur ? cur + ' | ' : '') + text, 500));
  } catch (e) {}
}

/** Copy any cell the keeper row is missing from the duplicate — ONE batched write. */
function TONIGHT_fillBlanks_(sheet, headers, keeperRow, dupeRow) {
  try {
    var kRange = sheet.getRange(keeperRow, 1, 1, headers.length);
    var kVals = kRange.getValues()[0];
    var dVals = sheet.getRange(dupeRow, 1, 1, headers.length).getValues()[0];
    var writes = 0;
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c] || '');
      if (h === 'Candidate ID' || h === 'Status' || h === 'Notes' || h === 'Last Updated') continue;
      var kEmpty = kVals[c] === '' || kVals[c] === null;
      var dHas = dVals[c] !== '' && dVals[c] !== null;
      if (kEmpty && dHas) { kVals[c] = dVals[c]; writes++; }
    }
    if (writes) kRange.setValues([kVals]);
    return writes;
  } catch (e) { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 TAB ORGANIZER — importance order + color language
// ─────────────────────────────────────────────────────────────────────────────

var V2_TAB_COLORS = Object.freeze({
  DAILY:  '#34a853',   // green  — work these daily
  ALERT:  '#ea4335',   // red    — attention: check when something looks wrong
  SETUP:  '#4285f4',   // blue   — settings & rules
  INTAKE: '#f9ab00',   // orange — raw intake (machines write here)
  LOG:    '#9aa0a6'    // grey   — system logs
});

function V2_tabPlan_() {
  var daily = [
    SHEETS.GM_QUICKSTART, SHEETS.DASHBOARD, SHEETS.INTERVIEW_PIPELINE,
    SHEETS.ALL_CANDIDATES, GRADE_DETAIL_SHEET, AUTOADV_SHEET,
    SHEETS.INTERVIEW_WORKSHEETS, SHEETS.EMAIL_QUEUE
  ];
  var alert = [SHEETS.RISK_FLAGS, SHEETS.ERROR_LOG, TONIGHT_REPORT_SHEET];
  var setup = [
    SHEETS.ROLE_RULES, SHEETS.CONFIG, SHEETS.HIRING_MANAGERS, SHEETS.JOB_POSTINGS,
    SHEETS.INSTRUCTION_MANUAL, SHEETS.MANUAL_SETUP_REGISTRY, SHEETS.FORM_REGISTRY,
    SHEETS.EMAIL_TEMPLATES, SHEETS.AI_PROMPTS, SHEETS.AI_RUBRICS,
    SHEETS.ASSESSMENT_REGISTRY, SHEETS.ASSESSMENT_QUESTION_BANK, SHEETS.ASSESSMENT_RUBRICS,
    SHEETS.TRANSCRIPT_SOURCES
  ];
  var intake = [];
  try {
    PS_clearCache_();
    PS_discoverPreScreenTabs_().forEach(function (t) { intake.push(t.name); });
  } catch (e) {}
  [SHEETS.RAW_PRESCREEN, SHEETS.CULTURE_FIT, SHEETS.REFERENCE_REQUESTS, SHEETS.REFERENCE_CHECKS,
   SHEETS.SKILLS_TEST_RESPONSES, SHEETS.BOOKING_EVENTS, SHEETS.RAW_HIRING_EMAIL_LEADS,
   SHEETS.RAW_OTTER_INTAKE, SHEETS.TRANSCRIPT_INBOX, SHEETS.TRANSCRIPT_ARCHIVE,
   SHEETS.ASSESSMENT_RESPONSES, SHEETS.AI_ASSESSMENT_RESULTS
  ].forEach(function (n) { if (n && intake.indexOf(n) === -1) intake.push(n); });
  var logs = [
    SHEETS.NOTIFICATION_LOG, SHEETS.EMAIL_SENT_LEDGER, SHEETS.EVENT_LOG,
    SHEETS.TRIGGER_HEALTH, SHEETS.AI_GRADING_LOGS, SHEETS.OVERRIDE_LOG,
    SHEETS.DAILY_DIGEST_LOG, SHEETS.SETUP_REGISTRY, SHEETS.BACKFILL_REVIEW,
    SHEETS.INGESTED_SOURCES_LOG, SHEETS.ASSESSMENT_AUDIT_LOG,
    SHEETS.PIPELINE_ARCHIVE, 'V2 Verification Log'
  ];
  return { daily: daily, alert: alert, setup: setup, intake: intake, logs: logs };
}

/**
 * Order every tab by importance and apply the color language. Green + red +
 * Role Rules + Config stay visible; orange intake and grey logs are hidden
 * (fully reversible with unhideAllTabs()). Never renames a tab, never touches
 * a cell value.
 */
function V2_organizeTabs() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return '[TABS] busy — a background task is running; try again in a minute';
  try {
    var ss = SpreadsheetApp.getActive();
    var plan = V2_tabPlan_();

    var order = [], colorOf = {};
    plan.daily.forEach(function (n) { order.push(n); colorOf[n] = V2_TAB_COLORS.DAILY; });
    plan.alert.forEach(function (n) { order.push(n); colorOf[n] = V2_TAB_COLORS.ALERT; });
    plan.setup.forEach(function (n) { if (order.indexOf(n) === -1) { order.push(n); colorOf[n] = V2_TAB_COLORS.SETUP; } });
    plan.intake.forEach(function (n) { if (order.indexOf(n) === -1) { order.push(n); colorOf[n] = V2_TAB_COLORS.INTAKE; } });
    plan.logs.forEach(function (n) { if (order.indexOf(n) === -1) { order.push(n); colorOf[n] = V2_TAB_COLORS.LOG; } });

    var pos = 1, moved = [];
    order.forEach(function (name) {
      if (!name) return;
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(pos++);
      sh.setTabColor(colorOf[name]);
      moved.push(name);
    });

    var known = {}; moved.forEach(function (n) { known[n] = true; });
    var leftovers = [];
    ss.getSheets().forEach(function (sh) {
      if (!known[sh.getName()]) { sh.setTabColor(V2_TAB_COLORS.LOG); leftovers.push(sh.getName()); }
    });

    var home = ss.getSheetByName(plan.daily[0]) || ss.getSheets()[0];
    if (home) { home.showSheet(); ss.setActiveSheet(home); }

    var visible = {};
    plan.daily.forEach(function (n) { visible[n] = true; });
    plan.alert.forEach(function (n) { visible[n] = true; });
    visible[SHEETS.ROLE_RULES] = true;
    visible[SHEETS.CONFIG] = true;
    var hidden = 0;
    ss.getSheets().forEach(function (sh) {
      var nm = sh.getName();
      if (visible[nm]) { safeRun_('tabs:show:' + nm, function () { sh.showSheet(); }); return; }
      safeRun_('tabs:hide:' + nm, function () { sh.hideSheet(); hidden++; });
    });

    var msg = 'Ordered ' + moved.length + ' tab(s) — green (daily) · red (attention) · blue (setup) · ' +
      'orange (intake, hidden) · grey (logs, hidden). Hid ' + hidden + ' tab(s); ' +
      leftovers.length + ' unrecognized tab(s) greyed at the end' +
      (leftovers.length ? ': ' + leftovers.join(', ') : '') +
      '. Undo visibility anytime: Menu → 🗂 Show All Tabs.';
    logEvent_('V2_TABS_ORGANIZED', '', { moved: moved.length, hidden: hidden, leftovers: leftovers.length });
    Logger.log('[TABS] ' + msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}