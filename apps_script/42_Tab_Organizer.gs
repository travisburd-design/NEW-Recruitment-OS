/**
 * 42_Tab_Organizer.gs
 * Frank's European Service — Recruiting OS
 *
 * Reorganizes the spreadsheet so a NEW hiring manager can run the OS by going
 * left-to-right across the tab strip. The first 10 tabs are the only ones a
 * manager needs on a regular basis, in priority order; everything else is
 * grouped, color-coded, and hidden behind them.
 *
 * Breadcrumbs (all non-destructive — no row/column/value is ever changed):
 *   • TAB ORDER   — priority tabs first, then Setup, then Data, then Logs.
 *   • TAB COLORS  — 🟢 green = your daily 10 · 🔵 blue = setup/settings ·
 *                   🟠 orange = raw candidate data/forms · ⚪ grey = system logs.
 *   • A1 NOTES    — each of the top 10 gets a hover note: "tab N of 10 — what it
 *                   is — Next ➜ <tab>", nudging the manager to the next stop.
 *   • HIDING      — every tab except the daily 10 is hidden (reversible).
 *
 * IMPORTANT (load-safety): this file must NOT reference SHEETS (defined in
 * 00_Config.gs) at the top level. Apps Script does not guarantee the order in
 * which globals across files initialize, so a top-level `var x = SHEETS.FOO`
 * can run before SHEETS exists and crash the WHOLE project at load time (which
 * also makes the onOpen menu disappear). Every SHEETS lookup therefore happens
 * lazily inside a function via _gmTabPlan_().
 *
 * Safe + idempotent. Tab names are NEVER renamed (code looks tabs up by name),
 * and tabs not in any list are preserved (left after the known tabs, grey).
 *
 * Public:
 *   organizeTabsForManager()   — reorder + color + note + hide (menu)
 *   unhideAllTabs()            — reveal every hidden tab (the undo)
 *   gmTopTenTabs_()            — [[name, purpose], ...] for the GM Daily card
 *   TABORG_selfTest()          — read-only: prints the plan, changes nothing
 */

// Tab-color hexes only — plain literals, safe at the top level.
var TABORG_COLORS = Object.freeze({
  GM:     '#34a853',  // green  — the daily 10
  SETUP:  '#4285f4',  // blue   — setup & settings
  DATA:   '#f9ab00',  // orange — raw candidate data / form responses
  LOG:    '#9aa0a6'   // grey   — system logs / queues
});

/**
 * Build the full tab plan at CALL TIME (never at file load). Returns:
 *   { gm:[{name,purpose}], setup:[name], data:[name], logs:[name] }
 * All names come from the canonical SHEETS map in 00_Config.gs.
 */
function _gmTabPlan_() {
  return {
    // THE TOP 10 — the only tabs a manager needs regularly, in walk order.
    gm: [
      { name: SHEETS.GM_QUICKSTART,        purpose: 'START HERE — your whole job in 3 steps.' },
      { name: SHEETS.INSTRUCTION_MANUAL,   purpose: 'The full how-to guide. Come back when you are unsure of anything.' },
      { name: SHEETS.DASHBOARD,            purpose: 'Your at-a-glance morning numbers.' },
      { name: SHEETS.INTERVIEW_PIPELINE,   purpose: 'YOUR DAILY TAB — read the AI recommendation, then pick a Manager Decision.' },
      { name: SHEETS.ALL_CANDIDATES,       purpose: 'The master list of every applicant the system has ever seen.' },
      { name: SHEETS.INTERVIEW_WORKSHEETS, purpose: 'Printable interview prep — one sheet per upcoming interview.' },
      { name: SHEETS.ROLE_RULES,           purpose: 'Which roles you are hiring + score minimums, pay range, booking links.' },
      { name: SHEETS.HIRING_MANAGERS,      purpose: 'Your contact info, calendar ID, and booking links.' },
      { name: SHEETS.JOB_POSTINGS,         purpose: 'Ready-to-post job copy + the pre-screen link to advertise.' },
      { name: SHEETS.EMAIL_QUEUE,          purpose: 'Everything going out to candidates — check here to troubleshoot a send.' }
    ],
    // Setup & settings (blue).
    setup: [
      SHEETS.MANUAL_SETUP_REGISTRY, SHEETS.CONFIG, SHEETS.FORM_REGISTRY, SHEETS.EMAIL_TEMPLATES,
      SHEETS.AI_PROMPTS, SHEETS.AI_RUBRICS, SHEETS.ASSESSMENT_REGISTRY,
      SHEETS.ASSESSMENT_QUESTION_BANK, SHEETS.ASSESSMENT_RUBRICS, SHEETS.TRANSCRIPT_SOURCES
    ],
    // Raw candidate data / form responses (orange).
    data: [
      SHEETS.PIPELINE_ARCHIVE, SHEETS.BOOKING_EVENTS, SHEETS.RAW_HIRING_EMAIL_LEADS,
      SHEETS.RAW_OTTER_INTAKE, SHEETS.TRANSCRIPT_ARCHIVE, SHEETS.TRANSCRIPT_INBOX,
      SHEETS.ASSESSMENT_RESPONSES, SHEETS.AI_ASSESSMENT_RESULTS,
      SHEETS.CULTURE_FIT, SHEETS.REFERENCE_REQUESTS, SHEETS.REFERENCE_CHECKS,
      SHEETS.SKILLS_TEST_RESPONSES, SHEETS.RAW_PRESCREEN
    ],
    // System logs / queues (grey).
    logs: [
      SHEETS.NOTIFICATION_LOG, SHEETS.EMAIL_SENT_LEDGER, SHEETS.ERROR_LOG, SHEETS.EVENT_LOG,
      SHEETS.TRIGGER_HEALTH, SHEETS.AI_GRADING_LOGS, SHEETS.SETUP_REGISTRY,
      SHEETS.DAILY_DIGEST_LOG, SHEETS.BACKFILL_REVIEW, SHEETS.OVERRIDE_LOG, SHEETS.RISK_FLAGS,
      SHEETS.INGESTED_SOURCES_LOG, SHEETS.ASSESSMENT_AUDIT_LOG
    ]
  };
}

/** Top 10 as [[name, purpose], ...] — consumed by the GM Daily card. */
function gmTopTenTabs_() {
  return _gmTabPlan_().gm.map(function (t) { return [t.name, t.purpose]; });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: organizeTabsForManager
// ─────────────────────────────────────────────────────────────────────────────
function organizeTabsForManager() {
  // Gentle lock: if a background task is mid-run, tell the manager instead of
  // throwing the raw 30-second lock error.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    toast_('System is busy (a background task is running). Try again in a minute.', 'Recruiting OS', 8);
    return '[TABORG] busy — lock held by another execution';
  }
  try {
    return _organizeTabsForManager_();
  } finally {
    lock.releaseLock();
  }
}

function _organizeTabsForManager_() {
  var ss   = SpreadsheetApp.getActive();
  var plan = _gmTabPlan_();

  // 1) Full desired order + a name→color map.
  var order = [];
  var colorOf = {};
  plan.gm.forEach(function (t) { order.push(t.name); colorOf[t.name] = TABORG_COLORS.GM; });
  plan.setup.forEach(function (n) { order.push(n); colorOf[n] = TABORG_COLORS.SETUP; });
  plan.data.forEach(function (n)  { order.push(n); colorOf[n] = TABORG_COLORS.DATA; });
  plan.logs.forEach(function (n)  { order.push(n); colorOf[n] = TABORG_COLORS.LOG; });

  // 2) Move each existing tab into position (skip any that don't exist).
  var pos = 1, moved = [];
  order.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
    sh.setTabColor(colorOf[name] || TABORG_COLORS.LOG);
    moved.push(name);
  });

  // 3) Any tab we didn't list stays after the known ones; color it grey.
  var known = {};
  moved.forEach(function (n) { known[n] = true; });
  var leftovers = [];
  ss.getSheets().forEach(function (sh) {
    if (!known[sh.getName()]) { sh.setTabColor(TABORG_COLORS.LOG); leftovers.push(sh.getName()); }
  });

  // 4) Breadcrumb notes on the top 10 (hover note on A1 — never changes a value).
  _applyManagerBreadcrumbs_(ss, plan);

  // 5) Land the manager on tab 1 (GM Daily) BEFORE hiding, so the active tab is
  //    never one we hide.
  var first = ss.getSheetByName(SHEETS.GM_QUICKSTART) || ss.getSheets()[0];
  if (first) { first.showSheet(); ss.setActiveSheet(first); }

  // 6) Hide everything except the daily 10 (reversible via unhideAllTabs()).
  var topTen = {};
  plan.gm.forEach(function (t) { topTen[t.name] = true; });
  var hidden = 0;
  if (CFG.getBool('GM_TAB_HIDE_SUPPORTING', true)) {
    ss.getSheets().forEach(function (sh) {
      var nm = sh.getName();
      if (topTen[nm]) { sh.showSheet(); return; }
      safeRun_('organizeTabs:hide:' + nm, function () { sh.hideSheet(); hidden++; });
    });
  } else {
    plan.gm.forEach(function (t) { var sh = ss.getSheetByName(t.name); if (sh) sh.showSheet(); });
  }

  var msg = '[TABORG] ordered ' + moved.length + ' tabs (10 green / ' +
            plan.setup.length + ' blue / ' + plan.data.length + ' orange / ' +
            plan.logs.length + ' grey); hid ' + hidden + ' supporting tab(s)' +
            (leftovers.length ? '; ' + leftovers.length + ' other tab(s) at the end: ' + leftovers.join(', ') : '');
  Logger.log(msg);
  if (typeof logEvent_ === 'function') safeRun_('organizeTabsForManager:log', function () {
    logEvent_('TABS_ORGANIZED', '', { moved: moved.length, hidden: hidden, leftovers: leftovers.length });
  });
  toast_('Tabs organized — only your daily 10 are showing. ' + hidden + ' support tabs hidden (Admin & Setup → "Show All Tabs" to reveal).', 'Recruiting OS', 9);
  return msg;
}

/**
 * Reveal every hidden tab — the full undo for the hiding done by
 * organizeTabsForManager(). Colors and order are left as-is.
 */
function unhideAllTabs() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    toast_('System is busy — try again in a minute.', 'Recruiting OS', 6);
    return '[TABORG] busy';
  }
  try {
    var ss = SpreadsheetApp.getActive();
    var shown = 0;
    ss.getSheets().forEach(function (sh) {
      if (sh.isSheetHidden()) { safeRun_('unhideAllTabs:' + sh.getName(), function () { sh.showSheet(); shown++; }); }
    });
    toast_('Revealed ' + shown + ' hidden tab(s).', 'Recruiting OS', 6);
    return '[TABORG] revealed ' + shown + ' tab(s)';
  } finally {
    lock.releaseLock();
  }
}

/**
 * Put a hover note on cell A1 of each top-10 tab: "tab N of 10 — purpose —
 * Next ➜ <next tab>". Notes never alter cell values, so this is safe on data
 * tabs whose row 1 holds the live column headers.
 */
function _applyManagerBreadcrumbs_(ss, plan) {
  plan = plan || _gmTabPlan_();
  var gm = plan.gm;
  var n = gm.length;
  for (var i = 0; i < n; i++) {
    var t  = gm[i];
    var sh = ss.getSheetByName(t.name);
    if (!sh) continue;
    var next = (i + 1 < n) ? gm[i + 1].name : SHEETS.GM_QUICKSTART + ' (back to the start)';
    var note = '▶ Manager view — tab ' + (i + 1) + ' of 10\n' + t.purpose + '\n\nNext ➜ ' + next;
    (function (sheet, text) {
      safeRun_('_applyManagerBreadcrumbs_:' + sheet.getName(), function () { sheet.getRange(1, 1).setNote(text); });
    })(sh, note);
  }
  // One orienting note on the first non-daily tab.
  var setupLead = ss.getSheetByName(plan.setup[0]);
  if (setupLead) safeRun_('_applyManagerBreadcrumbs_:setupLead', function () {
    setupLead.getRange(1, 1).setNote('From here on are SETUP, DATA, and LOG tabs (blue / orange / grey). ' +
      'You rarely need these day to day — the green tabs 1–10 are your daily set.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only. Prints the plan; changes nothing.
// ─────────────────────────────────────────────────────────────────────────────
function TABORG_selfTest() {
  var ss = SpreadsheetApp.getActive();
  var plan = _gmTabPlan_();
  var out = ['[TABORG] selfTest (read-only) — planned order:'];
  var groups = [
    ['🟢 DAILY 10', plan.gm.map(function (t) { return t.name; })],
    ['🔵 SETUP',    plan.setup],
    ['🟠 DATA',     plan.data],
    ['⚪ LOGS',     plan.logs]
  ];
  var pos = 1;
  groups.forEach(function (g) {
    out.push('  ' + g[0] + ':');
    g[1].forEach(function (name) {
      var exists = !!ss.getSheetByName(name);
      out.push('    ' + (exists ? (pos++) + '. ' : '   (missing) ') + name + (exists ? '' : '  — not in this spreadsheet'));
    });
  });
  var listed = {};
  groups.forEach(function (g) { g[1].forEach(function (n) { listed[n] = true; }); });
  var extra = ss.getSheets().map(function (s) { return s.getName(); }).filter(function (n) { return !listed[n]; });
  out.push('  Other tabs (kept at the end, grey): ' + (extra.length ? extra.join(', ') : '(none)'));
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
