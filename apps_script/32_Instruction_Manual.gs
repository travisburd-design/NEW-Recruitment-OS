/**
 * 32_Instruction_Manual.gs
 * Frank's European Service — Recruiting OS
 *
 * In-sheet, self-service documentation. Rebuilds two human-facing tabs so any
 * future admin can operate the system without a developer:
 *
 *   buildInstructionManual()    — rebuilds the "Instruction Manual" tab: a
 *                                 section-by-section operator guide driven by
 *                                 A's real SHEETS map, STATUS values, menu,
 *                                 and Config keys.
 *   buildManualSetupRegistry()  — rebuilds the "Manual Setup Registry" tab: the
 *                                 one-time, human-required setup steps (forms,
 *                                 secrets, calendar, triggers, go-live) each with
 *                                 a Status column the operator ticks off.
 *
 * Hard rules honored:
 *   - No candidate row is ever read or written here. No email is ever sent.
 *   - All sheet writes go through getOrCreateSheet_ and are wrapped in withLock_.
 *   - Content describes A's ACTUAL schema — never copied from any retired build.
 *   - This file does NOT re-implement goLive()/returnToTestMode()/smokeTest();
 *     A's superior versions live in 21_Go_Live.gs and 23_Smoke_Test.gs.
 *
 * Public functions:
 *   buildInstructionManual()
 *   buildManualSetupRegistry()
 *   INSTRUCTION_MANUAL_selfTest()
 */

// ─────────────────────────────────────────────────────────────────────────────
// Local sheet-name + header constants (mirror the convention used in 00_Config;
// see /tmp/port_spec4.md for the canonical SHEETS additions to make centrally).
// ─────────────────────────────────────────────────────────────────────────────
var INSTRUCTION_MANUAL_SHEET     = 'Instruction Manual';
var MANUAL_SETUP_REGISTRY_SHEET  = 'Manual Setup Registry';

var INSTRUCTION_MANUAL_HEADERS    = ['Section', 'Content'];
var MANUAL_SETUP_REGISTRY_HEADERS = ['Step', 'Category', 'What To Do', 'Where / Value', 'Status', 'Notes'];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: buildInstructionManual
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the Instruction Manual tab from scratch. Clears existing content,
 * writes the header row, then writes every section in ONE batched setValues.
 * Returns the number of section rows written.
 */
function buildInstructionManual() {
  return safeRun_('buildInstructionManual', function () {
    return withLock_(function () {
      var sh = getOrCreateSheet_(INSTRUCTION_MANUAL_SHEET, INSTRUCTION_MANUAL_HEADERS);

      sh.clearContents();
      sh.getRange(1, 1, 1, INSTRUCTION_MANUAL_HEADERS.length).setValues([INSTRUCTION_MANUAL_HEADERS]);
      sh.getRange(1, 1, 1, INSTRUCTION_MANUAL_HEADERS.length)
        .setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
      sh.setFrozenRows(1);

      var sections = buildManualSections_();
      // SINGLE batched write for performance.
      sh.getRange(2, 1, sections.length, 2).setValues(sections);

      // Readable layout: narrow section column, wide wrapped content column.
      sh.setColumnWidth(1, 240);
      sh.setColumnWidth(2, 920);
      sh.getRange(2, 1, sections.length, 1).setFontWeight('bold').setVerticalAlignment('top');
      sh.getRange(2, 2, sections.length, 1).setWrap(true).setVerticalAlignment('top');

      toast_('Instruction Manual rebuilt (' + sections.length + ' sections).', 'Recruiting OS', 6);
      return sections.length;
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: buildGmQuickStart — a short, GM-focused "your daily job" one-pager.
// Distinct from the comprehensive Instruction Manual: this is the 3-step card a
// General Manager reads to run hiring without learning the whole system.
// ─────────────────────────────────────────────────────────────────────────────

var GM_QUICKSTART_SHEET   = 'GM Daily';
var GM_QUICKSTART_HEADERS = ['Step', 'What you do'];

function buildGmQuickStart() {
  return safeRun_('buildGmQuickStart', function () {
    return withLock_(function () {
      var name = (typeof SHEETS !== 'undefined' && SHEETS.GM_QUICKSTART) ? SHEETS.GM_QUICKSTART : GM_QUICKSTART_SHEET;
      var sh = getOrCreateSheet_(name, GM_QUICKSTART_HEADERS);
      sh.clearContents();

      var dec = function (k, dflt) { return CFG.get(k, dflt); };
      var rows = [
        ['☀️  START HERE — your whole job is 3 steps',
         'You work from ONE tab ("Interview Pipeline") and ONE column ("Manager Decision"). ' +
         'The system does everything else — scoring, emailing candidates, booking, references, reminders.'],

        ['1.  Read your email',
         'Twice a day you get a "Recruiting Morning Brief / Afternoon Update" email. ' +
         'The "Needs your decision" list is everyone waiting on you. Click a candidate\'s name, or the ' +
         '"Open Interview Pipeline →" button, to jump straight to their row.'],

        ['2.  Pick a Manager Decision',
         'On the Interview Pipeline tab, read the AI Recommendation (green column), then choose a value in the ' +
         'Manager Decision dropdown (amber column). That single click sends the right candidate email and moves ' +
         'them to the next stage automatically. You never type a status or send an email yourself.'],

        ['3.  The 3 decisions you\'ll use most',
         '①  ' + dec('DECISION_ADVANCE_LIVE', 'Advance to Live Interview') + ' — invites them to book the live interview.\n' +
         '②  ' + dec('DECISION_REQUEST_REFERENCES', 'Request References') + ' — sends references + culture-fit forms; the rest runs unattended.\n' +
         '③  ' + dec('DECISION_HIRED', 'Confirm Hire') + ' — congratulations email + onboarding checklist.\n' +
         '     …or ' + dec('DECISION_PUT_IN_DRAWER', 'Put in the Drawer') + ' to keep them warm without hiring.'],

        ['Made a mistake?',
         'Pick "' + dec('DECISION_REOPEN', 'Reopen Candidate') + '". Rejection and "drawer" emails are delayed and ' +
         'cancellable — reopening cancels the pending email before it ever sends.'],

        ['Other choices (rarely needed)',
         dec('DECISION_ADVANCE_PHONE', 'Send Phone Screen Booking') + ', ' +
         dec('DECISION_ADVANCE_WORKING', 'Send Working Interview') + ', ' +
         dec('DECISION_MAKE_OFFER', 'Extend Offer') + ', ' +
         dec('DECISION_NEEDS_INFO', 'Needs More Info') + ', ' +
         dec('DECISION_REJECT', 'Reject') + ' (set the Rejection Reason first), ' +
         dec('DECISION_ARCHIVE', 'Archive — No Email') + '.'],

        ['Am I sending real emails?',
         'Check the menu: ⚙ Mode & Status → "Current Mode / Status". TEST = nothing reaches real candidates ' +
         '(everything reroutes to ' + CFG.get('TEST_RECIPIENT_EMAIL', 'your test inbox') + '). LIVE = real candidates ' +
         'are emailed. To flip on: ⚙ Mode & Status → "GO LIVE".'],

        ['Your tabs, left to right',
         (function () {
           var legend = 'Tab colors: 🟢 green = your daily 10 · 🔵 blue = setup/settings · 🟠 orange = raw candidate data/forms · ⚪ grey = system logs. ' +
             'Only the green 10 stay visible; the rest are hidden but still running. ' +
             '(🛠 Recruiting OS → 🔧 Admin & Setup → “Show All Tabs” reveals everything; “Organize Tabs for Manager” re-tidies.)\n\n';
           var list = (typeof gmTopTenTabs_ === 'function')
             ? gmTopTenTabs_().map(function (t, i) { return (i + 1) + '.  ' + t[0] + ' — ' + t[1]; }).join('\n')
             : '(run “Organize Tabs for Manager” from Admin & Setup to lay out your 10 tabs in order)';
           return legend + list;
         })()],

        ['Want more detail?',
         'The full operator guide is on the "Instruction Manual" tab. One-time setup steps are on the ' +
         '"Manual Setup Registry" tab. To re-tidy your tabs any time: 🛠 Recruiting OS → 🔧 Admin & Setup → "Organize Tabs for Manager".']
      ];

      // Title banner in row 1 (overwrite the header row with a friendly title).
      sh.getRange(1, 1, 1, 2).setValues([['GM Daily — run hiring in 3 steps', '']]);
      sh.getRange(1, 1, 1, 2).merge().setFontWeight('bold').setFontSize(14)
        .setBackground('#0b3d2e').setFontColor('#ffffff').setHorizontalAlignment('left');
      sh.setFrozenRows(1);

      sh.getRange(2, 1, rows.length, 2).setValues(rows);
      sh.setColumnWidth(1, 300);
      sh.setColumnWidth(2, 860);
      sh.getRange(2, 1, rows.length, 1).setFontWeight('bold').setVerticalAlignment('top');
      sh.getRange(2, 2, rows.length, 1).setWrap(true).setVerticalAlignment('top');

      toast_('GM Daily quick-start rebuilt (' + rows.length + ' steps).', 'Recruiting OS', 5);
      return rows.length;
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION BUILDER — describes A's ACTUAL system.
// Returns [[Section, Content], ...] for one batched write.
// ─────────────────────────────────────────────────────────────────────────────

function buildManualSections_() {
  var rows = [];

  var shopName    = CFG.get('SHOP_NAME', "Frank's European Service");
  var testEmail   = CFG.get('TEST_RECIPIENT_EMAIL', '(set TEST_RECIPIENT_EMAIL in Config)');
  var mode        = CFG.get('SYSTEM_MODE', 'TEST');

  // ── System Overview ─────────────────────────────────────────────────────────
  rows.push(['System Overview',
    "This Recruiting OS is the operational source of truth for " + shopName + "'s hiring pipeline. " +
    "The Config tab IS the operating system — almost every behavior is a Config key, not a code edit. " +
    "Candidates enter through ONE Pre-Screen Form (Config PRESCREEN_FORM_URL). A form submit writes a row to " +
    "'All Candidates', the candidate is AI-scored (fit + risk), and routing decides what happens next: " +
    "auto-book a phone screen, hold for manual review, or send a gracious decline. From there the manager works " +
    "candidates through the 'Interview Pipeline' tab using ONE control — the 'Manager Decision' dropdown. " +
    "Status values are written by the script (column Status), never typed by hand. " +
    "SAFETY: no candidate-facing email can leave unless SYSTEM_MODE=LIVE AND SEND_ENABLED=TRUE; in TEST mode " +
    "every candidate email is rerouted to TEST_RECIPIENT_EMAIL (currently " + testEmail + "). " +
    "The system is currently in " + mode + " mode."]);

  // ── Candidate Flow ──────────────────────────────────────────────────────────
  rows.push(['Candidate Flow (status by status)', [
    'Statuses are written by the script in the Status column of "All Candidates" / "Interview Pipeline". The human never types them.',
    '',
    'NEW — a candidate row exists but has not yet been pre-screened.',
    'PRESCREEN_SENT — pre-screen invite emailed (e.g. an imported Indeed/ACT lead).',
    'PRESCREEN_RECEIVED — the candidate submitted the Pre-Screen Form.',
    'SCORED — AI Score / Risk Score / Total Score written by scorePreScreen_; routing decided.',
    'AUTO_BOOK_SENT → PHONE_BOOKED → PHONE_DONE — phone screen booking emailed, booked via calendar, completed.',
    'FULL_BOOKED → FULL_DONE — live (full) interview booked and completed.',
    'WORKING_SCHEDULED — a paid working interview has been scheduled.',
    'REFS_PENDING → REFS_COMPLETE — reference automation in flight / finished.',
    'RECOMMENDED — recommendation engine has produced a final composite recommendation.',
    'OFFER_PENDING — manager chose "Make Offer"; offer prep checklist sent.',
    'HIRED — manager chose "Mark as Hired".',
    'MANUAL_REVIEW — parked for the manager to triage via the Manager Decision dropdown.',
    'IN_DRAWER — "Put in the Drawer" (kept warm; hold email after DRAWER_EMAIL_DELAY_DAYS).',
    'REJECTED — gracious decline (delayed REJECTION_EMAIL_DELAY_DAYS, cancellable until it sends).',
    'ARCHIVED — closed out with no email.'
  ].join('\n')]);

  // ── Daily Operations (real menu) ────────────────────────────────────────────
  rows.push(['Daily Operations — the menu', [
    'Everything is driven from the "🛠 Recruiting OS" menu (installed automatically when the spreadsheet opens).',
    '',
    'DAILY ACTIONS (top of menu):',
    '  • Send Me Everything Now — sends the daily digest + upcoming interview worksheets to your inbox.',
    '  • Send Daily Digest Now — just the digest.',
    '  • Generate & Send Upcoming Worksheets — interview prep sheets for the next few days.',
    '',
    '▶ Run Manually (these also run on automatic triggers; run on demand for immediate results):',
    '  • Process New Otter Transcripts, Grade Pending Transcripts, Poll Calendar for New Bookings,',
    '    Recompute All Recommendations, Retry Failed AI Grades.',
    '',
    '👤 Candidate Actions:',
    '  • Send "We Are Reviewing" to Pending Candidates, Import Hiring Email Leads, Process Hiring Email Leads.',
    '',
    '✉ Email Queue: Flush Queue Now, View Recent Errors.',
    '',
    '⚙ Mode & Status: Current Mode / Status, GO LIVE, Return to TEST Mode, Enable/Disable Hiring Pause.',
    '',
    '🔧 Admin & Setup: health checks, bootstrap/repair, seed templates & prompts, install triggers, backfills,',
    '   dedup, and the two doc rebuilders (Rebuild Instruction Manual / Rebuild Manual Setup Registry).',
    '',
    'THE MANAGER\'S ONLY DAILY JOB: open "Interview Pipeline", read the AI recommendation, and pick a value in the',
    '"Manager Decision" dropdown. Selecting a value fires onPipelineEdit, which queues the right email and advances Status.'
  ].join('\n')]);

  // ── Manager Decision dropdown ───────────────────────────────────────────────
  rows.push(['Manager Decision dropdown — what each choice does', [
    'On the "Interview Pipeline" tab, the "Manager Decision" cell is a dropdown. The labels are configurable',
    '(Config DECISION_* keys) and the dropdown is (re)applied by bootstrapSystem() in MANAGER_DECISION_ORDER —',
    'the happy path sits at the top. Picking a value triggers:',
    '',
    '  — THE 3 CORE DECISIONS (the only choices on the happy path) —',
    '  • Advance to Live Interview → queue full interview booking email → Status FULL_BOOKED.   [decision 1]',
    '  • Request References → ONE email to the candidate with BOTH the reference form and the culture-fit form',
    '      (48–72h deadline) → Status REFS_REQUESTED. The rest runs unattended: referees are emailed automatically,',
    '      referee + culture responses are AI graded and folded into the grand total, and a report card is emailed to',
    '      leadership. Pick this only after the live interview transcript has been ingested and graded.   [decision 2]',
    '  • Confirm Hire → Status HIRED (candidate accepted) → congratulations email + onboarding checklist.   [decision 3 — hire]',
    '  • Put in the Drawer → hold email delayed by DRAWER_EMAIL_DELAY_DAYS → Status IN_DRAWER.   [decision 3 — not hire]',
    '',
    '  — ALTERNATE / MANUAL ADVANCE ACTIONS —',
    '  • Send Phone Screen Booking → queue phone screen booking email (normally automated for qualified applicants).',
    '  • Send Working Interview → queue working interview invitation → Status WORKING_SCHEDULED.',
    '  • Extend Offer → alert manager (offer prep checklist) + candidate offer-pending email → Status OFFER_PENDING.',
    '      (Offer extended, pending acceptance — distinct from Confirm Hire above.)',
    '',
    '  — EXCEPTIONS & ADMIN —',
    '  • Needs More Info → queue a "we are reviewing" email.',
    '  • Reject → gracious decline delayed by REJECTION_EMAIL_DELAY_DAYS (cancellable) → Status REJECTED.',
    '      Set the "Rejection Reason" dropdown (same row) first to record why — for compliance and re-engagement.',
    '  • Reopen Candidate → cancels pending rejection/drawer emails → Status MANUAL_REVIEW.',
    '  • Archive — No Email → Status ARCHIVED, nothing sent.'
  ].join('\n')]);

  // ── TEST vs LIVE + email safety ─────────────────────────────────────────────
  rows.push(['TEST vs LIVE mode + email safety', [
    'KNOW YOUR MODE before doing anything that sends. Check Config SYSTEM_MODE, or run Mode & Status → "Current Mode / Status".',
    '',
    'The send gate (enforced in 14_Email_Queue.gs): a candidate email leaves Gmail ONLY when',
    'SYSTEM_MODE=LIVE AND SEND_ENABLED=TRUE. Every candidate email is routed through the Email Queue, never sent directly.',
    '',
    'TEST mode (default): actualRecipient_() reroutes EVERY candidate address to TEST_RECIPIENT_EMAIL (' + testEmail + ').',
    'No real candidate can be emailed by accident. If SEND_ENABLED=FALSE, rows sit PENDING/BLOCKED in the "Email Queue" tab.',
    '',
    'Quiet hours: QUIET_HOURS_ENABLED (default TRUE) holds sends outside QUIET_HOURS_START..QUIET_HOURS_END (shop-local).',
    'Held emails wait PENDING in the Email Queue and go out at the next flush (flushEmailQueue / EMAIL_QUEUE_FLUSH_HOUR).',
    'QUIET_HOURS_OVERRIDE=TRUE bypasses the window when you need an immediate send.',
    '',
    'ONCE-ONLY GUARANTEE (EMAIL_DEDUPE_TEMPLATE_LIFETIME=TRUE): every candidate receives a given email template AT MOST',
    'ONCE, ever, per mode. Backed by the durable "Email Sent Ledger" tab (never pruned), so the guarantee does not expire.',
    'TEST and LIVE are tracked separately, so test sends never use up a real candidate\'s one real send. A few templates are',
    'intentionally exempt (EMAIL_REPEATABLE_TEMPLATES — e.g. per-interview worksheets, booking confirmations — plus any',
    '"__"-prefixed internal manager alert). To deliberately re-send to someone, run clearEmailLedgerForCandidate(candidateId).',
    '',
    'Kill switches:',
    '  • Return to TEST Mode — instantly stops all real sends (sets SYSTEM_MODE=TEST). No checks, works any time.',
    '  • Enable Hiring Pause — new pre-screen completions get a "not currently hiring" reply and park in IN_DRAWER.',
    '',
    'GO LIVE: Mode & Status → "GO LIVE" runs productionReadinessCheck() first and REFUSES to flip to LIVE unless the',
    'verdict is PRODUCTION READY. Only then does it set SYSTEM_MODE=LIVE so real candidate emails can send.'
  ].join('\n')]);

  // ── Tab-by-Tab (data-driven from SHEETS) ────────────────────────────────────
  rows.push(['Tab-by-Tab guide', tabsExplanation_()]);

  // ── Config keys (data-driven from Config tab) ───────────────────────────────
  rows.push(['Config keys — what each controls', configKeysExplanation_()]);

  // ── Troubleshooting ─────────────────────────────────────────────────────────
  rows.push(['Troubleshooting', [
    'Email did not send → check Config SYSTEM_MODE and SEND_ENABLED, confirm TEST_RECIPIENT_EMAIL is set (TEST mode),',
    '  then open the "Email Queue" tab and read the Status/Notes columns (PENDING = quiet hours/flush; BLOCKED = a gate failed).',
    'Candidate was not scored → check the "Error Log" and confirm AI_GRADING_ENABLED=TRUE and the GEMINI_API_KEY Script Property is set',
    '  (Admin & Setup → "Ping Gemini").',
    'Booking email not sent automatically → verify the role has an Active=TRUE row in "Role Rules" with a booking link, and the',
    '  candidate Risk Score is at/under MAX_RISK_SCORE_AUTOBOOK; AUTO_BOOKING_ENABLED must be TRUE.',
    'Manager Decision dropdown is empty → run Admin & Setup → "Bootstrap / Repair System" (it re-applies the dropdown from Config DECISION_* keys).',
    'Otter transcript not matched → open "Raw Otter Transcript Intake", review Candidate Match Status / Match Method, paste a Candidate ID if needed, re-run Process New Otter Transcripts.',
    'Interview worksheet missing → run Daily Actions → "Generate & Send Upcoming Worksheets"; confirm INTERVIEW_WORKSHEETS_ENABLED=TRUE.',
    'A trigger seems dead → Admin & Setup → "Audit Triggers", then "Install All Triggers"; check the "Trigger Health" tab.',
    'General system health → Admin & Setup → "Run Health Check" and "Production Readiness Check".'
  ].join('\n')]);

  // ── EEOC / audit posture ────────────────────────────────────────────────────
  rows.push(['EEOC / fair-hiring & audit posture', [
    'AI assists; humans decide. No candidate is advanced or declined by a number alone — the manager makes every',
    'real decision through the Manager Decision dropdown.',
    '',
    'Everything is auditable: candidate emails are recorded in "Notification Log"; every queued message and its',
    'final disposition is in "Email Queue"; every AI call (model, tokens, parse status, score) is in "AI Grading Logs";',
    'system events (go-live, pause, decisions) are in "Event Log"; errors with stack + severity are in "Error Log".',
    '',
    'Rejections are delayed and cancellable (REJECTION_EMAIL_DELAY_DAYS, REJECTION_EMAIL_CANCELLABLE) so a mistaken',
    'decline can be reversed with "Reopen Candidate" before it sends.',
    '',
    'Recommended practice: keep grading rubrics/thresholds (Config + "Role Rules" + "AI Grading Rubrics") under review,',
    'and periodically scan outcomes by role for adverse-impact patterns before changing any threshold.'
  ].join('\n')]);

  // ── First-time setup pointer ────────────────────────────────────────────────
  rows.push(['One-time setup', [
    'See the "Manual Setup Registry" tab — it lists every step that needs a human (create forms + paste Edit IDs,',
    'set the Gemini API key, set the calendar, fill Hiring Managers / Role Rules, install triggers, go live), each with',
    'a Status column you tick off. Rebuild it any time via Admin & Setup → "Rebuild Manual Setup Registry".',
    '',
    'A new admin can take over by: (1) reading this Instruction Manual tab, (2) clearing every Pending row in the',
    'Manual Setup Registry, (3) running Admin & Setup → "Production Readiness Check", and (4) confirming Mode & Status.'
  ].join('\n')]);

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// tabsExplanation_ — data-driven from A's SHEETS map. Every real tab, described.
// One line per tab; tabs not in the description table fall back to a generic note.
// ─────────────────────────────────────────────────────────────────────────────

function tabsExplanation_() {
  // name -> plain-English purpose. Keyed by the actual tab name (SHEETS values).
  var desc = {};
  desc[SHEETS.CONFIG]                = 'The operating system. Every runtime setting lives here as KEY / VALUE / Notes.';
  desc[SHEETS.ROLE_RULES]            = 'Per-role thresholds, requirements, pay range, and booking links. Active=TRUE to hire that role.';
  desc[SHEETS.HIRING_MANAGERS]       = 'Active hiring managers — contact info, booking links, calendar ID, signature.';
  desc[SHEETS.FORM_REGISTRY]         = 'The authority for every approved Google Form (Form Key, Approved Form ID/URL, Edit ID, Response Tab).';
  desc[SHEETS.JOB_POSTINGS]          = 'Generated job-posting copy per role/platform plus the pre-screen link to advertise.';
  desc[SHEETS.EMAIL_TEMPLATES]       = 'Editable subject + body for every candidate email, with required merge fields.';
  desc[SHEETS.AI_PROMPTS]            = 'AI prompt templates by phase (pre-screen, transcript, etc.) — provider, model, temperature, body.';
  desc[SHEETS.AI_RUBRICS]            = 'AI grading rubrics — per-phase scoring categories, weights, and criteria.';
  desc[SHEETS.ASSESSMENT_REGISTRY]   = 'Per-role assessment config: section/rubric keys, score minimums, and booking eligibility.';
  desc[SHEETS.ALL_CANDIDATES]        = 'The master record — one row per candidate with scores, status, and contact info.';
  desc[SHEETS.INTERVIEW_PIPELINE]    = 'The manager-facing decision view. Read the recommendation, pick a "Manager Decision".';
  desc[SHEETS.CULTURE_FIT]           = 'Linked responses from the Culture Fit form (Form Responses 1).';
  desc[SHEETS.REFERENCE_REQUESTS]    = 'Linked responses where a candidate lists their references (Form Responses 2).';
  desc[SHEETS.REFERENCE_CHECKS]      = 'Linked responses where a referee fills out the reference check (Form Responses 3).';
  desc[SHEETS.SKILLS_TEST_RESPONSES] = 'Linked responses from the Technician skills test (Form Responses 4).';
  desc[SHEETS.RAW_PRESCREEN]         = 'Linked responses from the Pre-Screen Form — the entry point of all automation (Form Responses 5).';
  desc[SHEETS.RAW_OTTER_INTAKE]      = 'Raw interview transcripts delivered by Zapier from Otter; processed into archives + grades.';
  desc[SHEETS.TRANSCRIPT_ARCHIVE]    = 'Permanent archive of matched, graded interview transcripts.';
  desc[SHEETS.EMAIL_QUEUE]           = 'Every candidate email passes through here. Status shows PENDING / SENT / CANCELLED / BLOCKED / FAILED.';
  desc[SHEETS.NOTIFICATION_LOG]      = 'Send history for candidate emails (used for duplicate prevention and audit).';
  desc[SHEETS.ERROR_LOG]             = 'Every script error with severity, function, stack, and recovery note.';
  desc[SHEETS.EVENT_LOG]             = 'System events — go-live, hiring pause, manager decisions, and other milestones.';
  desc[SHEETS.TRIGGER_HEALTH]        = 'Install/audit status for every automatic trigger.';
  desc[SHEETS.AI_GRADING_LOGS]       = 'Every AI call: model, tokens, parse OK, score, risk, duration — the AI audit trail.';
  desc[SHEETS.SETUP_REGISTRY]        = 'Auto-generated log of what bootstrapSystem() created/repaired (machine-written).';
  desc[SHEETS.DAILY_DIGEST_LOG]      = 'One row per daily digest sent.';
  desc[SHEETS.BACKFILL_REVIEW]       = 'Queue of rows that backfill/repair could not resolve automatically — needs a human.';
  desc[SHEETS.INTERVIEW_WORKSHEETS]  = 'Tailored interview prep sheets generated per upcoming interview.';
  desc[SHEETS.RAW_HIRING_EMAIL_LEADS]= 'Imported hiring leads from Indeed / ACT Auto Staffing emails, awaiting pre-screen invite.';
  desc[SHEETS.DASHBOARD]             = 'Your live metrics view (layout is yours — bootstrap never overwrites it).';
  desc[SHEETS.GM_QUICKSTART]         = 'The General Manager\'s 3-step daily card — read this first (rebuilt by buildGmQuickStart()).';

  // These two are owned by this file and may not be in SHEETS yet.
  var lines = [];
  Object.keys(SHEETS).forEach(function (key) {
    var name = SHEETS[key];
    var d = desc[name] || '(operational tab — see the relevant module).';
    lines.push(name + ' — ' + d);
  });
  lines.push(INSTRUCTION_MANUAL_SHEET + ' — this tab (rebuilt by buildInstructionManual()).');
  lines.push(MANUAL_SETUP_REGISTRY_SHEET + ' — one-time human setup steps with a Status column.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// configKeysExplanation_ — data-driven from A's Config tab.
// A's Config tab uses columns KEY / VALUE / Notes. We surface KEY — Notes so the
// manual documents whatever the operator has actually configured + annotated.
// ─────────────────────────────────────────────────────────────────────────────

function configKeysExplanation_() {
  var sh = getSheetOrNull_(SHEETS.CONFIG);
  if (!sh) return 'Config tab not found — run Admin & Setup → "Bootstrap / Repair System" first.';

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return 'Config tab is empty — run "Bootstrap / Repair System" to seed defaults.';

  // Resolve KEY / VALUE / Notes columns case-insensitively (fallback to 0/1/2).
  var header = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var keyCol  = header.indexOf('key');
  var valCol  = header.indexOf('value');
  var noteCol = header.indexOf('notes');
  if (keyCol  === -1) keyCol  = 0;
  if (valCol  === -1) valCol  = 1;
  if (noteCol === -1) noteCol = 2;

  var out = [];
  for (var i = 1; i < values.length; i++) {
    var k = String(values[i][keyCol] || '').trim();
    if (!k) continue;
    var note = String(values[i][noteCol] || '').trim();
    var val  = String(values[i][valCol] || '').trim();
    var detail = note || ('current value: ' + (val || '(blank)'));
    out.push(k + ' — ' + detail);
  }
  return out.length ? out.join('\n') : 'No Config keys found.';
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: buildManualSetupRegistry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the Manual Setup Registry tab — the checklist of one-time, human-only
 * setup steps. Preserves any Status the operator already set (matched by Step
 * name); only fills Status on brand-new rows. Wrapped in withLock_.
 */
function buildManualSetupRegistry() {
  return safeRun_('buildManualSetupRegistry', function () {
    return withLock_(function () {
      if (!CFG.getBool('MANUAL_SETUP_REGISTRY_ENABLED', true)) {
        toast_('Manual Setup Registry disabled in Config (MANUAL_SETUP_REGISTRY_ENABLED=FALSE).', 'Recruiting OS', 6);
        return 0;
      }
      var n = seedManualSetupRegistry_();
      toast_('Manual Setup Registry refreshed (' + n + ' steps).', 'Recruiting OS', 5);
      return n;
    });
  });
}

/**
 * Write the human-required setup steps to the Manual Setup Registry tab.
 * Idempotent: existing Step rows keep their Status; only missing steps are
 * appended. Returns the total number of steps in the registry afterward.
 *
 * Steps describe A's ACTUAL one-time setup (forms + Edit IDs, Gemini key,
 * calendar, fill config tables, install triggers, go live).
 */
function seedManualSetupRegistry_() {
  var sh = getOrCreateSheet_(MANUAL_SETUP_REGISTRY_SHEET, MANUAL_SETUP_REGISTRY_HEADERS);

  // Style header to match the manual.
  sh.getRange(1, 1, 1, MANUAL_SETUP_REGISTRY_HEADERS.length)
    .setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  // Status dropdown for human use.
  var statusCol = MANUAL_SETUP_REGISTRY_HEADERS.indexOf('Status') + 1;
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pending', 'Done', 'N/A'], true)
    .setAllowInvalid(true)
    .build();
  sh.getRange(2, statusCol, Math.max(1, sh.getMaxRows() - 1), 1).setDataValidation(statusRule);

  // What we already have (match on Step in column 1) so we never clobber a Status.
  var existing = {};
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      existing[String(r[0]).trim()] = true;
    });
  }

  // [Step, Category, What To Do, Where / Value, Status, Notes]
  var steps = [
    ['Bootstrap the spreadsheet',
     'System',
     'Run Admin & Setup → "Bootstrap / Repair System" to create every tab and seed Config defaults (idempotent — safe to re-run).',
     'Menu → 🔧 Admin & Setup', 'Pending', ''],

    ['Set the Gemini API key',
     'Secrets',
     'Paste your Gemini API key into Project Settings → Script Properties under key GEMINI_API_KEY. Secrets never go in the Config tab. Verify with Admin & Setup → "Ping Gemini".',
     'Apps Script → Project Settings → Script Properties → GEMINI_API_KEY', 'Pending', ''],

    ['Create the Google Forms (if they do not exist)',
     'Forms',
     'Create the 5 forms (Pre-Screen, Culture Fit, Reference Submission, Reference Check, Skills Test) OR locate the approved ones. Each form must be linked to THIS spreadsheet (form → Responses → Link to Sheets).',
     'Google Forms', 'Pending', ''],

    ['Paste form Edit IDs into Form Registry',
     'Forms',
     'For each form, open it in edit mode and copy the form ID from the URL into the "Edit ID" column of the "Form Registry" tab (also fill Approved Form ID / Approved Form URL / Response Tab). Then run Admin & Setup → "Verify Form Registry".',
     'Form Registry tab', 'Pending', ''],

    ['Confirm linked response tabs',
     'Forms',
     'Confirm each form writes to its expected response tab: Pre-Screen → "Form Responses 5", Culture Fit → "Form Responses 1", Reference Submission → "Form Responses 2", Reference Check → "Form Responses 3", Skills Test → "Form Responses 4".',
     'Spreadsheet tabs', 'Pending', ''],

    ['Set the recruiting calendar',
     'Calendar',
     'Set Config RECRUITING_CALENDAR_NAME (default "Frank Recruiting Interviews") and put the Google Calendar ID on the active row of the "Hiring Managers" tab. Calendar polling reads bookings from here.',
     'Config + Hiring Managers tab', 'Pending', ''],

    ['Fill Hiring Managers',
     'Config tables',
     'Add at least one row with Active=TRUE: name, email, phone screen + full interview booking links, and calendar ID.',
     'Hiring Managers tab', 'Pending', ''],

    ['Fill Role Rules',
     'Config tables',
     'Set Active=TRUE for each role you are hiring; fill booking links, pay range, score minimums, and Max Risk Score For Auto Booking.',
     'Role Rules tab', 'Pending', ''],

    ['Set recipient + identity config',
     'Config',
     'Confirm TEST_RECIPIENT_EMAIL, DIGEST_RECIPIENT_EMAIL, ERROR_ALERT_RECIPIENTS, HIRING_MANAGER_EMAIL, and the SHOP_* / COMPANY_* identity keys in the Config tab.',
     'Config tab', 'Pending', ''],

    ['Seed templates & AI prompts',
     'System',
     'Run Admin & Setup → "Seed All Templates", "Install / Refresh Email Templates", and "Install / Refresh AI Prompts".',
     'Menu → 🔧 Admin & Setup', 'Pending', ''],

    ['Install triggers',
     'Triggers',
     'Run Admin & Setup → "Install All Triggers" (form submits, the Interview Pipeline onEdit, transcript/calendar polling, daily digest, health check). Confirm via "Audit Triggers" and the "Trigger Health" tab.',
     'Menu → 🔧 Admin & Setup', 'Pending', ''],

    ['Test end to end (TEST mode)',
     'Validation',
     'With SYSTEM_MODE=TEST, run Admin & Setup → "Smoke Test (all)" and "Send ONE Test Email". Submit a real-looking pre-screen and trace the row through "All Candidates" → "Interview Pipeline". Confirm test emails arrive at TEST_RECIPIENT_EMAIL.',
     'Menu → 🔧 Admin & Setup', 'Pending', ''],

    ['Run Production Readiness Check',
     'Validation',
     'Run Admin & Setup → "Production Readiness Check" and resolve every blocker. GO LIVE will refuse to flip until this returns PRODUCTION READY.',
     'Menu → 🔧 Admin & Setup', 'Pending', ''],

    ['GO LIVE',
     'Go-Live',
     'When all TEST validation passes, run Mode & Status → "GO LIVE" (it re-runs the readiness check, then sets SYSTEM_MODE=LIVE so real candidate emails send).',
     'Menu → ⚙ Mode & Status', 'Pending', '']
  ];

  var toAppend = steps.filter(function (r) { return !existing[String(r[0]).trim()]; });
  if (toAppend.length) {
    var startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, toAppend.length, MANUAL_SETUP_REGISTRY_HEADERS.length).setValues(toAppend);
  }

  // Readable widths + wrap on the long columns.
  sh.setColumnWidth(1, 240);  // Step
  sh.setColumnWidth(2, 110);  // Category
  sh.setColumnWidth(3, 560);  // What To Do
  sh.setColumnWidth(4, 280);  // Where / Value
  sh.setColumnWidth(6, 240);  // Notes
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    sh.getRange(2, 3, lastRow - 1, 1).setWrap(true);
    sh.getRange(2, 4, lastRow - 1, 1).setWrap(true);
  }

  return lastRow - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only-ish: rebuilds both tabs and validates row counts.
// Safe to run any time. Touches no candidate data and sends no email.
// ─────────────────────────────────────────────────────────────────────────────

function INSTRUCTION_MANUAL_selfTest() {
  var out = ['[INSTRUCTION_MANUAL] selfTest starting…'];
  try {
    var sectionCount = buildManualSections_().length;
    out.push('  ' + (sectionCount >= 8 ? '✓' : '✗') + ' buildManualSections_ produced ' + sectionCount + ' sections (expected >= 8)');

    var allTwoCols = buildManualSections_().every(function (r) { return r.length === 2; });
    out.push('  ' + (allTwoCols ? '✓' : '✗') + ' every section row has exactly 2 columns (Section, Content)');

    var tabs = tabsExplanation_();
    out.push('  ' + (tabs.indexOf(SHEETS.CONFIG) !== -1 && tabs.indexOf(SHEETS.EMAIL_QUEUE) !== -1 ? '✓' : '✗') +
             ' tabsExplanation_ describes real tabs (Config + Email Queue present)');

    var cfg = configKeysExplanation_();
    out.push('  ' + (cfg && cfg.length > 0 ? '✓' : '✗') + ' configKeysExplanation_ returned ' + cfg.split('\n').length + ' line(s)');

    var manualRows = buildInstructionManual();
    out.push('  ' + (manualRows === sectionCount ? '✓' : '✗') + ' buildInstructionManual wrote ' + manualRows + ' section rows');

    var regCount = buildManualSetupRegistry();
    out.push('  ' + (regCount >= 10 ? '✓' : '✗') + ' buildManualSetupRegistry wrote/verified ' + regCount + ' steps (expected >= 10)');

    // Idempotency: a second build must not duplicate steps.
    var regCount2 = buildManualSetupRegistry();
    out.push('  ' + (regCount2 === regCount ? '✓' : '✗') + ' Manual Setup Registry idempotent (still ' + regCount2 + ' steps)');

  } catch (e) {
    out.push('  ✗ FATAL: ' + (e && e.message ? e.message : e) + (e && e.stack ? '\n    ' + e.stack : ''));
  }
  out.push('[INSTRUCTION_MANUAL] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
