/**
 * 22_Menu.gs
 * Frank's European Service — Recruiting OS
 *
 * Custom spreadsheet menu — gives the manager one-click access to every
 * workflow action in the Recruiting OS. Organized into three tiers:
 *
 *   TOP LEVEL   — daily-use actions the manager touches every morning
 *   SUBMENUS    — grouped manual triggers and operational controls
 *   Admin & Setup — all setup, repair, backfill, and dev/test tools
 *
 * Installed automatically when the spreadsheet opens (simple onOpen
 * trigger — no installation required).
 */

function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🛠 Recruiting OS')

      // ── START HERE ─────────────────────────────────────────────────────────
      // The one button to press anytime: syncs everything + shows your day.
      .addItem('⭐ Catch Me Up & Show My Day',              'catchMeUp')
      .addItem('👤 Process Selected Candidate Now',         'processSelectedCandidateRow')
      // One-click repair: sync the live sheet to the code (columns, config,
      // templates, triggers), backfill scores, recover wrongful auto-rejects,
      // and clean up. Safe to re-run; re-run until no steps are deferred.
      .addItem('🚑 Fix Everything Now (repair + backfill)', 'FIX_runEverything')
      .addItem('🩹 Apply All Audit Fixes (turnkey repair)',  'FIX_applyAllAuditFixes')
      .addItem('✅ Verify Everything (run all self-tests)',  'VERIFY_runAllSelfTests')
      .addSeparator()

      // ── DAILY ACTIONS ──────────────────────────────────────────────────────
      .addItem('🚀 Send Me Everything Now',                 'sendMeEverythingNow')
      .addItem('📬 Send Daily Digest Now',                  'DIGEST_sendNow')
      .addItem('📋 Generate & Send Upcoming Worksheets',    'generateAndSendUpcomingWorksheets')
      .addSeparator()

      // ── RUN MANUALLY ───────────────────────────────────────────────────────
      // These run on automatic triggers (every 15–30 min or daily) but can be
      // triggered on demand when you need results immediately.
      .addSubMenu(ui.createMenu('▶ Run Manually')
        .addItem('Process New Otter Transcripts',          'processRawOtterIntake')
        .addItem('Import Transcripts from Gmail/Drive',    'importTranscriptsFromSources')
        .addItem('Grade Pending Transcripts',              'gradePendingTranscripts')
        .addItem('Poll Calendar for New Bookings',         'pollCalendarBookings')
        .addItem('Recompute All Recommendations',          'updateRecommendationEngineForAll')
        .addItem('Run Deterministic Risk Review',          'runDeterministicRiskReview')
        .addItem('Generate Job Postings',                  'writeJobPostings')
        .addSeparator()
        .addItem('Retry Failed AI Grades',                 'retryFailedAiGrades')
      )

      // ── CANDIDATE ACTIONS ──────────────────────────────────────────────────
      .addSubMenu(ui.createMenu('👤 Candidate Actions')
        .addItem('Send "We Are Reviewing" to Pending Candidates', 'sendReviewingEmailToPendingCandidates')
        .addSeparator()
        .addItem('Import Hiring Email Leads',              'importHiringEmailLeads')
        .addItem('Process Hiring Email Leads',             'processHiringEmailLeads')
      )

      // ── ROLE ASSESSMENTS ───────────────────────────────────────────────────
      .addSubMenu(ui.createMenu('🧪 Role Assessments')
        .addItem('Run Role Assessment (Candidate)',        'menuRunAssessmentForCandidate')
        .addItem('Refresh Assessment Framework Seeds',     'seedAssessmentFramework_')
      )

      // ── EMAIL QUEUE ────────────────────────────────────────────────────────
      .addSubMenu(ui.createMenu('✉ Email Queue')
        .addItem('Flush Queue Now',                        'flushEmailQueue')
        .addItem('Recover Blocked Email Queue',            'recoverBlockedEmailQueue')
        .addItem('View Recent Errors',                     'viewRecentErrors')
      )

      // ── MODE ───────────────────────────────────────────────────────────────
      .addSubMenu(ui.createMenu('⚙ Mode & Status')
        .addItem('Current Mode / Status',                  'GO_LIVE_currentMode')
        .addItem('GO LIVE (real emails)',                  'goLive')
        .addItem('Return to TEST Mode',                    'returnToTestMode')
        .addSeparator()
        .addItem('Enable Hiring Pause (not hiring)',       'enableHiringPauseMode')
        .addItem('Disable Hiring Pause (resume)',          'disableHiringPauseMode')
      )

      .addSeparator()

      // ── ADMIN & SETUP ──────────────────────────────────────────────────────
      // One-time setup, repairs, backfills, and developer tools.
      // Everything the system needs to run is in here — all manual triggers
      // are preserved so you can run any part of the OS on demand.
      .addSubMenu(ui.createMenu('🔧 Admin & Setup')

        // Health & diagnostics
        .addItem('Audit System Data (Config + tabs)',       'auditSystemData')
        .addItem('Run Health Check',                        'runHealthCheck')
        .addItem('Production Readiness Check',             'productionReadinessCheck')
        .addItem('Smoke Test (all)',                        'smokeTest')
        .addItem('Email Queue Self-Test (dry run)',         'QUEUE_selfTest')
        .addItem('Send ONE Test Email',                    'QUEUE_selfTestSendOne')
        .addItem('Ping Gemini',                            'SCORING_pingGemini')
        .addItem('Test AI JSON Contract',                  'testAiJsonContract')
        .addItem('Audit Form Response Headers',            'auditFormResponseHeaders')
        .addItem('Manual Status Override',                 'manualOverride')
        .addSeparator()

        // Module self-tests (read-only / dry-run)
        .addItem('Job Postings Self-Test',                 'JOBPOSTINGS_selfTest')
        .addItem('Override Log Self-Test',                 'OVERRIDE_selfTest')
        .addItem('Deterministic Backstop Self-Test',       'DETERMINISTIC_RISK_selfTest')
        .addItem('Transcript Sources Self-Test',           'TRANSCRIPT_SOURCES_selfTest')
        .addItem('Assessment Engine Self-Test',            'ASSESSMENT_selfTest')
        .addSeparator()

        // System setup & maintenance
        .addItem('Bootstrap / Repair System',              'bootstrapSystem')
        .addItem('Seed All Templates',                     'seedAllTemplates')
        .addItem('Rebuild Instruction Manual',             'buildInstructionManual')
        .addItem('Rebuild Manual Setup Registry',          'buildManualSetupRegistry')
        .addItem('Rebuild GM Quick-Start (GM Daily tab)',  'buildGmQuickStart')
        .addItem('Install / Refresh Email Templates',      'installAllEmailTemplates')
        .addItem('Install / Refresh AI Prompts',           'installAllAiPrompts')
        .addItem('Verify Form Registry',                   'verifyFormRegistry')
        .addItem('Install All Triggers',                   'installAllTriggers')
        .addItem('Audit Triggers',                         'auditTriggers')
        .addItem('Prune Log Sheets',                       'pruneLogs')
        .addItem('Install Otter Summary Prompt',           'installOtterSummaryPrompt')
        .addItem('Print Otter Template (to copy)',         'printOtterSummaryTemplate')
        .addSeparator()

        // Backfill & repair (idempotent — safe to re-run)
        .addItem('Run Full Backfill Repair',               'runFullBackfillRepair')
        .addItem('Audit Wrongly Auto-Rejected (read-only)','SCORING_auditAutoRejects')
        .addItem('Recover Wrongly Auto-Rejected',          'SCORING_recoverAutoRejects')
        .addItem('Backfill Missing Candidate Scores',      'backfillMissingCandidateScores')
        .addItem('Backfill Missing AI Grades',             'backfillMissingAiGrades')
        .addItem('Backfill Missing Resume Grades',         'backfillResumeGrades')
        .addItem('Backfill Missing Recommendations',       'backfillMissingRecommendations')
        .addItem('Normalize Roles',                        'runRoleNormalizationRepair')
        .addItem('Import Pre-Screen Transcripts',          'BACKFILL_importPrescreenTranscripts')
        .addItem('Tidy Pipeline (hide legacy cols)',       'tidyInterviewPipelineColumns')
        .addItem('Apply Clean GM Pipeline View',           'applyGmPipelineView')
        .addItem('Show All Pipeline Columns (undo tidy)',  'showInterviewPipelineColumns')
        .addItem('Diagnose Upcoming Worksheets (why 0?)',  'WORKSHEET_diagnoseUpcoming')
        .addItem('Preview Worksheet Duplicate Cleanup',    'previewDedupeInterviewWorksheets')
        .addItem('Remove Duplicate Worksheets',            'dedupeInterviewWorksheets')
        .addItem('Preview Candidate Duplicate Merge',      'previewPipelineDedup')
        .addItem('Merge Duplicate Candidates',             'dedupePipelineCandidates')
        .addItem('Run Maintenance Now (dedup + purge)',    'autoMaintenance')
        .addSeparator()
        .addItem('Preview Bulk Archive Backlog',           'previewBulkArchiveBacklog')
        .addItem('Bulk Archive Backlog (execute)',         'bulkArchiveBacklog')
        .addSeparator()
        // Pipeline cleanup — move closed candidates off the live pipeline.
        .addItem('Preview Pipeline Cleanup (move closed out)', 'previewPipelineSweep')
        .addItem('Clean Up Pipeline Now (move closed out)',    'sweepInterviewPipeline')
        .addItem('Restore Selected Archived Candidate',        'restoreSelectedArchivedCandidate')
      )

      .addToUi();
  } catch (e) {
    // Simple onOpen has limited permissions in some contexts — ignore
    Logger.log('onOpen menu install failed: ' + e);
  }
}

/**
 * One button: send the daily digest + worksheets for every interview in the
 * next WORKSHEET_LOOKAHEAD_DAYS days. Safe to run any time. Idempotent.
 * Already-sent worksheets are skipped; the digest dedup gate handles repeats.
 */
function sendMeEverythingNow() {
  safeRun_('sendMeEverythingNow', function () {
    DIGEST_sendNow();
    generateAndSendUpcomingWorksheets();
    toast_('Digest + upcoming worksheets sent — check your inbox.', 'Recruiting OS', 10);
  });
}

/**
 * One-click combined: generate today's worksheets then immediately email them.
 * Idempotent — safe to run multiple times on the same day.
 */
function generateAndSendWorksheetsForToday() {
  return safeRun_('generateAndSendWorksheetsForToday', function () {
    var gen  = generateWorksheetsForToday();
    var sent = sendTodayInterviewWorksheets();
    var msg  = gen + ' | ' + sent;
    toast_('Worksheets: ' + msg, 'Recruiting OS', 8);
    return msg;
  });
}
