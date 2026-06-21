# Lean OS Re-Architecture — Spec & Migration Runbook

**Goal:** the spreadsheet a competent architect would have built on day one — lean,
zoned, one-source-of-truth, manager-touches-one-tab, fail-loud. Built on a **copy**
of the live workbook, verified green, then swapped in. The live system keeps
running untouched until you flip the binding.

Decisions locked: **Full re-architecture · build on a copy, then swap.**

---

## 1. Target architecture — ~22 tabs in 5 colored zones

| Zone (tab color) | Tabs | Notes |
|---|---|---|
| 🟩 **Manager** (green) | `Interview Pipeline`, `Dashboard` | The only tabs the manager opens. Pipeline gets an OS-filled `Next Action` column. |
| 🟦 **Inputs** (blue) | `Form Responses 1–5` (Pre-Screen, Culture, References Provided, Reference Checks, Skills Test), `Transcript Intake`, `Raw Hiring Email Leads` | Forms/feeds write here; never hand-edited. `Transcript Intake` = today's `Raw Otter Transcript Intake` + `Transcript Inbox` + `Ingested Sources Log` merged. |
| 🟨 **Data** (yellow) | `All Candidates`, `Pipeline Archive`, `Master Transcript Archive` | Record of truth. `All Candidates` absorbs the per-role candidate tabs. |
| 🟧 **Config** (orange) | `Config`, `Role Rules`, `Hiring Managers`, `Email Templates`, `AI Prompt Templates`, `Form Registry`, `Job Postings`, `Assessment Setup` | The OS knobs. `Assessment Setup` merges `Assessment Registry` + `Assessment Question Bank` + `Assessment Rubrics` + `AI Grading Rubrics`. |
| ⬜ **System** (grey) | `Email Queue`, `Email Log`, `System Log`, `Trigger Health`, `Risk Flags`, `AI Grading Logs` | Plumbing. Logs collapsed from 11 → 6 (2 merged logs + 4 structured/operational kept on purpose). |

Form-response tab **names stay** `Form Responses 1–5` (Google Forms owns the link;
renaming risks breaking it). They are zoned/colored instead.

## 2. Log consolidation (11 → 6)

| Old tabs | New home |
|---|---|
| `Event Log` + `Error Log` + `Override Log` + `Daily Digest Log` + `Setup Registry` + `Assessment Audit Log` + `Backfill Review Queue` skips | **`System Log`** — one chronological log with `Type` + `Severity` columns |
| `Notification Log` + `Email Sent Ledger` | **`Email Log`** — sends + once-only ledger (ledger rows flagged `LEDGER`) |
| `Trigger Health` | kept (live heartbeat — the F10 fix) |
| `Risk Flags` | kept (structured misrepresentation audit the manager actually reads) |
| `AI Grading Logs` | kept (structured AI debug; low volume) |
| `Ingested Sources Log` + `Transcript Inbox` + `Raw Otter Transcript Intake` | merged into **`Transcript Intake`** |

## 3. Deleted outright (no code reads them — verified by reference scan)

`Scoring Rubric`, `Pre_Screen_Responses_and_Headers`, `OLD Config`,
`Config [WITH DRIFT ONLY USE FOR REFERENCE]`, `CX Candidates`,
`Service Advisor Candidates`, `Technician Candidates` (data merged into
`All Candidates` first), `Manual Setup Registry`, `Instruction Manual`,
legacy aliases (`All Candidates That Have Applied…`, `Interview Pipeline
Candidates That Applied`).

## 4. Scaffolding → separate Maintenance project

`23_Backfill`, `28_Pipeline_Dedup`, `39_Pipeline_Cleanup`, `40_Fix_Everything`,
`20_Smoke_Tests`, `32_Instruction_Manual`, `99_Export_Source` move to a separate
**"Recruiting OS — Maintenance"** Apps Script project. They stay runnable on
demand but are out of the live runtime. (Staged — see §6.)

## 5. Evidence base (why this is "what's used")

Code reference counts per tab (higher = more central):

```
Interview Pipeline 62 · All Candidates 52 · Email Queue 18 · Config 13 ·
Interview Worksheets 13 · Pipeline Archive 12 · Raw Hiring Email Leads 12 ·
AI Prompts 12 · Raw Otter Intake 11 · Raw Prescreen 11 · Transcript Archive 10 ·
Role Rules 10 · Form Registry 9 · ... · (orphans with 0 code refs deleted)
```

The orphan tabs in the live workbook (`Scoring Rubric`,
`Pre_Screen_Responses_and_Headers`, per-role candidate tabs) have **zero** code
references — they are pure drift.

## 6. Migration runbook (on a COPY, then swap)

**Phase A — code (this PR):**
1. `00_Config.gs` — `SHEET_MANIFEST` reduced to the lean set; `SHEET_ZONES`
   added (tab → color); new `SHEETS.SYSTEM_LOG` / `SHEETS.EMAIL_LOG`.
2. `17_Errors_Logs.gs` — `logEvent_`/`logError_` write to `System Log`
   (signatures unchanged, so no caller changes).
3. `31_Override.gs` — `logOverride_` writes to `System Log` (`Type=OVERRIDE`).
4. `14_Email_Queue.gs` — `_logNotification_` + ledger write to `Email Log`.
5. `42_Lean_Migration.gs` — the migration engine (below).

**Phase B — run on the copy:**
1. Duplicate the live workbook (File → Make a copy). Copy the bound Apps Script
   too (or use `clasp` against the copy's script).
2. Paste this branch's code into the copy's script project.
3. Run `LEAN_migratePreview()` → read the report (changes nothing).
4. Run `LEAN_migrateExecute()` → renames/zones tabs, merges per-role candidates,
   merges old log rows into `System Log`/`Email Log`/`Transcript Intake`, archives
   drift tabs (hidden, not deleted, until you confirm).
5. Run `VERIFY_runAllSelfTests()` → must be green.
6. Run `LEAN_deleteArchivedDrift()` only after you've confirmed the copy is good.

**Phase C — swap:**
- Point your forms/links at the copy, or (simpler) once verified, treat the copy
  as the new live workbook and rename the old one `[RETIRED]`.

Nothing is deleted on the live workbook by this process — the copy is where all
work happens, and even there drift tabs are hidden before they're deleted.
