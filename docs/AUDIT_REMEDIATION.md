# Recruiting OS — Audit Remediation (June 2026)

This document maps every finding in `docs/audit_source/Fix_Tracker.xlsx` (F1–F25)
to the exact code change that resolves it. All code lives in `apps_script/`.

**Scope chosen by Travis:** Bug fixes + de-drift (~40%) · Stay in TEST (ready to
flip LIVE) · Keep Gemini AI grading · Both Otter + Fathom into one transcript pipeline.

## The two buttons that do everything

Both are in the spreadsheet menu **🛠 Recruiting OS** (and run from the Apps
Script editor):

| Menu item | Function | What it does |
|---|---|---|
| 🩹 Apply All Audit Fixes (turnkey repair) | `FIX_applyAllAuditFixes()` | Runs bootstrap, archives Config drift tabs, installs the corrected triggers (15-min flush + heartbeat set), activates a transcript source, recovers BLOCKED email, runs the fail-loud checks, rebuilds the dashboard with the mode banner, and prints the **only** items that need you. Idempotent. |
| ✅ Verify Everything (run all self-tests) | `VERIFY_runAllSelfTests()` | Runs every subsystem self-test + wiring checks + the live health check and writes a pass/fail **Verification Report** tab. This is the "every feature tested & verified" step. |

> Run order after deploying the code: **Apply All Audit Fixes → (paste the items
> it lists for you) → Verify Everything.**

## Finding-by-finding

| ID | Severity | Fix | File(s) |
|----|----------|-----|---------|
| **F1** | Critical | TEST/LIVE **mode banner** on the Dashboard (amber in TEST: "NO candidate emails are sending"; green in LIVE). | `24_Dashboard.gs` (`_dashboardModeBanner_`) |
| **F2** | Critical | `recoverBlockedQueue_()` flips recoverable **BLOCKED→PENDING**; `_sendQueueRow_` now **recomputes the recipient at send time** (self-heals blank/drifted recipients) instead of re-blocking; BLOCKED count surfaced in the digest; auto-recovery added to daily maintenance. | `41_Audit_Fixes.gs`, `14_Email_Queue.gs`, `15_Daily_Digest.gs`, `28_Pipeline_Dedup.gs` |
| **F3** | Critical | Email-queue flush trigger changed from **once-daily → every 15 minutes** (lock-guarded + capped, safe to run often). | `18_Triggers.gs` |
| **F4** | Critical | The Risk Flags audit row is now written **inline on the live scoring path** (`applyDeterministicBackstop_` called from `scorePreScreen_`), so the tab fills for every scored candidate. | `06_Scoring_Risk.gs` |
| **F5** | Critical | `assertAiReady_()` raises a **CRITICAL** alert when AI is enabled but `GEMINI_API_KEY` is missing; the alert now sends even with sending off (see F9). | `41_Audit_Fixes.gs`, `19_Health_Check.gs` |
| **F6** | High | `ensureTranscriptSourcesSeeded_()` **activates a transcript source** (Fathom Gmail from the known query) when none are active; both Otter + Fathom feed the one pipeline. | `41_Audit_Fixes.gs` |
| **F7** | High | *Requires you* — link the Culture-Fit Google Form to this spreadsheet. The repair button reports this if the tab is missing; the health check flags it. | (manual — Google Forms owns linkage) |
| **F8** | High | When `FIX_runEverything` defers heavy steps it **auto-schedules a one-shot ~1-min trigger** (`FIX_resumeRun`) to re-run until nothing is deferred; the resume self-deletes its scheduler. | `40_Fix_Everything.gs`, `41_Audit_Fixes.gs` |
| **F9** | High | CRITICAL error-alert emails are **no longer gated by `SEND_ENABLED`** — they fire exactly when the system is most likely broken. | `17_Errors_Logs.gs` |
| **F10** | High | Each trigger handler stamps a **real Last Fired / Last Status** (`_triggerHeartbeat_`); `auditTriggers` **preserves** heartbeats and flags any **MISSING** expected trigger; the health check asserts the **full** expected set. | `41_Audit_Fixes.gs`, `18_Triggers.gs`, `19_Health_Check.gs`, all trigger handlers |
| **F11** | High | Every manager **dropdown decision is written to the Override Log** (`logOverride_` from `_dispatchPipelineDecision_`). | `16_Dropdown_Actions.gs` |
| **F12** | High | Short/SKIPPED transcripts now **log an event** and appear in a new digest section "Skipped transcripts (short / parked / failed)". | `08_Otter_Transcripts.gs`, `15_Daily_Digest.gs` |
| **F13** | High | `EMAIL_QUEUE_ENABLED` is now an **explicit Config row** (seeded by bootstrap) and honored by the flush — no hidden default. | `00_Config.gs`, `14_Email_Queue.gs` |
| **F14** | Medium | `cleanupConfigDriftTabs_()` renames `OLD Config` / `Config [WITH DRIFT…]` to `Archived — …` and **hides** them (nothing deleted) so there is one source of truth. | `41_Audit_Fixes.gs` |
| **F15** | Medium | Flag-off skips (`AUTO_BOOKING_ENABLED`, `AUTO_REJECTION_ENABLED`, `SEND_REJECTION_EMAIL`) now **log `EMAIL_SKIPPED`** with the reason. | `06_Scoring_Risk.gs` |
| **F16** | Medium | `appendRowByHeader_` now **warns (Logger) on dropped keys** so a header rename can't silently lose a column's data. | `01_Utils.gs` |
| **F17** | Medium | `DIGEST_sendNow` now **honors `actualRecipient_`** (TEST-mode rerouting). | `15_Daily_Digest.gs` |
| **F18** | Medium | The flush logs a **WARN with the remaining backlog** when it hits its per-run cap; backlog + blocked counts surfaced in the digest. | `14_Email_Queue.gs`, `15_Daily_Digest.gs`, `41_Audit_Fixes.gs` |
| **F19–F23** | High/Med | **Complexity / de-drift.** See "De-drift notes" below. Config-tab drift (F14) and duplicate role rules (existing health check) are resolved; the AI engine is already centralized and the deterministic risk engine is a deliberate *backstop*, not a duplicate. | `41_Audit_Fixes.gs`, bootstrap |
| **F24** | High | **Fail-loud:** `systemSelfAudit_()` runs daily (and is in the digest) and emails a CRITICAL when blocked email / dead triggers / missing AI key / failed grades / deferred jobs / unmatched/skipped transcripts exist. Combined with F9/F10 the system now surfaces failures instead of swallowing them. | `41_Audit_Fixes.gs`, `28_Pipeline_Dedup.gs`, `15_Daily_Digest.gs` |
| **F25** | Info | No action — empty-by-design tabs, documented. | — |

## Items only you can provide (irreducible manual input)

The repair button reports these and the health check flags them. Everything else
is automated.

1. **`GEMINI_API_KEY`** (F5) — paste into *Project Settings → Script Properties*.
   You chose to keep AI grading on. (Set `AI_GRADING_ENABLED=FALSE` in Config to
   run deterministic-only and skip this.)
2. **Link the Culture-Fit Google Form** to this spreadsheet (F7) — *Form →
   Responses → Link to Sheets → this spreadsheet*. Confirm the response tab name
   matches Form Registry.
3. **Go LIVE when ready** (F1) — *Menu → Mode & Status → GO LIVE*. Until then the
   system is intentionally muted and the dashboard banner says so. The queue
   recovery (F2) is already in place, so nothing will be stuck when you flip.
4. **(Optional) Otter via Gmail** — Otter transcripts already arrive via
   Zapier → "Raw Otter Intake" automatically. To *also* pull Otter from Gmail,
   set `OTTER_GMAIL_QUERY` in Config; the source row is pre-seeded.

## De-drift notes (F19–F23)

The audit measured the **live workbook** at ~18,700 lines with heavy drift. In
the current source:

- **AI scoring is already one engine.** All five scoring paths call the shared
  `_geminiGradeJson_` / `validatePreScreenGradeJson_` core in `06_Scoring_Risk.gs`.
- **The two "risk engines" are complementary, not duplicates.** `33_Deterministic_Risk.gs`
  is an explainable *backstop* layered alongside the AI scorer (it never rejects);
  the audit's recommendation was to keep exactly this cheap, explainable engine.
- **`23_Backfill` deliberately scores without emailing** (the no-candidate-email
  guarantee during backfill). Redirecting it straight into `scorePreScreen_`
  would change that behavior, so it was **not** blindly gutted.
- **The real drift was in the workbook data** (OLD/DRIFT Config tabs, duplicate
  role rules) — now handled by `cleanupConfigDriftTabs_()` (F14) and the existing
  role-normalization repair + health check.

**Recommended safe next step (Phase 2, against a copy of the live workbook):**
move `20_Smoke_Tests`, `32_Instruction_Manual`, `99_Export_Source`, and the
heavy repair tooling (`23_Backfill`, `28_Pipeline_Dedup`, `39_Pipeline_Cleanup`)
into a separate **Maintenance** Apps Script project, run `VERIFY_runAllSelfTests`
after each move, and consolidate the 11 log tabs. This is mechanical and
reversible but must be validated against live data with the acceptance tests —
which is why it is staged rather than done blind here.
