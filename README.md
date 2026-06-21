# Frank's European Service — Recruiting OS

Candidate prescreen, scoring, interview, and tracking automation built on Google
Apps Script, bound to the `_Frank's Recruiting OS [LIVE]` Google Sheet.

This repository is the **source of truth** for the Apps Script project. It
contains the full, repaired script set implementing the June 2026 audit.

## Layout

```
apps_script/        All .gs source files + appsscript.json (paste these into the
                    bound Apps Script project, one file per tab).
reference_data/     CSV snapshots of the workbook's config/data tabs (reference).
docs/
  AUDIT_REMEDIATION.md   F1–F25 → exact code change, + your manual-input list.
  audit_source/          The original Audit Report, Trim-Down Plan, Fix Tracker.
```

## What changed (June 2026 audit remediation)

All 24 actionable findings (F1–F18, F24) are fixed and the system is now
**fail-loud** and **turnkey**. The headline:

- The email queue **flushes every 15 minutes** and **recovers BLOCKED mail**
  automatically; recipients are recomputed at send time so nothing stays stuck.
- A **TEST/LIVE banner** on the dashboard makes the muted pre-launch state obvious.
- **Risk Flags**, **Override Log**, and skipped-transcript visibility now fill on
  the live path.
- Critical alerts **email you even when sending is off**; every trigger has a real
  **heartbeat**; a daily **self-audit** surfaces the real risk surface on your
  morning digest.

Full detail and the per-finding mapping: **[docs/AUDIT_REMEDIATION.md](docs/AUDIT_REMEDIATION.md)**.

## Deploy / re-deploy

1. Open the bound spreadsheet → **Extensions → Apps Script**.
2. Replace each file's contents with the matching file from `apps_script/`
   (or use `clasp push` if you have clasp configured against the project).
3. Back in the spreadsheet, reload it so the **🛠 Recruiting OS** menu appears.
4. Menu → **🩹 Apply All Audit Fixes** (turnkey repair — idempotent).
5. Do the short list of items it prints for you (see below).
6. Menu → **✅ Verify Everything** — read the **Verification Report** tab.

## The only things that need you

(Everything else is automated. The repair button and health check both flag these.)

1. **Paste `GEMINI_API_KEY`** — Project Settings → Script Properties. *(Or set
   `AI_GRADING_ENABLED=FALSE` in Config to run deterministic-only.)*
2. **Link the Culture-Fit Google Form** to this spreadsheet — Form → Responses →
   Link to Sheets.
3. **Go LIVE when ready** — Menu → Mode & Status → GO LIVE. (The system ships in
   TEST mode; all email reroutes to you until you flip it.)

## Safety model (unchanged, and now enforced)

No candidate-facing email can leave unless `SYSTEM_MODE=LIVE` **and**
`SEND_ENABLED=TRUE`. In TEST mode every candidate address is rerouted to
`TEST_RECIPIENT_EMAIL`. Every send goes through the queue, the once-only ledger,
and the recompute-at-send recipient gate.
