/**
 * 00_Config.gs
 * Frank's European Service — Recruiting OS
 * Single source of truth for: sheet names, enums, Config-sheet reads/writes,
 * mode safety (TEST/LIVE), email recipient routing, quiet hours, and
 * Script-Property secret access.
 *
 * Build rules honored:
 *  - Config sheet IS the operating system.
 *  - No candidate-facing email can leave unless SYSTEM_MODE=LIVE AND SEND_ENABLED=TRUE.
 *  - In TEST mode all candidate-facing email is rewritten to TEST_RECIPIENT_EMAIL.
 *  - Secrets never live in the spreadsheet. They live in PropertiesService.
 *  - This file has zero dependencies on other .gs files. Safe to paste first.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHEET NAMES (canonical — must match tab names exactly)
// ─────────────────────────────────────────────────────────────────────────────
var SHEETS = Object.freeze({
  // Configuration
  CONFIG:                 'Config',
  ROLE_RULES:             'Role Rules',
  HIRING_MANAGERS:        'Hiring Managers',
  FORM_REGISTRY:          'Form Registry',
  JOB_POSTINGS:           'Job Postings',
  EMAIL_TEMPLATES:        'Email Templates',
  AI_PROMPTS:             'AI Prompt Templates',
  AI_RUBRICS:             'AI Grading Rubrics',
  ASSESSMENT_REGISTRY:    'Assessment Registry',

  // Role-based AI assessment engine (35_Assessments.gs)
  ASSESSMENT_QUESTION_BANK: 'Assessment Question Bank',
  ASSESSMENT_RUBRICS:       'Assessment Rubrics',
  ASSESSMENT_RESPONSES:     'Assessment Responses',
  AI_ASSESSMENT_RESULTS:    'AI Assessment Results',
  ASSESSMENT_AUDIT_LOG:     'Assessment Audit Log',

  // Candidate data
  ALL_CANDIDATES:         'All Candidates',
  INTERVIEW_PIPELINE:     'Interview Pipeline',
  PIPELINE_ARCHIVE:       'Pipeline Archive',   // closed candidates swept off the live pipeline

  // Form responses (linked — must match Form Registry "Response Tab" column AND the actual
  // tab where each Google Form writes its responses). Verified by Travis 2026-05-25.
  CULTURE_FIT:            'Form Responses 1',   // CULTURE_FIT form
  REFERENCE_REQUESTS:     'Form Responses 2',   // REFERENCE_SUBMISSION form (candidate-listing-refs)
  REFERENCE_CHECKS:       'Form Responses 3',   // REFERENCE_CHECK form (referee-fills-out)
  SKILLS_TEST_RESPONSES:  'Form Responses 4',   // SKILLS_TEST form (Technician skill level test)
  RAW_PRESCREEN:          'Form Responses 5',   // PRESCREEN form (the entry point of all automation)

  // Transcripts (Zapier Otter intake + pull-based Gmail/Drive sources)
  RAW_OTTER_INTAKE:       'Raw Otter Transcript Intake',
  TRANSCRIPT_ARCHIVE:     'Master Transcript Archive',
  TRANSCRIPT_SOURCES:     'Transcript Sources',
  TRANSCRIPT_INBOX:       'Transcript Inbox',
  INGESTED_SOURCES_LOG:   'Ingested Sources Log',

  // Booking / interviews
  BOOKING_EVENTS:         'Booking Events',

  // Operations
  EMAIL_QUEUE:            'Email Queue',
  NOTIFICATION_LOG:       'Notification Log',
  EMAIL_SENT_LEDGER:      'Email Sent Ledger',
  ERROR_LOG:              'Error Log',
  EVENT_LOG:              'Event Log',
  TRIGGER_HEALTH:         'Trigger Health',
  AI_GRADING_LOGS:        'AI Grading Logs',
  SETUP_REGISTRY:         'Setup Registry',
  DAILY_DIGEST_LOG:       'Daily Digest Log',
  BACKFILL_REVIEW:        'Backfill Review Queue',
  INTERVIEW_WORKSHEETS:   'Interview Worksheets',
  RAW_HIRING_EMAIL_LEADS: 'Raw Hiring Email Leads',
  OVERRIDE_LOG:           'Override Log',
  RISK_FLAGS:             'Risk Flags',

  // Documentation / setup
  INSTRUCTION_MANUAL:     'Instruction Manual',
  MANUAL_SETUP_REGISTRY:  'Manual Setup Registry',

  // Dashboard
  DASHBOARD:              'Dashboard'
});

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────
// Canonical unified role for CX / Valet / Porter / Driver (one role, not four).
var ROLE_CANONICAL_CX_VALET = 'CX / Valet Porter Driver';

var ROLES = Object.freeze([
  'Service Advisor', 'Technician', 'Lube Tech', ROLE_CANONICAL_CX_VALET,
  'Parts', 'Admin', 'Shop Foreman'
]);

// Candidate status values written by Apps Script (never typed by humans).
var STATUS = Object.freeze({
  NEW:                  'NEW',
  PRESCREEN_SENT:       'PRESCREEN_SENT',
  PRESCREEN_RECEIVED:   'PRESCREEN_RECEIVED',
  SCORED:               'SCORED',
  AUTO_BOOK_SENT:       'AUTO_BOOK_SENT',
  PHONE_BOOKED:         'PHONE_BOOKED',
  PHONE_DONE:           'PHONE_DONE',
  FULL_BOOKED:          'FULL_BOOKED',
  FULL_DONE:            'FULL_DONE',
  WORKING_SCHEDULED:    'WORKING_SCHEDULED',
  REFS_REQUESTED:       'REFS_REQUESTED',
  REFS_PENDING:         'REFS_PENDING',
  REFS_COMPLETE:        'REFS_COMPLETE',
  RECOMMENDED:          'RECOMMENDED',
  OFFER_PENDING:        'OFFER_PENDING',
  HIRED:                'HIRED',
  MANUAL_REVIEW:        'MANUAL_REVIEW',
  IN_DRAWER:            'IN_DRAWER',
  REJECTED:             'REJECTED',
  ARCHIVED:             'ARCHIVED'
});

// Hiring-manager dropdown values. Source of truth is Config DECISION_* keys.
// This enum is for code paths that reference dropdown values without
// hitting the Config sheet on every check.
var DECISION = Object.freeze({
  ADVANCE_PHONE:   'DECISION_ADVANCE_PHONE',
  ADVANCE_LIVE:    'DECISION_ADVANCE_LIVE',
  ADVANCE_WORKING: 'DECISION_ADVANCE_WORKING',
  REQUEST_REFS:    'DECISION_REQUEST_REFERENCES',
  MAKE_OFFER:      'DECISION_MAKE_OFFER',
  NEEDS_INFO:      'DECISION_NEEDS_INFO',
  PUT_IN_DRAWER:   'DECISION_PUT_IN_DRAWER',
  REJECT:          'DECISION_REJECT',
  ARCHIVE:         'DECISION_ARCHIVE',
  REOPEN:          'DECISION_REOPEN',
  HIRED:           'DECISION_HIRED'
});

// The exact order the Manager Decision dropdown should present its options,
// grouped by the candidate journey so the manager's eye lands on the happy path
// first. _applyManagerDecisionDropdown_ (02_Setup_Bootstrap.gs) emits values in
// THIS order — independent of how DECISION_* rows happen to sit in the Config
// sheet — then appends any DECISION_* key not listed here (forward-compat).
//
//   Group 1 — the 3 core decision points (the only choices on the happy path):
//             Advance to Live → Request References → Confirm Hire / Put in Drawer
//   Group 2 — alternate or manual advance actions
//   Group 3 — exceptions & admin
var MANAGER_DECISION_ORDER = Object.freeze([
  // Group 1 — core happy-path decisions, in journey order
  'DECISION_ADVANCE_LIVE',
  'DECISION_REQUEST_REFERENCES',
  'DECISION_HIRED',
  'DECISION_PUT_IN_DRAWER',
  // Group 2 — alternate / manual advance actions
  'DECISION_ADVANCE_PHONE',
  'DECISION_ADVANCE_WORKING',
  'DECISION_MAKE_OFFER',
  // Group 3 — exceptions & admin
  'DECISION_NEEDS_INFO',
  'DECISION_REJECT',
  'DECISION_REOPEN',
  'DECISION_ARCHIVE'
]);

// Transcript match outcomes (written to Raw Otter Intake col R "Match Method")
var MATCH_METHOD = Object.freeze({
  EMAIL:        'email',
  NAME_DATE:    'name+date',
  PHONE:        'phone',
  BOOKING_TIME: 'booking+time',
  MANUAL:       'manual',
  NONE:         'none'
});

// Script Property keys (secrets — never go into Config sheet)
var SECRETS = Object.freeze({
  GEMINI_API_KEY:        'GEMINI_API_KEY',
  FATHOM_API_KEY:        'FATHOM_API_KEY',         // legacy — safe to leave unset
  FATHOM_WEBHOOK_SECRET: 'FATHOM_WEBHOOK_SECRET'   // legacy — safe to leave unset
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG DEFAULTS — bootstrap writes any of these that are missing from
// the Config sheet. Existing values are NEVER overwritten by bootstrap.
// ─────────────────────────────────────────────────────────────────────────────
var CFG_DEFAULTS = Object.freeze({
  // Resume AI grading (weed out unqualified applicants up front)
  RESUME_AI_GRADING_ENABLED:            'TRUE',
  RESUME_MIN_SCORE:                     '50',
  RESUME_BACKFILL_MAX_PER_RUN:          '25',

  // Self-maintenance (unattended daily housekeeping via autoMaintenance trigger)
  AUTO_MAINTENANCE_ENABLED:             'TRUE',
  AUTO_DEDUP_ENABLED:                   'TRUE',
  PURGE_STALE_SHELL_DAYS:               '30',
  EMAIL_QUEUE_RETENTION_DAYS:           '30',
  // Pipeline cleanup: sweep closed candidates (Rejected / Archived / In Drawer)
  // off the Interview Pipeline tab into the Pipeline Archive tab so the pipeline
  // only ever shows new candidates awaiting a decision + those being evaluated.
  PIPELINE_SWEEP_ENABLED:               'TRUE',
  // When TRUE, a just-rejected / just-drawered candidate stays on the pipeline
  // (so the manager's "Reopen Candidate" dropdown still works) until their
  // cancellable decline/hold email has actually gone out. Archived candidates
  // (terminal, no email) are always swept immediately.
  PIPELINE_SWEEP_RESPECT_CANCELLABLE:   'TRUE',

  // Mode & safety
  SYSTEM_MODE:                          'TEST',
  HIRING_PAUSE_MODE:                    'FALSE',
  SEND_ENABLED:                         'TRUE',
  TEST_RECIPIENT_EMAIL:                 'travis.burd@frankseuropeanservice.com',
  QUIET_HOURS_ENABLED:                  'TRUE',
  QUIET_HOURS_START:                    '7',
  QUIET_HOURS_END:                      '21',
  QUIET_HOURS_OVERRIDE:                 'FALSE',
  ERROR_ALERT_RECIPIENTS:               'travis.burd@frankseuropeanservice.com',

  // Identity
  SHOP_NAME:                            "Frank's European Service",
  SHOP_TAGLINE:                         "Las Vegas's Premier Independent European Auto Specialist",
  SHOP_MISSION:                         "We exist to help people make informed decisions about their vehicles through honesty, integrity, quality workmanship, and exceptional communication.",
  SHOP_CUSTOMER_PROMISE:                "Every repair recommendation we make is designed to help customers feel confident, informed, and cared for.",
  SHOP_WHY_WE_HIRE:                     "We hire carefully because every person on our team directly impacts the customer experience.",
  SHOP_TEAM_MESSAGE:                    "We believe great people deserve great teammates, clear expectations, strong leadership, and the tools needed to succeed.",
  SHOP_CULTURE_LINE:                    'We are a quality-first shop where every technician, advisor, and team member is respected and given the tools they need to succeed.',
  SHOP_PERKS_LINE:                      'Competitive pay, specialty work on premier European vehicles, a professional team environment, and a shop culture built on honesty, integrity, and quality.',
  SHOP_SPECIALTIES:                     'BMW, Mercedes-Benz, Audi, Porsche, Land Rover, Volvo, MINI, and all European brands',
  SHOP_WEBSITE:                         'https://www.frankseuropeanservice.com',
  SHOP_CITY_STATE:                      'Las Vegas, NV',
  SHOP_TIMEZONE:                        'America/Los_Angeles',
  TIMEZONE:                             'America/Los_Angeles',
  COMPANY_NAME:                         "Frank's European Service",
  COMPANY_SHORT_NAME:                   "Frank's",
  COMPANY_ADDRESS:                      '1931 N Rainbow Blvd | Las Vegas, NV | 89108',
  COMPANY_PHONE:                        '702-365-9100',
  COMPANY_SIGNATURE_NAME:               "Frank's Recruiting Team",
  EMAIL_FROM_NAME:                      "Travis Burd — Frank's European Service",
  DEFAULT_REPLY_TO_EMAIL:               'travis.burd@frankseuropeanservice.com',
  INCLUDE_SHOP_BRANDING_IN_EMAILS:      'TRUE',

  // Hiring manager
  HIRING_MANAGER_NAME:                  'Travis Burd',
  HIRING_MANAGER_EMAIL:                 'travis.burd@frankseuropeanservice.com',
  HIRING_MANAGER_TITLE:                 'General Manager',
  DIGEST_RECIPIENT_EMAIL:               'travis.burd@frankseuropeanservice.com',

  // AI
  AI_PROVIDER:                          'gemini',
  GEMINI_MODEL:                         'gemini-2.5-flash',
  AI_GRADING_ENABLED:                   'TRUE',
  AI_GRADING_LOGGING_ENABLED:           'TRUE',
  AI_GRADING_TEMPERATURE:               '0.2',
  AI_GRADING_MAX_OUTPUT_TOKENS:         '2048',
  AI_REQUIRE_JSON_OUTPUT:               'TRUE',
  AI_FAIL_CLOSED_ON_PARSE_ERROR:        'FALSE',
  TRANSCRIPT_MIN_CHARACTERS_FOR_AI:     '200',
  // Interview grading input: 'transcript' (raw) or 'summary' (Otter structured
  // summary). Summary mode grades the structured recap and uses a lower floor.
  AI_INTERVIEW_INPUT_MODE:              'transcript',
  AI_SUMMARY_MIN_CHARACTERS:            '80',
  // Flag pre-screens whose AI-Authored Likelihood meets/exceeds this threshold.
  AI_AUTHORED_LIKELIHOOD_THRESHOLD:     '70',

  // Score thresholds
  AUTO_BOOK_SCORE_THRESHOLD:            '60',
  BELOW_MIN_SCORE_THRESHOLD:            '40',
  HARD_REJECT_SCORE_THRESHOLD:          '20',
  PRIORITY_CANDIDATE_THRESHOLD:         '80',
  SCORE_THRESHOLD_INVITE:               '75',
  MIN_PRESCREEN_SCORE:                  '60',
  MAX_RISK_SCORE_AUTOBOOK:              '2',
  DIAMOND_IN_ROUGH_ENABLED:             'TRUE',

  // Decision dropdown values (the labels manager sees in the dropdown).
  // Listed in MANAGER_DECISION_ORDER so a fresh Config sheet reads happy-path
  // first; the dropdown itself is rendered in that order regardless of row order.
  // Group 1 — the 3 core decision points (happy path, journey order)
  DECISION_ADVANCE_LIVE:                'Advance to Live Interview',
  DECISION_REQUEST_REFERENCES:          'Request References',
  DECISION_HIRED:                       'Confirm Hire',
  DECISION_PUT_IN_DRAWER:               'Put in the Drawer',
  // Group 2 — alternate / manual advance actions
  DECISION_ADVANCE_PHONE:               'Send Phone Screen Booking',
  DECISION_ADVANCE_WORKING:             'Send Working Interview',
  DECISION_MAKE_OFFER:                  'Extend Offer',
  // Group 3 — exceptions & admin
  DECISION_NEEDS_INFO:                  'Needs More Info',
  DECISION_REJECT:                      'Reject',
  DECISION_REOPEN:                      'Reopen Candidate',
  DECISION_ARCHIVE:                     'Archive — No Email',

  // Rejection disposition reasons (ATS best practice). When the manager picks
  // "Reject", the "Rejection Reason" dropdown on Interview Pipeline captures why —
  // for compliance and future re-engagement. Optional; blank still rejects.
  REJECTION_REASONS:                    'Skills / experience gap,Compensation mismatch,Availability / schedule,Culture fit concern,Hired another candidate,Failed reference / background,Candidate withdrew,Other',

  // Email behavior
  // F13: every control flag the code reads is an explicit Config row — sending
  // and major subsystems never run on an invisible code default.
  EMAIL_QUEUE_ENABLED:                  'TRUE',
  EMAIL_DUPE_TEMPLATE_WINDOW_DAYS:      '7',
  // Once-only guarantee: each candidate receives a given email template AT MOST
  // ONCE, ever, per send mode (TEST/LIVE are tracked separately so test sends
  // never consume a real candidate's single LIVE send). Backed by the durable
  // "Email Sent Ledger" tab (never pruned). Set FALSE to fall back to the
  // rolling EMAIL_DUPE_TEMPLATE_WINDOW_DAYS window. To intentionally re-send,
  // run clearEmailLedgerForCandidate(candidateId).
  EMAIL_DEDUPE_TEMPLATE_LIFETIME:       'TRUE',
  // Templates that may legitimately be sent more than once (and so are EXEMPT
  // from the once-only guarantee): per-interview worksheets, per-booking
  // confirmations, etc. Internal manager-alert templates (keys starting with
  // "__") are always treated as repeatable. Comma-separated template keys.
  EMAIL_REPEATABLE_TEMPLATES:           'interview_worksheet_dayof,phone_screen_confirmation',
  AUTO_BOOKING_ENABLED:                 'TRUE',
  AUTO_REJECTION_ENABLED:               'TRUE',
  SEND_ACKNOWLEDGMENT_EMAIL:            'TRUE',
  SEND_BELOW_MIN_EMAIL:                 'TRUE',
  SEND_REJECTION_EMAIL:                 'TRUE',
  REJECTION_EMAIL_DELAY_DAYS:           '5',
  REJECTION_EMAIL_CANCELLABLE:          'TRUE',
  DRAWER_EMAIL_DELAY_DAYS:              '14',
  KEEP_DOOR_OPEN_MONTHS:                '6',
  OFFER_PREP_ALERT_ENABLED:             'TRUE',
  OFFER_CANDIDATE_EMAIL_ENABLED:        'TRUE',

  // References + Culture Fit (post-live-interview stage)
  // When the manager picks "Request References", the candidate gets ONE email
  // containing BOTH the reference-submission form and the culture-fit form, with
  // a single deadline (default 72h from send). Set _COMBINED_ to FALSE to fall
  // back to two separate emails (reference_request_candidate + culture_fit_invite).
  REFERENCE_CULTURE_COMBINED_EMAIL_ENABLED: 'TRUE',
  REFERENCE_CULTURE_DEADLINE_HOURS:         '72',
  // One gentle nudge if the candidate hasn't submitted references/culture as the
  // deadline approaches, then optionally auto-park to the drawer once the
  // deadline + grace passes with no response. Checked daily by autoMaintenance.
  REFERENCE_REMINDER_ENABLED:               'TRUE',
  REFERENCE_REMINDER_HOURS_BEFORE:          '24',
  REFERENCE_AUTO_PARK_ON_NO_RESPONSE:       'TRUE',
  REFERENCE_NO_RESPONSE_GRACE_HOURS:        '24',
  // Final report card emailed to leadership once BOTH the AI-graded culture-fit
  // responses and the AI-graded reference responses are in.
  CANDIDATE_REPORT_CARD_ENABLED:            'TRUE',
  LEADERSHIP_REPORT_RECIPIENTS:             'travis.burd@frankseuropeanservice.com',
  SEND_REVIEWING_EMAIL_ON_MANUAL_REVIEW:'TRUE',
  OFFER_EXPECTED_TURNAROUND_DAYS:       '2',
  CANDIDATE_RESPONSE_SLA_DAYS:          '2',
  EMAIL_QUEUE_FLUSH_HOUR:               '7',
  IMMEDIATE_BOOKING_ALERTS_ENABLED:     'TRUE',
  HIRED_CONGRATULATIONS_EMAIL_ENABLED:  'TRUE',
  HIRED_MANAGER_CHECKLIST_ENABLED:      'TRUE',

  // Booking & interview defaults
  DEFAULT_PHONE_BOOKING_LINK:           'https://koalendar.com/e/candidate-phone-screen-2',
  DEFAULT_FULL_BOOKING_LINK:            'https://koalendar.com/e/fes-full-interview',
  LIVE_INTERVIEW_BOOKING_URL:           'https://koalendar.com/e/fes-full-interview',
  LIVE_INTERVIEW_LOCATION:              '1931 N Rainbow Blvd | Las Vegas, NV | 89108',
  LIVE_INTERVIEW_WHAT_TO_EXPECT:        'Plan for approximately 45-60 minutes. You will meet with our General Manager and tour the shop.',
  INTERVIEW_LOCATION:                   "Frank's European Service",
  PHONE_SCREEN_DURATION:                '20',
  WORKING_INTERVIEW_DURATION_HOURS:     '4',
  WORKING_INTERVIEW_SCHEDULER_URL:      'https://koalendar.com/e/fes-working-interview',
  WORKING_INTERVIEW_PAY_STATEMENT:      'Paid at your current rate for hours worked',
  WORKING_INTERVIEW_WHAT_TO_BRING:      'Your own hand tools. We will provide lifts, specialty tools, and equipment.',

  // Calendar
  RECRUITING_CALENDAR_NAME:             'Frank Recruiting Interviews',
  INTERVIEW_BLOCK_EVENT_PREFIX:         '[Recruiting Available]',
  INTERVIEW_BLOCK_LOOKAHEAD_DAYS:       '21',
  INTERVIEW_BLOCK_SKIP_IF_CONFLICT:     'TRUE',
  AUTO_CREATE_MISSING_CALENDAR:         'FALSE',

  // Folders
  AUTO_CREATE_MISSING_FOLDERS:          'TRUE',
  AUTO_CREATE_MISSING_FORMS:            'FALSE',

  // Daily digest — sent twice a day (morning brief + afternoon wrap-up)
  DAILY_DIGEST_ENABLED:                 'TRUE',
  DAILY_DIGEST_TIME:                    '15:30',  // legacy single-send time (kept for back-compat)
  DAILY_DIGEST_AM_HOUR:                 '7',       // morning brief hour (0-23)
  DAILY_DIGEST_PM_HOUR:                 '16',      // afternoon wrap-up hour (0-23)

  // Interview worksheets
  INTERVIEW_WORKSHEETS_ENABLED:         'TRUE',
  WORKSHEET_EMAIL_HOUR:                 '7',
  WORKSHEET_LOOKAHEAD_DAYS:             '7',

  // Hiring email lead import (Indeed / ACT Auto Staffing)
  HIRING_GMAIL_LEAD_IMPORT_ENABLED:     'TRUE',
  INDEED_GMAIL_QUERY:                   'from:(indeed.com OR indeedemail.com) newer_than:14d',
  ACT_AUTO_STAFFING_GMAIL_QUERY:        'from:(actautostaffing.com) newer_than:14d',
  HIRING_EMAIL_IMPORT_LOOKBACK_DAYS:    '14',
  PRESCREEN_INVITE_FOR_IMPORTED_LEADS_ENABLED: 'TRUE',
  PRESCREEN_FORM_URL:                   'https://docs.google.com/forms/d/e/1FAIpQLSfU21ujxpQHLAIJjEJD0r1lmkgWoy5oQV7l8t2ZQf6RFvgNKA/viewform',

  // Engagement, transcripts, pipeline housekeeping
  ENGAGEMENT_SCORING_ENABLED:           'TRUE',
  ENGAGEMENT_FAST_RESPONSE_HOURS:       '24',
  PRESCREEN_STALE_DAYS:                 '3',
  STUCK_CANDIDATE_DAYS:                 '5',
  REQUIRE_CONTACT_VERIFIED_FOR_BOOKING: 'FALSE',
  REFERENCE_CHECK_ENABLED:              'TRUE',
  MANUAL_SETUP_REGISTRY_ENABLED:        'TRUE',

  // Skills test
  TECH_SKILL_TEST_MIN_SCORE:            '60',
  TECH_SKILL_TEST_DEADLINE_DAYS:        '3',
  SEND_TECH_SKILL_FOLLOWUP:             'TRUE',

  // Otter intake (Zapier primary; Gmail/Drive sources added below)
  OTTER_IMPORT_ENABLED:                 'TRUE',
  TRANSCRIPT_PROCESSED_GMAIL_LABEL:     'recruiting-transcript-processed', // retained for any leftover label cleanup
  // In-person/live transcript matching: max hours between an Otter recording's
  // meeting time and a Booking Events "Scheduled For" for a proximity match.
  OTTER_MATCH_WINDOW_HOURS:             '4',

  // Gmail/Drive transcript ingestion (34_Transcript_Sources.gs). The Transcript
  // Sources sheet is the per-source source of truth; these are convenience seeds.
  TRANSCRIPT_SOURCES_IMPORT_ENABLED:    'TRUE',
  TRANSCRIPT_SOURCES_MAX_PER_RUN:       '25',
  FATHOM_GMAIL_QUERY:                   'from:(fathom.video) newer_than:14d',
  OTTER_GMAIL_QUERY:                    '',
  FATHOM_TRANSCRIPT_FOLDER_ID:          '',
  OTTER_TRANSCRIPT_FOLDER_ID:           '',

  // Transcript modality routing: Otter = in-person interviews ONLY; Fathom =
  // online meetings ONLY. Online meetings are identity-gated so that unrelated
  // online calls are never ingested + graded against a candidate.
  ENFORCE_TRANSCRIPT_MODALITY:          'TRUE',   // park vendor↔modality conflicts
  OTTER_MODALITY:                       'in_person',
  FATHOM_MODALITY:                      'online',
  ONLINE_REQUIRE_CANDIDATE_MATCH:       'TRUE',   // skip online meetings with no candidate identity
  ONLINE_MATCH_MIN_CONFIDENCE:          '90',     // identity-grade floor for online ingest
  OTTER_SENDER_DOMAINS:                 'otter.ai',
  FATHOM_SENDER_DOMAINS:                'fathom.video',

  // Deterministic (non-LLM) hard-DQ + risk backstop (33_Deterministic_Risk.gs).
  // Advisory by default: logs + writes the Risk Flags audit sheet. Set ENFORCE
  // to TRUE only to let it downgrade to MANUAL_REVIEW — it NEVER auto-rejects.
  DETERMINISTIC_BACKSTOP_ENABLED:       'TRUE',
  DETERMINISTIC_BACKSTOP_ENFORCE:       'FALSE',
  DETERMINISTIC_RISK_BLOCK_THRESHOLD:   '5',

  // Role-based AI assessment engine (35_Assessments.gs). Fail-closed: by default
  // the AI only logs a recommended decision; a human holds final authority.
  ASSESSMENT_AI_ENABLED:                'TRUE',
  ASSESSMENT_FAIL_CLOSED:               'TRUE',
  ASSESSMENT_AUTO_DECISION_ENABLED:     'FALSE',
  // Auto-run the role assessment right after pre-screen scoring (for candidates
  // that are not hard-rejected). Populates Assessment Responses / AI Assessment
  // Results / Assessment Audit Log. Decision is still log-only unless
  // ASSESSMENT_AUTO_DECISION_ENABLED=TRUE, so this only scores, never rejects.
  ASSESSMENT_AUTO_RUN_ENABLED:          'TRUE',
  ASSESSMENT_GENERATE_WORKSHEET_AUTO:   'TRUE',
  ASSESSMENT_PROMPT_KEY:                'role_assessment',
  ASSESSMENT_COMPOSITE_WEIGHT:          '0.10'
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — read/write/cache
// All Config-sheet access goes through this object. Per-execution cache
// prevents repeated sheet reads inside one function call.
// ─────────────────────────────────────────────────────────────────────────────
var CFG = (function () {
  var _cache = null; // { KEY: 'value' }

  function _load() {
    if (_cache) return _cache;
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(SHEETS.CONFIG);
    if (!sh) {
      // Don't throw — return empty so CFG.get(key, default) still works.
      // Bootstrap will create the sheet on next run.
      _cache = {};
      return _cache;
    }
    var rng = sh.getDataRange().getValues(); // row 0 = header
    var map = {};
    for (var i = 1; i < rng.length; i++) {
      var k = String(rng[i][0] || '').trim();
      if (!k) continue;
      map[k] = (rng[i][1] === null || rng[i][1] === undefined) ? '' : String(rng[i][1]);
    }
    _cache = map;
    return _cache;
  }

  function get(key, dflt) {
    var m = _load();
    if (key in m && m[key] !== '') return m[key];
    if (dflt !== undefined) return dflt;
    if (key in CFG_DEFAULTS) return CFG_DEFAULTS[key];
    return '';
  }

  // Read raw with respect for explicit defaults.
  // IMPORTANT: only forward `dflt` to get() if caller actually supplied one,
  // otherwise get() will treat '' as an explicit default and skip CFG_DEFAULTS.
  function _readRaw(key, dflt) {
    return (dflt === undefined) ? get(key) : get(key, dflt);
  }

  function getBool(key, dflt) {
    var v = String(_readRaw(key, dflt)).trim().toUpperCase();
    return v === 'TRUE' || v === 'YES' || v === '1';
  }

  function getInt(key, dflt) {
    var v = parseInt(String(_readRaw(key, dflt)).replace(/[^\-0-9]/g, ''), 10);
    return isNaN(v) ? (typeof dflt === 'number' ? dflt : 0) : v;
  }

  function getFloat(key, dflt) {
    var v = parseFloat(String(_readRaw(key, dflt)).replace(/[^\-0-9.]/g, ''));
    return isNaN(v) ? (typeof dflt === 'number' ? dflt : 0) : v;
  }

  // Comma-separated list. Trims, drops blanks, dedupes.
  function getList(key, dflt) {
    var raw = String(_readRaw(key, dflt));
    var out = [];
    var seen = {};
    raw.split(/[,\n]/).forEach(function (s) {
      var t = s.trim();
      if (t && !seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out;
  }

  function has(key) {
    var m = _load();
    return key in m && m[key] !== '';
  }

  // Write through to the sheet AND update cache. Creates row if key new.
  function set(key, value) {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(SHEETS.CONFIG);
    if (!sh) throw new Error('CFG.set: Config sheet missing. Run bootstrapSystem() first.');
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        sh.getRange(i + 1, 2).setValue(value);
        if (_cache) _cache[key] = String(value);
        return;
      }
    }
    // Append new
    sh.appendRow([key, value, '']);
    if (_cache) _cache[key] = String(value);
  }

  // Force re-read on next get(). Call after bulk setup.
  function reset() { _cache = null; }

  return {
    get: get, getBool: getBool, getInt: getInt, getFloat: getFloat,
    getList: getList, has: has, set: set, reset: reset,
    // Expose defaults for bootstrap seeding
    DEFAULTS: CFG_DEFAULTS
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// MODE & SAFETY — the only legal way to decide whether an email may send.
// ─────────────────────────────────────────────────────────────────────────────
function isLiveMode_() {
  return String(CFG.get('SYSTEM_MODE')).trim().toUpperCase() === 'LIVE';
}
function isTestMode_() { return !isLiveMode_(); }

function sendEnabled_() {
  return CFG.getBool('SEND_ENABLED');
}

/**
 * Single chokepoint for candidate-facing email routing.
 * Returns the address that should actually receive the email.
 *   - TEST mode  → always TEST_RECIPIENT_EMAIL (overrides intended)
 *   - LIVE mode + SEND_ENABLED=TRUE → intended
 *   - SEND_ENABLED=FALSE → '' (caller must NOT send; queue or drop)
 */
function actualRecipient_(intendedEmail) {
  if (!sendEnabled_()) return '';
  if (isLiveMode_()) return String(intendedEmail || '').trim();
  // TEST mode: always reroute
  var test = String(CFG.get('TEST_RECIPIENT_EMAIL')).trim();
  return test || String(CFG.get('DEFAULT_REPLY_TO_EMAIL')).trim();
}

/**
 * True if shop-local time is OUTSIDE quiet window. Use to decide whether
 * to send-now vs. enqueue for next morning flush.
 */
function isQuietHoursNow_() {
  if (!CFG.getBool('QUIET_HOURS_ENABLED')) return false;
  if (CFG.getBool('QUIET_HOURS_OVERRIDE')) return false;
  var start = CFG.getInt('QUIET_HOURS_START', 7);
  var end   = CFG.getInt('QUIET_HOURS_END',  21);
  var tz    = CFG.get('SHOP_TIMEZONE', 'America/Los_Angeles');
  var h = parseInt(Utilities.formatDate(new Date(), tz, 'H'), 10);
  // Quiet when h < start OR h >= end
  return (h < start) || (h >= end);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECRETS — Script Properties only. Never log the value.
// ─────────────────────────────────────────────────────────────────────────────
function getSecret_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? String(v) : '';
}

function setSecret_(key, value) {
  if (!key) throw new Error('setSecret_: key required');
  PropertiesService.getScriptProperties().setProperty(key, String(value || ''));
}

function hasSecret_(key) {
  return !!PropertiesService.getScriptProperties().getProperty(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — run this from the editor right after pasting this file.
// It validates Config sheet readability without writing anything.
// ─────────────────────────────────────────────────────────────────────────────
function CFG_selfTest() {
  var out = [];
  out.push('[CFG] selfTest starting…');
  var ss;
  try {
    ss = SpreadsheetApp.getActive();
    out.push('  ✓ Active spreadsheet: ' + ss.getName());
  } catch (e) {
    out.push('  ✗ No active spreadsheet bound. Open this script from the spreadsheet, not standalone.');
    Logger.log(out.join('\n'));
    return out.join('\n');
  }

  var sh = ss.getSheetByName(SHEETS.CONFIG);
  if (!sh) {
    out.push('  ⚠ Config sheet missing — defaults will be used until bootstrapSystem() runs.');
  } else {
    var rows = sh.getLastRow();
    out.push('  ✓ Config sheet present, ' + (rows - 1) + ' key rows');
  }

  out.push('  ─ SYSTEM_MODE          : ' + CFG.get('SYSTEM_MODE'));
  out.push('  ─ SEND_ENABLED         : ' + CFG.getBool('SEND_ENABLED'));
  out.push('  ─ TEST_RECIPIENT_EMAIL : ' + CFG.get('TEST_RECIPIENT_EMAIL'));
  out.push('  ─ HIRING_MANAGER_EMAIL : ' + CFG.get('HIRING_MANAGER_EMAIL'));
  out.push('  ─ AUTO_BOOK threshold  : ' + CFG.getInt('AUTO_BOOK_SCORE_THRESHOLD'));
  out.push('  ─ QUIET_HOURS now?     : ' + isQuietHoursNow_());
  out.push('  ─ GEMINI_API_KEY set?  : ' + hasSecret_(SECRETS.GEMINI_API_KEY));
  out.push('  ─ actualRecipient_(  ' +
           '"someone@example.com") → "' + actualRecipient_('someone@example.com') + '"');

  // Critical safety assertion: in TEST mode, no real candidate address may leak.
  if (isTestMode_()) {
    var probe = actualRecipient_('REAL_CANDIDATE@gmail.com');
    if (probe.toLowerCase() === 'real_candidate@gmail.com') {
      out.push('  ✗ SAFETY FAIL: TEST mode is leaking real recipient addresses!');
    } else {
      out.push('  ✓ SAFETY OK: TEST mode reroutes candidate addresses to ' + probe);
    }
  }

  out.push('[CFG] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
