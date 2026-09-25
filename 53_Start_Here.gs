/**
 * 53_Start_Here.gs
 * Frank's European Service — Recruiting OS
 *
 * MAKES THE SHEET TELL THE HIRING MANAGER WHAT (IF ANYTHING) TO CLICK.
 *
 *  1) GM Daily tab = live status board + the short how-to. Rebuilt every 30 min
 *     (STARTHERE_refreshStatus) so it is never stale. Top block shows either
 *     "✅ Nothing to click" or a red row per problem with the exact menu path.
 *  2) "Start Here" side panel opens automatically when the spreadsheet opens
 *     (installable onOpen → STARTHERE_onOpen): same status + one-click buttons.
 *  3) Instruction Manual + GM Daily rebuild nightly and whenever the docs version
 *     below changes (bump STARTHERE_DOCS_VERSION whenever you change doc text or
 *     add a feature — the next refresh rebuilds both tabs automatically).
 *
 * ONE-TIME SETUP: run STARTHERE_SETUP_RUN_ONCE() from the editor.
 * Public: STARTHERE_SETUP_RUN_ONCE, STARTHERE_showSidebar, STARTHERE_refreshNow,
 *         STARTHERE_refreshStatus, STARTHERE_nightlyDocs, STARTHERE_onOpen,
 *         STARTHERE_getStatus, STARTHERE_run, STARTHERE_selfTest
 */

var STARTHERE_DOCS_VERSION = '2026-09-25.3';   // ← bump on any doc/feature change

// Actions the side panel / GM Daily may point to. key → [menu path, function]
var STARTHERE_ACTIONS = {
  triggers:  ['🛠 Recruiting OS → 🔧 Admin & Setup → Install All Triggers', 'installAllTriggers'],
  blocked:   ['🛠 Recruiting OS → ✉ Email Queue → Recover Blocked Email Queue', 'recoverBlockedEmailQueue'],
  dropped:   ['🛠 Recruiting OS → ⭐ Start Here → Fix Missing Applications Now', 'INTAKE_repairDroppedPreScreens'],
  errors:    ['🛠 Recruiting OS → ✉ Email Queue → View Recent Errors', 'viewRecentErrors'],
  aikey:     ['🛠 Recruiting OS → 🔧 Admin & Setup → Set Gemini API Key…', 'ADMIN_setGeminiKey'],
  catchup:   ['🛠 Recruiting OS → ⭐ Catch Me Up & Show My Day', 'catchMeUp'],
  quickadd:  ['🛠 Recruiting OS → 📞 Quick Add Candidate (booked by phone)', 'PEOPLE_openQuickAdd'],
  pipeline:  ['Interview Pipeline tab', 'STARTHERE_goPipeline'],
  registry:  ['People Registry tab', 'STARTHERE_goRegistry'],
  refresh:   ['🛠 Recruiting OS → ⭐ Start Here → Refresh Status Now', 'STARTHERE_refreshNow']
};

// ─────────────────────────────────────────────────────────────────────────────
// STATUS ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @return {{checks:Array<{ok:boolean,label:string,detail:string,action:string}>,
 *           work:Array<{label:string,value:string,action:string}>, allOk:boolean, at:string}}
 */
function STARTHERE_getStatus() {
  var checks = [], work = [];
  function add(ok, label, detail, action) { checks.push({ ok: !!ok, label: label, detail: detail || '', action: ok ? '' : (action || '') }); }
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  // 1. Mode
  var live = String(CFG.get('SYSTEM_MODE', 'TEST')).toUpperCase() === 'LIVE' && CFG.getBool('SEND_ENABLED', true);
  var paused = CFG.getBool('HIRING_PAUSE_MODE', false);
  add(true, live ? 'LIVE — real candidates are emailed' : 'TEST mode — emails go to the test inbox only',
      paused ? 'Hiring Pause is ON (new applicants get "not currently hiring").' : '', '');

  // 2. Automations running
  var trg = safe(function () {           // read-only (assertTriggerSet_ would log a CRITICAL every run)
    var have = {};
    ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
    var miss = (typeof EXPECTED_TRIGGER_HANDLERS !== 'undefined' ? EXPECTED_TRIGGER_HANDLERS : [])
      .filter(function (f) { return !have[f]; });
    return { ok: miss.length === 0, missing: miss };
  }, { ok: true, missing: [] });
  add(trg.ok, trg.ok ? 'All automations are running' : 'Automations missing: ' + trg.missing.length,
      trg.ok ? '' : trg.missing.join(', '), 'triggers');

  // 3. Applications reaching the system
  var dropped = safe(function () { return typeof INTAKE_countDroppedPreScreens_ === 'function' ? INTAKE_countDroppedPreScreens_() : 0; }, 0);
  add(dropped === 0, dropped === 0 ? 'Every application form is in the system' : dropped + ' application(s) not yet in All Candidates',
      dropped === 0 ? '' : 'Auto-repair runs daily at 6 AM — or click to fix now.', 'dropped');

  // 4. Emails flowing
  var blocked = safe(function () { return queueBlockedCount_(); }, 0);
  add(blocked === 0, blocked === 0 ? 'Email queue is flowing' : blocked + ' email(s) stuck in the queue (fixable)',
      blocked ? 'Duplicate-prevention blocks are normal and not counted.' : '', 'blocked');

  // 5. AI grading
  var ai = safe(function () { return assertAiReady_(); }, { ok: true, detail: '' });
  add(ai.ok, ai.ok ? 'AI grading is ready' : 'AI grading problem', ai.ok ? '' : ai.detail, 'aikey');

  // 6. Serious errors in the last 24h
  var errs = safe(function () { return _STARTHERE_recentErrorCount_(24); }, 0);
  add(errs === 0, errs === 0 ? 'No serious errors in the last 24 hours' : errs + ' serious error(s) in the last 24 hours',
      errs ? 'Review them; most self-heal on the next run.' : '', 'errors');

  // YOUR WORK
  var kpis = safe(function () { return _digestKpis_(); }, []);
  function kpi(l) { for (var i = 0; i < kpis.length; i++) if (kpis[i].label === l) return kpis[i].value; return '—'; }
  var iv = safe(function () { return _digestTodaysInterviews_(); }, []);
  work.push({ label: 'Candidates waiting on your decision', value: String(kpi('Pending decisions')), action: 'pipeline' });
  work.push({ label: 'Interviews today', value: String(iv.length) + (iv.length ? ' — ' + iv.slice(0, 4).map(function (x) { return (x.time ? x.time + ' ' : '') + x.name; }).join(', ') : ''), action: 'pipeline' });
  var held = safe(function () { return _STARTHERE_recentRegistryApplicants_(36); }, []);
  work.push({ label: 'Former employees / do-not-contact who applied (held, no email)', value: held.length ? held.join(', ') : '0', action: held.length ? 'registry' : '' });
  var poss = safe(function () { return _PEOPLE_planMerge_().possible.length; }, 0);
  work.push({ label: 'Possible duplicates to eyeball (same name, different email + phone)', value: String(poss), action: poss ? 'pipeline' : '' });
  var awaiting = safe(function () { return _STARTHERE_countFinalRec_('Awaiting Pre-Screen'); }, 0);
  work.push({ label: 'Indeed applicants who have not filled out the form yet', value: String(awaiting) + ' (no action — reminders + auto-cleanup handle them)', action: '' });

  var allOk = checks.every(function (c) { return c.ok; });
  return { checks: checks, work: work, allOk: allOk, at: shopDateTime_() };
}

function _STARTHERE_recentErrorCount_(hours) {
  var sh = getSheetOrNull_(SHEETS.ERROR_LOG);
  if (!sh || sh.getLastRow() < 2) return 0;
  var n = Math.min(400, sh.getLastRow() - 1);
  var start = sh.getLastRow() - n + 1;
  var hd = getHeaderRow_(sh), iT = hd.indexOf('Timestamp'), iS = hd.indexOf('Severity'), iF = hd.indexOf('Function');
  var cutoff = Date.now() - hours * 3600000, c = 0;
  sh.getRange(start, 1, n, hd.length).getValues().forEach(function (r) {
    var t = (r[iT] instanceof Date) ? r[iT].getTime() : new Date(String(r[iT]).replace(' ', 'T')).getTime();
    if (!isNaN(t) && t >= cutoff && /^(ERROR|CRITICAL)$/i.test(String(r[iS])) &&
        String(r[iF]) !== 'systemSelfAudit_') c++;           // self-audit only restates checks shown above
  });
  return c;
}

function _STARTHERE_recentRegistryApplicants_(hours) {
  var sh = getSheetOrNull_(typeof PEOPLE_SHEET !== 'undefined' ? PEOPLE_SHEET : 'People Registry');
  if (!sh || sh.getLastRow() < 2) return [];
  var hd = getHeaderRow_(sh), H = {}; hd.forEach(function (h, i) { H[h] = i; });
  var cutoff = Date.now() - hours * 3600000, out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, hd.length).getValues().forEach(function (r) {
    var d = r[H['Last Applied']]; var t = (d instanceof Date) ? d.getTime() : new Date(d).getTime();
    if (!isNaN(t) && t >= cutoff) out.push(r[H['Person Name']] + ' (' + r[H['Flag']] + ')');
  });
  return out;
}

function _STARTHERE_countFinalRec_(prefix) {
  var ip = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!ip || ip.getLastRow() < 2) return 0;
  var col = getColIndex_(ip, 'Final Recommendation');
  if (!col) return 0;
  return ip.getRange(2, col, ip.getLastRow() - 1, 1).getValues()
    .filter(function (v) { return String(v[0]).indexOf(prefix) === 0; }).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// GM DAILY TAB (status board + short guide) — called by buildGmQuickStart()
// ─────────────────────────────────────────────────────────────────────────────

function STARTHERE_buildGmDaily_() {
  var name = (typeof SHEETS !== 'undefined' && SHEETS.GM_QUICKSTART) ? SHEETS.GM_QUICKSTART : 'GM Daily';
  var sh = getOrCreateSheet_(name, ['Step', 'What you do']);
  var st = STARTHERE_getStatus();
  var dec = function (k, d) { return CFG.get(k, d); };

  sh.clear();
  try { sh.getRange(1, 1, sh.getMaxRows(), 2).breakApart(); } catch (e) {}
  var rows = [], fmt = [];   // fmt: 'title' | 'head' | 'ok' | 'bad' | 'info' | 'body'
  function push(a, b, f) { rows.push([a, b]); fmt.push(f); }

  push('GM Daily — start here', 'Auto-updated ' + st.at + ' (refreshes every 30 minutes)', 'title');
  push(st.allOk ? '✅  SYSTEM STATUS: ALL GOOD' : '⚠️  SYSTEM STATUS: ' + st.checks.filter(function (c) { return !c.ok; }).length + ' ITEM(S) NEED A CLICK',
       st.allOk ? 'Nothing to click. Everything below runs automatically.' :
                  'Do the red rows below, top to bottom. Each one names the exact menu item.', st.allOk ? 'ok' : 'bad');
  st.checks.forEach(function (c) {
    var fix = c.action && STARTHERE_ACTIONS[c.action] ? '   →  CLICK: ' + STARTHERE_ACTIONS[c.action][0] : '';
    push((c.ok ? '✅  ' : '❌  ') + c.label, (c.detail || (c.ok ? '' : '')) + fix, c.ok ? 'ok' : 'bad');
  });

  push('📋  YOUR WORK TODAY', '', 'head');
  st.work.forEach(function (w) { push('•  ' + w.label, w.value, 'info'); });

  push('HOW TO RUN HIRING', '', 'head');
  push('1.  Read your email',
    'Twice a day you get a "Recruiting Morning Brief / Afternoon Update" email. "Needs your decision" is everyone ' +
    'waiting on you. "🚫 Held" lists former employees / do-not-contact people who applied again (they were NOT emailed).', 'body');
  push('2.  Pick a Manager Decision',
    'Interview Pipeline tab → read the AI Recommendation → choose a value in the Manager Decision dropdown. That one ' +
    'click sends the right email and moves the candidate forward. You never type a status or send an email yourself.', 'body');
  push('3.  Decisions you will use most',
    '①  ' + dec('DECISION_ADVANCE_LIVE', 'Advance to Live Interview') + ' — emails them the live-interview booking link.\n' +
    '②  ' + dec('DECISION_INTERVIEW_BOOKED', 'Interview Booked (Manual)') + ' — you booked them yourself (phone/in person). NO email, never auto-archived.\n' +
    '③  ' + dec('DECISION_REQUEST_REFERENCES', 'Request References') + ' — references + culture-fit forms; the rest runs unattended.\n' +
    '④  ' + dec('DECISION_HIRED', 'Confirm Hire') + ' — adds them to the People Registry as a Current Employee. The system never emails them again; you get the onboarding checklist.\n' +
    '     …or ' + dec('DECISION_PUT_IN_DRAWER', 'Put in the Drawer') + ' to keep them warm without hiring.', 'body');
  push('Booked someone by phone who is NOT in the sheet?',
    'Menu: ' + STARTHERE_ACTIONS.quickadd[0] + '. Name, phone, email, role, interview time → they are added as ' +
    'Interview Booked (Manual). No emails. If they apply later, it attaches to the same person.', 'body');
  push('Former employee or someone you never want contacted?',
    'People Registry tab. Everyone on it gets NO candidate emails and never lands on the pipeline — it syncs from ' +
    'payroll every morning, and Confirm Hire adds new hires automatically. To add someone: new row, Flag = ' +
    '"Former Employee" or "Do Not Contact". To give a former employee a second look: set Flag = "Cleared to Apply".', 'body');
  push('Duplicates?',
    'Handled. The same person applying under another role, a nickname, or an Indeed email is kept as ONE record ' +
    '(extra roles go in "Roles Applied"). Nightly merge moves any leftovers to the "Merged Duplicates" tab.', 'body');
  push('Made a mistake?',
    'Pick "' + dec('DECISION_REOPEN', 'Reopen Candidate') + '". Rejection and drawer emails are delayed — reopening cancels them before they send.', 'body');
  push('Other choices (rarely needed)',
    [dec('DECISION_ADVANCE_PHONE', 'Send Phone Screen Booking'), dec('DECISION_ADVANCE_WORKING', 'Send Working Interview'),
     dec('DECISION_MAKE_OFFER', 'Extend Offer'), dec('DECISION_NEEDS_INFO', 'Needs More Info'),
     dec('DECISION_REJECT', 'Reject') + ' (set Rejection Reason first)', dec('DECISION_ARCHIVE', 'Archive — No Email')].join(' · '), 'body');
  push('Your tabs',
    (typeof gmTopTenTabs_ === 'function')
      ? gmTopTenTabs_().map(function (t, i) { return (i + 1) + '.  ' + t[0] + ' — ' + t[1]; }).join('\n')
      : 'Interview Pipeline · All Candidates · People Registry · Email Queue', 'body');
  push('Full detail', 'The "Instruction Manual" tab (rebuilds itself nightly, so it always matches the system).', 'body');

  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.setColumnWidth(1, 380); sh.setColumnWidth(2, 820);
  sh.getRange(1, 1, rows.length, 2).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  var colors = { title: ['#0b3d2e', '#ffffff'], head: ['#1f3a5f', '#ffffff'], ok: ['#e6f4ea', '#0b3d2e'],
                 bad: ['#fce8e6', '#8a1c12'], info: ['#fff8e1', '#3d2e00'], body: ['#ffffff', '#222222'] };
  fmt.forEach(function (f, i) {
    var r = sh.getRange(i + 1, 1, 1, 2);
    r.setBackground(colors[f][0]).setFontColor(colors[f][1]);
    if (f === 'title' || f === 'head') r.setFontWeight('bold').setFontSize(f === 'title' ? 14 : 12);
    else sh.getRange(i + 1, 1).setFontWeight('bold');
  });
  sh.setFrozenRows(2);
  try { sh.setTabColor(st.allOk ? '#1e8e3e' : '#d93025'); } catch (e) {}
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGERS
// ─────────────────────────────────────────────────────────────────────────────

/** Every 30 min: rebuild GM Daily; rebuild Instruction Manual if the docs version changed. */
function STARTHERE_refreshStatus() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('STARTHERE_refreshStatus', 'OK');
  return withLockOrSkip_('STARTHERE_refreshStatus', function () {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('STARTHERE_DOCS_VERSION') !== STARTHERE_DOCS_VERSION) {
      if (typeof buildInstructionManual === 'function') buildInstructionManual();
      props.setProperty('STARTHERE_DOCS_VERSION', STARTHERE_DOCS_VERSION);
    }
    return '[STARTHERE] GM Daily rows: ' + STARTHERE_buildGmDaily_();
  });
}

/** Nightly: rebuild both doc tabs from the live system. */
function STARTHERE_nightlyDocs() {
  if (typeof _triggerHeartbeat_ === 'function') _triggerHeartbeat_('STARTHERE_nightlyDocs', 'OK');
  if (typeof buildInstructionManual === 'function') safeRun_('STARTHERE:manual', buildInstructionManual);
  PropertiesService.getScriptProperties().setProperty('STARTHERE_DOCS_VERSION', STARTHERE_DOCS_VERSION);
  return withLockOrSkip_('STARTHERE_nightlyDocs', function () { return STARTHERE_buildGmDaily_(); });
}

/** Installable onOpen: jump to GM Daily and open the Start Here panel. */
function STARTHERE_onOpen(e) {
  try {
    var ss = (e && e.source) || SpreadsheetApp.getActiveSpreadsheet();
    var gm = ss.getSheetByName((typeof SHEETS !== 'undefined' && SHEETS.GM_QUICKSTART) || 'GM Daily');
    if (gm) ss.setActiveSheet(gm);
    if (CFG.getBool('STARTHERE_SIDEBAR_ON_OPEN', true)) STARTHERE_showSidebar();
  } catch (err) { Logger.log('STARTHERE_onOpen: ' + err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDE PANEL
// ─────────────────────────────────────────────────────────────────────────────

function STARTHERE_showSidebar() {
  var html = HtmlService.createHtmlOutput(_STARTHERE_sidebarHtml_()).setTitle('⭐ Start Here');
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Whitelisted actions only — the panel can never call anything else. */
function STARTHERE_run(key) {
  var a = STARTHERE_ACTIONS[key];
  if (!a) throw new Error('Unknown action: ' + key);
  var fn = globalThis[a[1]];
  if (typeof fn !== 'function') throw new Error('Function not available: ' + a[1]);
  var res = fn();
  if (key !== 'pipeline' && key !== 'registry' && key !== 'quickadd' && key !== 'catchup') {
    safeRun_('STARTHERE:rebuildAfterFix', STARTHERE_buildGmDaily_);
  }
  return String(res === undefined ? 'Done.' : res).slice(0, 400);
}

function STARTHERE_goPipeline() { var ss = SpreadsheetApp.getActiveSpreadsheet(); ss.setActiveSheet(ss.getSheetByName(SHEETS.INTERVIEW_PIPELINE)); return 'Opened Interview Pipeline'; }
function STARTHERE_goRegistry() { var ss = SpreadsheetApp.getActiveSpreadsheet(); var s = ss.getSheetByName('People Registry'); if (s) { s.showSheet(); ss.setActiveSheet(s); } return 'Opened People Registry'; }

/** Menu: refresh GM Daily now and re-open the panel. */
function STARTHERE_refreshNow() {
  STARTHERE_buildGmDaily_();
  try { STARTHERE_showSidebar(); } catch (e) {}
  return 'Refreshed';
}

function _STARTHERE_sidebarHtml_() {
  return [
    '<style>',
    'body{font-family:Arial,sans-serif;font-size:13px;margin:10px;color:#222}',
    'h3{margin:14px 0 6px;font-size:12px;text-transform:uppercase;color:#555}',
    '.banner{padding:10px;border-radius:6px;font-weight:bold;margin-bottom:8px}',
    '.ok{background:#e6f4ea;color:#0b3d2e}.bad{background:#fce8e6;color:#8a1c12}',
    '.row{padding:6px 8px;border-bottom:1px solid #eee}.row small{color:#666;display:block}',
    'button{display:block;width:100%;margin:6px 0;padding:9px;border:0;border-radius:5px;background:#0b3d2e;color:#fff;font-size:13px;cursor:pointer;text-align:left}',
    'button.fix{background:#b3261e}button.sec{background:#1f3a5f}#msg{margin-top:8px;color:#0b3d2e;font-size:12px}',
    '</style>',
    '<div id="root">Checking the system…</div><div id="msg"></div>',
    '<script>',
    'function el(tag, cls, text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}',
    'function run(key,label){var m=document.getElementById("msg");m.textContent=label+"…";',
    '  google.script.run.withSuccessHandler(function(r){m.textContent="✓ "+r;load();})',
    '  .withFailureHandler(function(e){m.textContent="Error: "+e.message;}).STARTHERE_run(key);}',
    'function btn(parent,cls,text,key){var b=el("button",cls,text);b.onclick=function(){run(key,text);};parent.appendChild(b);}',
    'function row(parent,main,sub){var d=el("div","row");d.appendChild(el("div",null,main));if(sub)d.appendChild(el("small",null,sub));parent.appendChild(d);}',
    'function render(s){var r=document.getElementById("root");r.innerHTML="";',
    '  var bad=s.checks.filter(function(c){return !c.ok;});',
    '  r.appendChild(el("div","banner "+(s.allOk?"ok":"bad"), s.allOk?"✅ All good — nothing to click":"⚠️ "+bad.length+" item(s) need a click"));',
    '  bad.forEach(function(c){ if(c.action) btn(r,"fix","Fix: "+c.label,c.action); });',
    '  r.appendChild(el("h3",null,"System"));',
    '  s.checks.forEach(function(c){row(r,(c.ok?"✅ ":"❌ ")+c.label,c.detail);});',
    '  r.appendChild(el("h3",null,"Your work today"));',
    '  s.work.forEach(function(w){row(r,w.value,w.label);});',
    '  r.appendChild(el("h3",null,"Quick actions"));',
    '  btn(r,"","📋 Open Interview Pipeline","pipeline");',
    '  btn(r,"","📞 Quick Add candidate (booked by phone)","quickadd");',
    '  btn(r,"sec","⭐ Catch Me Up & Show My Day","catchup");',
    '  btn(r,"sec","🚫 People Registry (employees / do-not-contact)","registry");',
    '  btn(r,"sec","🔄 Refresh status","refresh");',
    '  var f=el("div",null,"Checked "+s.at+". This panel opens every time the sheet opens.");f.style.cssText="color:#888;font-size:11px;margin-top:8px";r.appendChild(f);}',
    'function load(){google.script.run.withSuccessHandler(render).withFailureHandler(function(e){document.getElementById("root").textContent="Could not load status: "+e.message;}).STARTHERE_getStatus();}',
    'load();',
    '</script>'
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME SETUP
// ─────────────────────────────────────────────────────────────────────────────

function STARTHERE_SETUP_RUN_ONCE() {
  var out = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  if (!have.STARTHERE_onOpen) { ScriptApp.newTrigger('STARTHERE_onOpen').forSpreadsheet(ss).onOpen().create(); out.push('✓ open trigger (Start Here panel)'); }
  if (!have.STARTHERE_refreshStatus) { ScriptApp.newTrigger('STARTHERE_refreshStatus').timeBased().everyMinutes(30).create(); out.push('✓ 30-min GM Daily refresh'); }
  if (!have.STARTHERE_nightlyDocs) { ScriptApp.newTrigger('STARTHERE_nightlyDocs').timeBased().everyDays(1).atHour(4).create(); out.push('✓ nightly docs rebuild (4 AM)'); }
  if (typeof buildInstructionManual === 'function') { buildInstructionManual(); out.push('✓ Instruction Manual rebuilt'); }
  PropertiesService.getScriptProperties().setProperty('STARTHERE_DOCS_VERSION', STARTHERE_DOCS_VERSION);
  out.push('✓ GM Daily rebuilt (' + STARTHERE_buildGmDaily_() + ' rows)');
  var msg = '[STARTHERE] setup\n' + out.join('\n'); Logger.log(msg); return msg;
}

function STARTHERE_selfTest() {
  var s = STARTHERE_getStatus();
  var msg = '[STARTHERE] selfTest — allOk=' + s.allOk + '\n' +
    s.checks.map(function (c) { return '  ' + (c.ok ? 'OK ' : 'BAD') + ' ' + c.label + (c.action ? ' → ' + c.action : ''); }).join('\n') + '\n' +
    s.work.map(function (w) { return '  • ' + w.label + ': ' + w.value; }).join('\n');
  Logger.log(msg); return msg;
}
