/**
 * 42_Lean_Migration.gs — one-time migration to the lean tab architecture.
 * RUN THIS ON A COPY of the live workbook (see docs/LEAN_ARCHITECTURE.md).
 *
 *   LEAN_migratePreview()       -> reports exactly what it will do. Changes nothing.
 *   LEAN_migrateExecute()       -> performs the migration (safe + idempotent):
 *                                    1. preserve Notification Log as "Email Log"
 *                                    2. bootstrapSystem() (creates System Log etc.)
 *                                    3. merge Event/Error/Override Log rows -> System Log
 *                                    4. color-zone every tab (green/blue/yellow/orange/grey)
 *                                    5. HIDE drift tabs (never deletes here)
 *   LEAN_deleteArchivedDrift()  -> permanently deletes the hidden drift tabs.
 *                                    Run ONLY after you've verified the copy is good.
 *
 * Nothing is deleted until you explicitly run step 6. Candidate per-role tabs are
 * HIDDEN and reported (not auto-merged) so you can eyeball them before deleting.
 */

// Tabs to HIDE (drift / superseded). Per-role candidate tabs are included — they
// are pre-unification snapshots; review them before LEAN_deleteArchivedDrift().
var LEAN_DRIFT_TABS = [
  'OLD Config',
  'Config [WITH DRIFT ONLY USE FOR REFERENCE]',
  'Config [WITH DRIFT - reference only]',
  'Config [WITH DRIFT — reference only]',
  'Pre_Screen_Responses_and_Headers',
  'Scoring Rubric',
  'CX Candidates',
  'Service Advisor Candidates',
  'Technician Candidates'
  // NOTE: Setup Registry / Manual Setup Registry / Instruction Manual are NOT
  // listed here — the current bootstrap structurally depends on Setup Registry
  // (SHEET_MANIFEST[0]) and writes the others. They are retired in Phase 2 when
  // the scaffolding moves to the separate Maintenance project (see spec §4).
];

// Zone -> tab color. Tabs are matched by their canonical (post-bootstrap) names.
function _leanZones_() {
  return [
    { zone: 'Manager', color: '#34a853', tabs: [SHEETS.INTERVIEW_PIPELINE, SHEETS.DASHBOARD] },
    { zone: 'Inputs',  color: '#4285f4', tabs: [
        SHEETS.RAW_PRESCREEN, SHEETS.CULTURE_FIT, SHEETS.REFERENCE_REQUESTS,
        SHEETS.REFERENCE_CHECKS, SHEETS.SKILLS_TEST_RESPONSES,
        SHEETS.RAW_OTTER_INTAKE, SHEETS.TRANSCRIPT_INBOX, SHEETS.RAW_HIRING_EMAIL_LEADS ] },
    { zone: 'Data',    color: '#fbbc04', tabs: [
        SHEETS.ALL_CANDIDATES, SHEETS.PIPELINE_ARCHIVE, SHEETS.TRANSCRIPT_ARCHIVE ] },
    { zone: 'Config',  color: '#ff9900', tabs: [
        SHEETS.CONFIG, SHEETS.ROLE_RULES, SHEETS.HIRING_MANAGERS, SHEETS.EMAIL_TEMPLATES,
        SHEETS.AI_PROMPTS, SHEETS.FORM_REGISTRY, SHEETS.JOB_POSTINGS,
        SHEETS.ASSESSMENT_REGISTRY, SHEETS.ASSESSMENT_QUESTION_BANK, SHEETS.ASSESSMENT_RUBRICS,
        SHEETS.AI_RUBRICS ] },
    { zone: 'System',  color: '#999999', tabs: [
        SHEETS.EMAIL_QUEUE, SHEETS.NOTIFICATION_LOG /* "Email Log" */, SHEETS.SYSTEM_LOG,
        SHEETS.EMAIL_SENT_LEDGER, SHEETS.TRIGGER_HEALTH, SHEETS.RISK_FLAGS, SHEETS.AI_GRADING_LOGS ] }
  ];
}

var LEAN_SYSTEM_LOG_HEADERS = ['Timestamp', 'Type', 'Severity', 'Label / Event',
  'Candidate ID', 'Function', 'Message / Details', 'Stack', 'Notes'];

// ─────────────────────────────────────────────────────────────────────────────

function LEAN_migratePreview() { return _leanMigrate_(true); }
function LEAN_migrateExecute() { return _leanMigrate_(false); }

function _leanMigrate_(dryRun) {
  var ss = SpreadsheetApp.getActive();
  var R = [];
  function L(s) { R.push(s); Logger.log(s); }
  L('=== LEAN MIGRATION ' + (dryRun ? '(PREVIEW — no changes)' : '(EXECUTE)') + ' — ' + new Date() + ' ===');

  // 1) Preserve Notification Log history by renaming it to the new "Email Log".
  var notif = ss.getSheetByName('Notification Log');
  var emailLogName = SHEETS.NOTIFICATION_LOG; // 'Email Log'
  if (notif && notif.getName() !== emailLogName && !ss.getSheetByName(emailLogName)) {
    if (dryRun) L('would rename "Notification Log" -> "' + emailLogName + '" (preserves send + dedup history)');
    else { notif.setName(emailLogName); L('renamed "Notification Log" -> "' + emailLogName + '"'); }
  }

  // 2) Ensure the lean structure exists (System Log, Email Log, etc.).
  if (dryRun) L('would run bootstrapSystem() to create System Log + lean manifest tabs');
  else { L('bootstrapSystem(): ' + _leanFirstLine_(bootstrapSystem())); }

  // 3) Merge old Event/Error/Override Log rows into the System Log.
  L('-- merge legacy logs -> System Log --');
  _leanMergeLog_('Error Log', 'ERROR', dryRun, L, function (o) {
    return { sev: o['Severity'] || 'ERROR', label: o['Label'], fn: o['Function'],
             cid: o['Candidate ID'], msg: o['Message'], stack: o['Stack'], notes: o['Notes'] };
  });
  _leanMergeLog_('Event Log', 'EVENT', dryRun, L, function (o) {
    return { sev: 'INFO', label: o['Event'], fn: o['Function'],
             cid: o['Candidate ID'], msg: o['Details'], stack: '', notes: o['Notes'] };
  });
  _leanMergeLog_('Override Log', 'OVERRIDE', dryRun, L, function (o) {
    return { sev: 'INFO', label: o['Override Type'] || 'Status Override', fn: o['Actor'],
             cid: o['Candidate ID'],
             msg: String(o['Previous Value'] || '') + ' → ' + String(o['New Value'] || ''),
             stack: '', notes: o['Reason'] };
  });

  // 4) Color-zone every tab.
  L('-- color-zone tabs --');
  _leanZones_().forEach(function (z) {
    z.tabs.forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      if (dryRun) L('  would color ' + z.zone + ' (' + z.color + '): ' + name);
      else { try { sh.setTabColor(z.color); } catch (e) {} }
    });
    if (!dryRun) L('  ' + z.zone + ' zone colored');
  });

  // 5) Hide drift tabs (never deleted here).
  L('-- hide drift tabs --');
  var hidden = 0;
  LEAN_DRIFT_TABS.concat(['Error Log', 'Event Log', 'Override Log']).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var rows = Math.max(0, sh.getLastRow() - 1);
    if (dryRun) { L('  would hide: "' + name + '" (' + rows + ' data rows)'); hidden++; return; }
    try { sh.hideSheet(); hidden++; L('  hidden: "' + name + '" (' + rows + ' rows preserved)'); }
    catch (e) { L('  !! could not hide "' + name + '": ' + e); }
  });

  L('\nDONE. ' + (dryRun ? 'PREVIEW only — nothing changed.' :
     'Migration applied. Now run VERIFY_runAllSelfTests(), then LEAN_deleteArchivedDrift() once satisfied.'));
  L('Tabs hidden (or to-hide): ' + hidden + '. Per-role candidate tabs are HIDDEN (not merged) — review before deleting.');
  return R.join('\n');
}

/**
 * Merge one legacy log tab's rows into the System Log in a single batched write,
 * then mark the source so a re-run is a no-op (idempotent).
 */
function _leanMergeLog_(srcName, type, dryRun, L, mapFn) {
  var ss = SpreadsheetApp.getActive();
  var src = ss.getSheetByName(srcName);
  if (!src) { L('  · ' + srcName + ': not present, skipped'); return; }
  if (src.getName().indexOf('zz_merged') === 0) { L('  · ' + srcName + ': already merged'); return; }
  var last = src.getLastRow();
  if (last < 2) { L('  · ' + srcName + ': empty, nothing to merge'); return; }
  var n = last - 1;
  if (dryRun) { L('  would merge ' + n + ' rows from "' + srcName + '" as Type=' + type); return; }

  var sys = getSheetOrNull_(SHEETS.SYSTEM_LOG);
  if (!sys) { L('  !! System Log missing — run bootstrapSystem() first'); return; }
  ensureHeaders_(sys, LEAN_SYSTEM_LOG_HEADERS);

  var headers = getHeaderRow_(src);
  var data = src.getRange(2, 1, n, headers.length).getValues();
  var sysHeaders = getHeaderRow_(sys);
  var idx = {}; sysHeaders.forEach(function (h, i) { idx[h] = i; });

  var out = [];
  for (var i = 0; i < data.length; i++) {
    var o = {}; headers.forEach(function (h, j) { o[h] = data[i][j]; });
    var m = mapFn(o);
    var row = new Array(sysHeaders.length).fill('');
    function put(col, val) { if (idx[col] !== undefined) row[idx[col]] = val == null ? '' : val; }
    put('Timestamp', o['Timestamp'] || '');
    put('Type', type);
    put('Severity', m.sev || '');
    put('Label / Event', m.label || '');
    put('Candidate ID', m.cid || '');
    put('Function', m.fn || '');
    put('Message / Details', m.msg || '');
    put('Stack', m.stack || '');
    put('Notes', (m.notes || '') + ' [migrated from ' + srcName + ']');
    out.push(row);
  }
  if (out.length) {
    sys.getRange(sys.getLastRow() + 1, 1, out.length, sysHeaders.length).setValues(out);
  }
  // Mark source merged + hide so a re-run won't double-merge.
  try { src.setName('zz_merged — ' + srcName); src.hideSheet(); } catch (e) {}
  L('  merged ' + out.length + ' rows from "' + srcName + '" (source hidden as "zz_merged — ' + srcName + '")');
}

/**
 * Permanently delete the hidden drift tabs. Run ONLY after verifying the copy.
 * Deletes the LEAN_DRIFT_TABS plus any "zz_merged — *" log tabs.
 */
function LEAN_deleteArchivedDrift() {
  var ss = SpreadsheetApp.getActive();
  var R = ['=== LEAN_deleteArchivedDrift — ' + new Date() + ' ==='];
  var deleted = 0;
  var targets = LEAN_DRIFT_TABS.slice();
  ss.getSheets().forEach(function (sh) {
    if (sh.getName().indexOf('zz_merged') === 0) targets.push(sh.getName());
  });
  targets.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    try { ss.deleteSheet(sh); deleted++; R.push('  deleted: ' + name); }
    catch (e) { R.push('  !! could not delete ' + name + ': ' + e); }
  });
  R.push('Deleted ' + deleted + ' tab(s).');
  var msg = R.join('\n'); Logger.log(msg);
  if (typeof toast_ === 'function') toast_('Deleted ' + deleted + ' drift tab(s).', 'Lean Migration', 8);
  return msg;
}

function _leanFirstLine_(s) { return String(s == null ? '' : s).split('\n')[0]; }
