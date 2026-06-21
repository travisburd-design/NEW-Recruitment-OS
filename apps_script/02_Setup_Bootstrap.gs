/**
 * 02_Setup_Bootstrap.gs
 * Frank's European Service — Recruiting OS
 *
 * Idempotent, self-healing setup. Run bootstrapSystem() at any time.
 * It will:
 *   1) Create the Setup Registry first (so every action below is auditable).
 *   2) Create the Config sheet if missing; seed any missing default keys
 *      (NEVER overwrites existing values).
 *   3) Create / repair every other canonical sheet with its header set.
 *      Existing sheets get missing headers APPENDED to the right. No
 *      existing column is ever deleted, reordered, or renamed.
 *   4) Auto-rename safe legacy tab names to canonical (e.g. drift-tagged
 *      Config tab → "Config"). Only renames when the canonical name is unused.
 *      Conflicts are logged for manual review.
 *   5) Apply data validations on dropdown columns (Manager Decision, Active).
 *   6) Verify form-linked response tabs exist; if not, log the link step
 *      to Setup Registry rather than auto-creating (Google Forms owns those).
 *   7) Write a summary audit row.
 *
 * Hard rules:
 *   - No candidate row is ever read or written here.
 *   - No email is ever sent here.
 *   - Existing data is never destroyed.
 *
 * Functions exposed:
 *   bootstrapSystem()       — full setup / repair
 *   repairSystem()          — alias to bootstrapSystem (per project rules)
 *   BOOTSTRAP_selfTest()    — light read-only check
 */

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY TAB ALIASES — bootstrap will rename to canonical if canonical unused
// ─────────────────────────────────────────────────────────────────────────────
var SHEET_ALIASES = Object.freeze({
  'Config': [
    'Config [WITH DRIFT ONLY USE FOR REFERENCE]'
  ],
  'All Candidates': [
    'All Candidates That Have Applied To Job Post'
  ],
  'Interview Pipeline': [
    'Interview Pipeline Candidates That Applied'
  ]
});

// Tabs that exist in legacy projects but should be left in place as archive.
// Bootstrap will only log them; user can delete manually when ready.
var SHEET_ARCHIVE_TAGS = Object.freeze([
  'OLD Config',
  'Pre_Screen_Responses_and_Headers'
]);

// ─────────────────────────────────────────────────────────────────────────────
// SHEET MANIFEST — single source of truth for every canonical tab.
// Order matters: Setup Registry first, Config second, then everything else.
// ─────────────────────────────────────────────────────────────────────────────
var SHEET_MANIFEST = [
  // ── 1. Setup Registry (must be created first so we can log everything else)
  {
    name: SHEETS.SETUP_REGISTRY,
    headers: ['Timestamp', 'Item', 'Category', 'Status', 'Auto-Created', 'Action Required', 'Notes']
  },

  // ── 2. Config
  {
    name: SHEETS.CONFIG,
    headers: ['KEY', 'VALUE', 'Notes']
  },

  // ── 3. Configuration tables
  {
    name: SHEETS.ROLE_RULES,
    headers: [
      'Active', 'Role', 'Hiring Manager', 'Minimum Score', 'Auto Booking Minimum Score',
      'Manual Review Score Range', 'Hard Reject Score', 'Max Risk Score For Auto Booking',
      'Required Availability', 'Valid Drivers License Required', 'Background Check Required',
      'Minimum Experience Years', 'Pay Range', 'Phone Screen Booking Link',
      'Full Interview Booking Link', 'Culture Fit Form Link', 'Reference Form Link',
      'Auto Send Booking', 'Notes'
    ],
    validations: [
      { column: 'Active', list: ['TRUE', 'FALSE'] },
      { column: 'Auto Send Booking', list: ['TRUE', 'FALSE'] },
      { column: 'Valid Drivers License Required', list: ['TRUE', 'FALSE'] },
      { column: 'Background Check Required', list: ['TRUE', 'FALSE'] }
    ]
  },
  {
    name: SHEETS.HIRING_MANAGERS,
    headers: [
      'Active', 'Hiring Manager Name', 'Hiring Manager Email', 'Phone', 'Location',
      'Roles Owned', 'Phone Screen Booking Link', 'Full Interview Booking Link',
      'Google Calendar ID', 'Backup Manager Name', 'Backup Manager Email',
      'Signature Name', 'Notes'
    ],
    validations: [{ column: 'Active', list: ['TRUE', 'FALSE'] }]
  },
  {
    name: SHEETS.FORM_REGISTRY,
    headers: [
      'Form Key', 'Form Name', 'Active', 'Approved Form ID', 'Approved Form URL',
      'Edit ID', 'Response Tab', 'Expected Header Key', 'Last Verified', 'Notes'
    ],
    validations: [{ column: 'Active', list: ['TRUE', 'FALSE'] }]
  },
  {
    name: SHEETS.JOB_POSTINGS,
    headers: [
      'Active', 'Role', 'Platform', 'Posting Title', 'Posting Body',
      'Pre-Screen Link Config Key', 'Pre-Screen Link', 'Status', 'Last Updated',
      'Updated By', 'Notes'
    ],
    validations: [{ column: 'Active', list: ['TRUE', 'FALSE'] }]
  },
  {
    name: SHEETS.EMAIL_TEMPLATES,
    headers: ['Template Key', 'Subject', 'Body', 'Required Merge Fields', 'Notes']
  },
  {
    name: SHEETS.AI_PROMPTS,
    headers: ['Prompt Key', 'Phase', 'Provider', 'Model', 'Temperature', 'Prompt Body', 'Notes']
  },
  {
    name: SHEETS.AI_RUBRICS,
    headers: ['Rubric Key', 'Phase', 'Category', 'Weight', 'Criteria', 'Notes']
  },
  {
    name: SHEETS.ASSESSMENT_REGISTRY,
    headers: [
      'Active', 'Role', 'Assessment Section Key', 'Header Key', 'Rubric Key',
      'Culture Min', 'Skill Min', 'Overall Min', 'Auto Decline Below',
      'Manual Review Band', 'Auto Booking', 'Booking Eligible', 'Notes'
    ],
    validations: [
      { column: 'Active', list: ['TRUE', 'FALSE'] },
      { column: 'Auto Booking', list: ['TRUE', 'FALSE'] },
      { column: 'Booking Eligible', list: ['TRUE', 'FALSE'] }
    ]
  },
  // Role-based AI assessment engine tables (seeded by seedAssessmentFramework_)
  {
    name: SHEETS.ASSESSMENT_QUESTION_BANK,
    headers: ['Active', 'Section Key', 'Order', 'Question', 'Question Type',
      'Required', 'Choices', 'Scoring Weight', 'Notes'],
    validations: [
      { column: 'Active', list: ['TRUE', 'FALSE'] },
      { column: 'Required', list: ['TRUE', 'FALSE'] }
    ]
  },
  {
    name: SHEETS.ASSESSMENT_RUBRICS,
    headers: ['Active', 'Rubric Key', 'Category', 'Weight', 'Criteria', 'Pass Threshold', 'Notes'],
    validations: [{ column: 'Active', list: ['TRUE', 'FALSE'] }]
  },
  {
    name: SHEETS.ASSESSMENT_RESPONSES,
    headers: ['Timestamp', 'Candidate ID', 'Role', 'Section Key', 'Question Order', 'Question', 'Answer']
  },
  {
    name: SHEETS.AI_ASSESSMENT_RESULTS,
    headers: ['Timestamp', 'Candidate ID', 'Role', 'Section Key', 'Rubric Key',
      'Candidate Fit Score', 'Culture Fit Score', 'Role Skill Score',
      'Communication Score', 'Experience Alignment Score', 'Risk Level',
      'Recommendation', 'Strengths', 'Concerns', 'Clarification Needed',
      'Suggested Interview Questions', 'Summary For Worksheet', 'AI Model Used',
      'Decision Status', 'Decision Reason', 'Status']
  },
  {
    name: SHEETS.ASSESSMENT_AUDIT_LOG,
    headers: ['Timestamp', 'Actor', 'Candidate ID', 'Event', 'Previous Value', 'New Value', 'Reason', 'Details']
  },

  // ── 4. Candidate data (existing structures preserved; missing cols appended)
  {
    name: SHEETS.ALL_CANDIDATES,
    headers: [
      'Date Received', 'Role', 'First Name', 'Last Name', 'Email', 'Phone', 'Source',
      'Resume Link', 'Intro Sent', 'Form Sent', 'Form Completed', 'Total Score',
      'Score Tier', 'Follow-Up 1', 'Follow-Up 2', 'Status', 'Notes',
      // Canonical additions
      'Candidate ID', 'Hiring Manager', 'AI Score', 'Risk Score',
      'Engagement Score', 'Last Updated',
      // AI-authored-answer detection (added by the prescreen prompt)
      'AI-Authored Likelihood', 'AI-Authored Reasoning'
    ]
  },
  {
    name: SHEETS.INTERVIEW_PIPELINE,
    headers: [
      'Date Promoted', 'Days in Stage', 'Role', 'First Name', 'Last Name', 'Score',
      'Email', 'Phone', 'Stage', 'Phone Screen Link Sent', 'Phone Screen Booked',
      'Phone Screen Done', 'Phone Screen Outcome', 'Full Interview Link Sent',
      'Full Interview Booked', 'Full Interview Done', 'Full Interview Score',
      'Queendom Sent', 'Queendom Completed', 'Working Interview Date',
      'Final Decision', 'Decision Date', 'Notes / Next Action', 'Phone Screen Score',
      'Candidate ID', 'Full Name', 'Status', 'Hiring Manager', 'Contact Verified',
      'Engagement Score', 'Pre-Screen Score', 'Risk Score', 'Phone Score',
      'Full Score', 'Final Recommendation', 'Manager Decision', 'Next Action Due',
      'Last Updated', 'Notes',
      // Final-stage scoring (References + Culture Fit) and the leadership report
      // card. These feed the grand-total composite in 10_Recommendation.gs.
      'Culture Score', 'Reference Score', 'Reference Summary', 'Culture Summary',
      'Report Card Sent',
      // Rejection disposition reason + reference/culture deadline tracking.
      'Rejection Reason', 'Reference Deadline', 'Reference Reminder Sent'
    ],
    // Manager Decision dropdown is populated dynamically from Config DECISION_* values
    decisionDropdownColumn: 'Manager Decision'
  },

  // ── 5. Transcripts
  {
    name: SHEETS.RAW_OTTER_INTAKE,
    headers: [
      'Timestamp', 'Zap Run ID', 'Otter Source ID', 'Meeting Title', 'Meeting Date',
      'Transcript Text', 'Transcript URL', 'Audio URL', 'Participants',
      'Organizer Email', 'Calendar Event ID', 'Source App', 'Raw Payload',
      'Processed Status', 'Processed At', 'Candidate Match Status', 'Candidate ID',
      'Match Method', 'Match Confidence', 'Routing Outcome', 'Error', 'Notes'
    ],
    validations: [
      { column: 'Processed Status', list: ['NEW', 'PROCESSED', 'ERROR', 'UNMATCHED', 'SKIPPED'] },
      { column: 'Match Method', list: ['email', 'name+date', 'phone', 'booking+time', 'calendar+email', 'manual', 'none'] }
    ]
  },
  {
    name: SHEETS.TRANSCRIPT_ARCHIVE,
    headers: [
      'Archive ID', 'Archived At', 'Otter Source ID', 'Candidate ID', 'Candidate Name',
      'Role', 'Hiring Manager', 'Phase', 'Meeting Title', 'Meeting Date',
      'Transcript URL', 'Audio URL', 'Transcript Text', 'Participants',
      'Organizer Email', 'Source App', 'Match Method', 'Match Confidence', 'Modality',
      'AI Score', 'AI Risk Score', 'Summary', 'Strengths', 'Concerns',
      'Confidence Level', 'Notes'
    ]
  },
  // Pull-based Gmail/Drive transcript ingestion (34_Transcript_Sources.gs).
  // Modality routes the vendor: Otter sources = in_person, Fathom sources = online.
  {
    name: SHEETS.TRANSCRIPT_SOURCES,
    headers: ['Source Name', 'Active', 'Type', 'Modality', 'Gmail Query', 'Drive Folder ID',
      'Default Interview Type', 'Notes'],
    validations: [
      { column: 'Active', list: ['TRUE', 'FALSE'] },
      { column: 'Type', list: ['gmail', 'drive'] },
      { column: 'Modality', list: ['in_person', 'online'] }
    ]
  },
  {
    name: SHEETS.TRANSCRIPT_INBOX,
    headers: ['Staged At', 'Source Name', 'Source Type', 'Modality', 'Source ID',
      'Subject Or Filename', 'Meeting Date', 'Raw Snippet', 'Transcript Length',
      'Match Status', 'Notes', 'Reviewer', 'Action Taken']
  },
  {
    name: SHEETS.INGESTED_SOURCES_LOG,
    headers: ['Ingested At', 'Source Name', 'Source Type', 'Source ID', 'Outcome',
      'Candidate ID', 'Match Method', 'Archive Row', 'Notes']
  },
  // Time-indexed booking log (producer: pollCalendarBookings; consumer: Otter matcher)
  {
    name: SHEETS.BOOKING_EVENTS,
    headers: ['Candidate ID', 'Full Name', 'Email', 'Phone', 'Scheduled For',
      'Interview Type', 'Calendar Event ID', 'Recorded At']
  },

  // ── 6. Operational
  {
    name: SHEETS.EMAIL_QUEUE,
    headers: [
      'Queue ID', 'Created At', 'Send At', 'To (Intended)', 'To (Actual)', 'Cc', 'Bcc',
      'Subject', 'Body HTML', 'Template Key', 'Candidate ID', 'Reason', 'Status',
      'Sent At', 'Cancellable Until', 'Error', 'Notes'
    ],
    validations: [
      { column: 'Status', list: ['PENDING', 'SENT', 'CANCELLED', 'FAILED', 'BLOCKED'] }
    ]
  },
  {
    name: SHEETS.NOTIFICATION_LOG,
    headers: [
      'Timestamp', 'To', 'Cc', 'Subject', 'Template Key', 'Candidate ID',
      'Mode', 'Status', 'Message ID', 'Notes'
    ]
  },
  {
    // Durable once-only idempotency ledger — one row per (candidate, template,
    // mode). NEVER pruned (unlike the logs), so the "each email once" guarantee
    // holds for the life of the candidate. Written by 14_Email_Queue.gs.
    name: SHEETS.EMAIL_SENT_LEDGER,
    headers: [
      'Key', 'Candidate ID', 'Template Key', 'Mode',
      'First Sent At', 'Send Count', 'Last Attempt At'
    ]
  },
  {
    // Lean architecture: ONE System Log replaces Error Log + Event Log +
    // Override Log. Type distinguishes EVENT / ERROR / OVERRIDE / SKIP.
    name: SHEETS.SYSTEM_LOG,
    headers: [
      'Timestamp', 'Type', 'Severity', 'Label / Event', 'Candidate ID',
      'Function', 'Message / Details', 'Stack', 'Notes'
    ],
    validations: [
      { column: 'Type', list: ['EVENT', 'ERROR', 'OVERRIDE', 'SKIP'] },
      { column: 'Severity', list: ['INFO', 'WARN', 'ERROR', 'CRITICAL'] }
    ]
  },
  {
    name: SHEETS.TRIGGER_HEALTH,
    headers: [
      'Trigger Name', 'Function', 'Type', 'Source', 'Last Installed', 'Last Fired',
      'Last Status', 'Notes'
    ]
  },
  {
    name: SHEETS.AI_GRADING_LOGS,
    headers: [
      'Timestamp', 'Phase', 'Prompt Key', 'Candidate ID', 'Otter Source ID',
      'Input Chars', 'Model', 'Temperature', 'Output Chars', 'Parse OK',
      'AI Score', 'Risk Score', 'Duration ms', 'Error', 'Raw Preview'
    ]
  },
  {
    name: SHEETS.DAILY_DIGEST_LOG,
    headers: ['Timestamp', 'Recipient', 'Subject', 'Items Count', 'Status', 'Message ID', 'Notes']
  },
  {
    name: SHEETS.BACKFILL_REVIEW,
    headers: [
      'Timestamp', 'Source Sheet', 'Source Row', 'Candidate Hint', 'Email', 'Phone',
      'Role', 'Issue', 'Possible Matches', 'Resolution Needed', 'Resolved Candidate ID',
      'Resolved By', 'Resolved At', 'Notes'
    ]
  },
  {
    name: SHEETS.INTERVIEW_WORKSHEETS,
    headers: [
      'Timestamp', 'Candidate ID', 'Candidate Name', 'Role', 'Hiring Manager',
      'Interview Type', 'Interview Date', 'Scheduled Time', 'Candidate Status',
      'Pre-Screen Score', 'AI Pre-Screen Score', 'Risk Score', 'Transcript Score',
      'Skills Test Score', 'Reference Score', 'Culture Fit Score', 'Top Strengths',
      'Top Concerns', 'Red Flags To Verify', 'Green Flags To Confirm',
      'Suggested Questions', 'Clarification Items', 'Recommended Interview Focus',
      'AI Summary', 'Worksheet Body', 'Email Status', 'Email Sent At', 'Notes'
    ]
  },
  {
    name: SHEETS.RAW_HIRING_EMAIL_LEADS,
    headers: [
      'Timestamp', 'Source', 'Gmail Message ID', 'Thread ID', 'Received Date',
      'Subject', 'Sender', 'Candidate Name', 'Candidate Email', 'Candidate Phone',
      'Role Applied', 'Resume Link', 'Raw Snippet', 'Parsed Status', 'Candidate ID',
      'Pre-Screen Invite Status', 'Email Sent At', 'Error', 'Notes'
    ]
  },
  // Audited manual status override → now written to the unified System Log
  // (Type=OVERRIDE), so no separate Override Log tab in the lean architecture.
  // Deterministic risk/DQ backstop audit (33_Deterministic_Risk.gs)
  {
    name: SHEETS.RISK_FLAGS,
    headers: ['Timestamp', 'Candidate ID', 'Full Name', 'Role', 'Hard DQ',
      'Hard DQ Reasons', 'Deterministic Risk Score', 'High Risk', 'Risk Flags',
      'AI Risk Score', 'AI Status Before', 'Backstop Action', 'Enforced', 'Notes']
  },
  // Operator documentation tabs (32_Instruction_Manual.gs). Human-content tabs;
  // builders rebuild/preserve content, so bootstrap only ensures they exist.
  {
    name: SHEETS.MANUAL_SETUP_REGISTRY,
    headers: ['Step', 'Category', 'What To Do', 'Where / Value', 'Status', 'Notes']
  },
  {
    name: SHEETS.INSTRUCTION_MANUAL,
    headers: ['Section', 'Content']
  },

  // ── 7. Dashboard — created only if missing (preserves user's layout)
  {
    name: SHEETS.DASHBOARD,
    headers: ["FRANK'S EUROPEAN SERVICE — RECRUITING DASHBOARD"],
    isDashboard: true
  }
];

// Form-linked tabs: NEVER auto-created (Google Forms owns linkage).
// Bootstrap will only check and log if missing.
var FORM_LINKED_TABS = [
  { sheet: SHEETS.RAW_PRESCREEN,         formKey: 'PRESCREEN' },
  { sheet: SHEETS.CULTURE_FIT,           formKey: 'CULTURE_FIT' },
  { sheet: SHEETS.REFERENCE_REQUESTS,    formKey: 'REFERENCE_SUBMISSION' },
  { sheet: SHEETS.REFERENCE_CHECKS,      formKey: 'REFERENCE_CHECK' },
  { sheet: SHEETS.SKILLS_TEST_RESPONSES, formKey: 'SKILLS_TEST' }
];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

function bootstrapSystem() {
  var startedAt = new Date();
  var summary = { created: 0, repaired: 0, renamed: 0, configSeeded: 0,
                  conflicts: 0, validationsApplied: 0, formTabsMissing: 0,
                  archivesNoted: 0, errors: 0 };
  Logger.log('[BOOTSTRAP] starting at ' + startedAt.toISOString());

  return withLock_(function () {
    _clearUtilCaches_();

    // Step 1 — ensure Setup Registry exists so we can log everything else
    var reg = _ensureSetupRegistry_();
    _logSetup_(reg, 'bootstrapSystem', 'Run', 'STARTED', false, '', 'Run beginning at ' + shopDateTime_(startedAt));

    // Step 2 — handle legacy aliases (rename if safe)
    safeRun_('BOOTSTRAP_renameAliases', function () {
      _renameLegacyAliases_(reg, summary);
    });

    // Step 3 — note archive tabs (don't touch)
    safeRun_('BOOTSTRAP_archiveNotes', function () {
      _noteArchiveTabs_(reg, summary);
    });

    // Step 4 — iterate manifest in order
    SHEET_MANIFEST.forEach(function (spec) {
      safeRun_('BOOTSTRAP_sheet:' + spec.name, function () {
        _ensureManifestSheet_(spec, reg, summary);
      });
    });

    // Step 5 — seed Config defaults (after Config sheet exists)
    safeRun_('BOOTSTRAP_configSeed', function () {
      var added = _seedConfigDefaults_();
      summary.configSeeded = added;
      _logSetup_(reg, 'Config defaults', 'Config', 'SEEDED', false,
        added === 0 ? '' : 'Review newly added rows',
        added + ' missing keys added with defaults (existing values untouched)');
    });

    // Step 6 — verify form-linked response tabs (do not create)
    safeRun_('BOOTSTRAP_formTabs', function () {
      FORM_LINKED_TABS.forEach(function (ft) {
        var sh = getSheetOrNull_(ft.sheet);
        if (sh) {
          _logSetup_(reg, ft.sheet, 'Form Response Tab', 'OK', false, '',
            'Tab present (form ' + ft.formKey + ')');
        } else {
          summary.formTabsMissing++;
          _logSetup_(reg, ft.sheet, 'Form Response Tab', 'MISSING', false,
            'Open form ' + ft.formKey + ' → Responses → Link to Sheets → select this spreadsheet',
            'Auto-creation skipped — Google Forms must own linkage');
        }
      });
    });

    // Step 6b — migrate any renamed decision labels (e.g. Make Offer → Extend
    // Offer) before the dropdown is (re)applied from Config.
    safeRun_('BOOTSTRAP_migrateDecisionLabels', function () {
      var changed = _migrateDecisionLabels_();
      _logSetup_(reg, 'Decision label migration', 'Config',
        changed > 0 ? 'MIGRATED' : 'OK', false, '',
        changed > 0 ? changed + ' decision label(s) updated to new defaults'
                    : 'No legacy decision labels to migrate');
    });

    // Step 7 — apply Manager Decision dropdown on Interview Pipeline
    safeRun_('BOOTSTRAP_managerDecisionDropdown', function () {
      var n = _applyManagerDecisionDropdown_();
      if (n > 0) summary.validationsApplied += n;
      _logSetup_(reg, 'Manager Decision dropdown', 'Validation',
        n > 0 ? 'APPLIED' : 'SKIPPED', false, '',
        n > 0 ? 'Dropdown applied on ' + n + ' cells with DECISION_* values from Config'
              : 'Interview Pipeline missing or no DECISION_* values in Config');
    });

    // Step 7b — apply Rejection Reason dropdown on Interview Pipeline
    safeRun_('BOOTSTRAP_rejectionReasonDropdown', function () {
      var n = _applyRejectionReasonDropdown_();
      if (n > 0) summary.validationsApplied += n;
      _logSetup_(reg, 'Rejection Reason dropdown', 'Validation',
        n > 0 ? 'APPLIED' : 'SKIPPED', false, '',
        n > 0 ? 'Dropdown applied on ' + n + ' cells with REJECTION_REASONS from Config'
              : 'Interview Pipeline missing Rejection Reason column or no reasons in Config');
    });

    // Force Config cache to refresh — defaults may have been freshly seeded
    CFG.reset();

    var endedAt = new Date();
    var ms = endedAt - startedAt;
    _logSetup_(reg, 'bootstrapSystem', 'Run', 'COMPLETED', false, '',
      'Done in ' + ms + 'ms — ' + JSON.stringify(summary));
    toast_('Bootstrap complete (' + ms + 'ms). See Setup Registry.', 'Recruiting OS', 7);

    var msg = '[BOOTSTRAP] complete in ' + ms + 'ms — ' + JSON.stringify(summary);
    Logger.log(msg);
    return msg;
  });
}

/** Per project rules — repairSystem must exist as a callable. */
function repairSystem() {
  return bootstrapSystem();
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _ensureSetupRegistry_() {
  var spec = SHEET_MANIFEST[0];
  if (spec.name !== SHEETS.SETUP_REGISTRY) {
    throw new Error('SHEET_MANIFEST[0] must be Setup Registry. Bootstrap aborted.');
  }
  return getOrCreateSheet_(spec.name, spec.headers);
}

function _logSetup_(regSheet, item, category, status, autoCreated, actionRequired, notes) {
  try {
    appendRowByHeader_(regSheet, {
      'Timestamp':       shopDateTime_(),
      'Item':            String(item || ''),
      'Category':        String(category || ''),
      'Status':          String(status || ''),
      'Auto-Created':    autoCreated ? 'TRUE' : 'FALSE',
      'Action Required': String(actionRequired || ''),
      'Notes':           String(notes || '')
    });
  } catch (e) {
    Logger.log('_logSetup_ failed: ' + e + ' — item="' + item + '"');
  }
}

function _renameLegacyAliases_(reg, summary) {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEET_ALIASES).forEach(function (canonical) {
    var canonExists = !!ss.getSheetByName(canonical);
    SHEET_ALIASES[canonical].forEach(function (legacyName) {
      var legacy = ss.getSheetByName(legacyName);
      if (!legacy) return;
      if (canonExists) {
        summary.conflicts++;
        _logSetup_(reg, legacyName, 'Legacy Alias', 'CONFLICT', false,
          'Manual: merge "' + legacyName + '" into "' + canonical +
          '" or delete the unused one. Bootstrap will not auto-rename when both exist.',
          'Both legacy and canonical tabs present');
        return;
      }
      try {
        legacy.setName(canonical);
        summary.renamed++;
        _logSetup_(reg, legacyName, 'Legacy Alias', 'RENAMED', true, '',
          'Renamed to canonical "' + canonical + '"');
        // refresh our handle cache
        _SHEET_CACHE[canonical] = legacy;
        delete _SHEET_CACHE[legacyName];
      } catch (e) {
        summary.errors++;
        _logSetup_(reg, legacyName, 'Legacy Alias', 'ERROR', false,
          'Rename failed: ' + e.message,
          'Try renaming manually to "' + canonical + '"');
      }
    });
  });
}

function _noteArchiveTabs_(reg, summary) {
  var ss = SpreadsheetApp.getActive();
  SHEET_ARCHIVE_TAGS.forEach(function (name) {
    if (ss.getSheetByName(name)) {
      summary.archivesNoted++;
      _logSetup_(reg, name, 'Archive', 'PRESENT', false,
        'Safe to delete when you are confident nothing references it',
        'Archive tab from prior version — not touched by bootstrap');
    }
  });
}

function _ensureManifestSheet_(spec, reg, summary) {
  var existed = !!getSheetOrNull_(spec.name);
  var sh;

  if (spec.isDashboard && !existed) {
    // Dashboard stub only — do not impose layout on the user
    sh = getOrCreateSheet_(spec.name, spec.headers);
    summary.created++;
    _logSetup_(reg, spec.name, 'Dashboard', 'CREATED', true,
      'Build your dashboard layout in this tab; bootstrap will not overwrite it',
      'Empty stub created');
    return;
  }

  if (spec.isDashboard) {
    _logSetup_(reg, spec.name, 'Dashboard', 'OK', false, '',
      'Existing dashboard preserved untouched');
    return;
  }

  if (!existed) {
    sh = getOrCreateSheet_(spec.name, spec.headers);
    summary.created++;
    _logSetup_(reg, spec.name, 'Sheet', 'CREATED', true, '',
      'Created with ' + spec.headers.length + ' headers');
  } else {
    sh = getSheet_(spec.name);
    var beforeCols = sh.getLastColumn();
    ensureHeaders_(sh, spec.headers);
    var afterCols = sh.getLastColumn();
    var added = Math.max(0, afterCols - beforeCols);
    if (added > 0) summary.repaired++;
    _logSetup_(reg, spec.name, 'Sheet', added > 0 ? 'REPAIRED' : 'OK', false,
      '', added > 0 ? added + ' missing header(s) appended' : 'Schema OK');
  }

  // Validations
  if (spec.validations && spec.validations.length) {
    spec.validations.forEach(function (v) {
      var n = _applyListValidation_(sh, v.column, v.list);
      if (n > 0) summary.validationsApplied += n;
    });
  }
}

/**
 * Apply a list-only data validation rule to the entire column range
 * (excluding header). Returns number of cells covered.
 */
function _applyListValidation_(sheet, headerName, listValues) {
  var col = getColIndex_(sheet, headerName);
  if (!col) return 0;
  var lastRow = Math.max(sheet.getMaxRows(), 1000); // cover blank rows too
  var range = sheet.getRange(2, col, lastRow - 1, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(listValues, true)
    .setAllowInvalid(true)   // forgiving — humans can paste alternate text
    .setHelpText('Allowed values: ' + listValues.join(', '))
    .build();
  range.setDataValidation(rule);
  return lastRow - 1;
}

/**
 * Pull every Config key starting with DECISION_ and apply as dropdown on
 * Interview Pipeline → Manager Decision column. Returns row count covered,
 * or 0 if the column or values are missing.
 */
function _applyManagerDecisionDropdown_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!sh) return 0;
  var col = getColIndex_(sh, 'Manager Decision');
  if (!col) return 0;

  // Read Config sheet directly to collect every DECISION_* key → label.
  var cfgSheet = getSheetOrNull_(SHEETS.CONFIG);
  if (!cfgSheet) return 0;
  var rows = cfgSheet.getDataRange().getValues();
  var byKey = {};        // key → label
  var sheetOrder = [];   // keys in Config-sheet order (for any not in canonical order)
  for (var i = 1; i < rows.length; i++) {
    var k = String(rows[i][0] || '').trim();
    var v = String(rows[i][1] || '').trim();
    if (k.indexOf('DECISION_') === 0 && v) {
      if (!(k in byKey)) sheetOrder.push(k);
      byKey[k] = v;
    }
  }

  // Emit in the canonical MANAGER_DECISION_ORDER (happy path first), then append
  // any DECISION_* key not listed there so a future-added option still appears.
  var values = [];
  var seen = {};
  (typeof MANAGER_DECISION_ORDER !== 'undefined' ? MANAGER_DECISION_ORDER : []).forEach(function (k) {
    if (byKey[k] && !seen[k]) { values.push(byKey[k]); seen[k] = true; }
  });
  sheetOrder.forEach(function (k) {
    if (byKey[k] && !seen[k]) { values.push(byKey[k]); seen[k] = true; }
  });
  if (!values.length) return 0;

  return _applyListValidation_(sh, 'Manager Decision', values);
}

/**
 * Apply the "Rejection Reason" dropdown on Interview Pipeline from the
 * REJECTION_REASONS Config value (comma-separated). Returns cells covered.
 */
function _applyRejectionReasonDropdown_() {
  var sh = getSheetOrNull_(SHEETS.INTERVIEW_PIPELINE);
  if (!sh) return 0;
  if (!getColIndex_(sh, 'Rejection Reason')) return 0;
  var raw = CFG.get('REJECTION_REASONS') || '';
  var values = raw.split(',').map(function (s) { return String(s).trim(); }).filter(function (s) { return s; });
  if (!values.length) return 0;
  return _applyListValidation_(sh, 'Rejection Reason', values);
}

/**
 * One-time relabel migration: if a DECISION_* Config value still holds a known
 * OLD default, update it to the new default. Custom labels (anything not in the
 * old-default map) are left untouched. Returns the number of rows changed.
 *
 * This lets us rename dropdown options (e.g. "Make Offer" → "Extend Offer")
 * without clobbering a shop that intentionally customized the wording.
 */
function _migrateDecisionLabels_() {
  var cfgSheet = getSheetOrNull_(SHEETS.CONFIG);
  if (!cfgSheet) return 0;
  var migrations = {
    'DECISION_MAKE_OFFER': { from: 'Make Offer',    to: 'Extend Offer' },
    'DECISION_HIRED':      { from: 'Mark as Hired', to: 'Confirm Hire' }
  };
  var rows = cfgSheet.getDataRange().getValues();
  var changed = 0;
  for (var i = 1; i < rows.length; i++) {
    var key = String(rows[i][0] || '').trim();
    var m = migrations[key];
    if (m && String(rows[i][1] || '').trim() === m.from) {
      cfgSheet.getRange(i + 1, 2).setValue(m.to);
      changed++;
    }
  }
  if (changed) CFG.reset();
  return changed;
}

/**
 * Seed any CFG_DEFAULTS keys that are not yet present in the Config sheet.
 * NEVER overwrites existing values. Returns number of rows added.
 */
function _seedConfigDefaults_() {
  var sh = getSheet_(SHEETS.CONFIG);
  ensureHeaders_(sh, ['KEY', 'VALUE', 'Notes']);
  var rows = sh.getDataRange().getValues();
  var existing = {};
  for (var i = 1; i < rows.length; i++) {
    var k = String(rows[i][0] || '').trim();
    if (k) existing[k] = true;
  }

  var toAppend = [];
  Object.keys(CFG_DEFAULTS).forEach(function (key) {
    if (!existing[key]) {
      toAppend.push([key, CFG_DEFAULTS[key], '(seeded default — edit value as needed)']);
    }
  });

  if (toAppend.length) {
    var startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, toAppend.length, 3).setValues(toAppend);
  }
  return toAppend.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only sanity check. Safe to run before bootstrap.
// ─────────────────────────────────────────────────────────────────────────────
function BOOTSTRAP_selfTest() {
  var out = ['[BOOTSTRAP] selfTest starting (read-only)…'];
  out.push('  ─ Manifest size: ' + SHEET_MANIFEST.length + ' sheets');
  out.push('  ─ Form-linked tabs: ' + FORM_LINKED_TABS.length);
  out.push('  ─ Aliases watched: ' + Object.keys(SHEET_ALIASES).join(', '));

  var ss = SpreadsheetApp.getActive();
  var present = 0, missing = 0;
  SHEET_MANIFEST.forEach(function (s) {
    if (ss.getSheetByName(s.name)) present++; else missing++;
  });
  out.push('  ─ Canonical sheets present: ' + present + '/' + SHEET_MANIFEST.length +
           ' (missing: ' + missing + ')');

  var aliasFound = [];
  Object.keys(SHEET_ALIASES).forEach(function (c) {
    SHEET_ALIASES[c].forEach(function (legacy) {
      if (ss.getSheetByName(legacy)) aliasFound.push(legacy + ' → ' + c);
    });
  });
  out.push('  ─ Legacy aliases detected: ' + (aliasFound.length ? aliasFound.join(' | ') : 'none'));

  var formTabsMissing = FORM_LINKED_TABS.filter(function (ft) { return !ss.getSheetByName(ft.sheet); });
  out.push('  ─ Form-linked tabs missing: ' +
           (formTabsMissing.length ? formTabsMissing.map(function(x){return x.sheet;}).join(', ') : 'none'));

  out.push('  ─ CFG_DEFAULTS key count: ' + Object.keys(CFG_DEFAULTS).length);
  out.push('  ─ Active spreadsheet: ' + ss.getName());
  out.push('[BOOTSTRAP] selfTest done. Ready to run bootstrapSystem().');

  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
