/**
 * 03_Seed_Templates.gs
 * Frank's European Service — Recruiting OS
 *
 * Seeds the seven canonical content tabs with the rows captured from the
 * existing system audit:
 *   - Email Templates           (16 rows)
 *   - AI Prompt Templates       (5 rows)
 *   - AI Grading Rubrics        (29 rows — composite key Rubric+Category)
 *   - Role Rules                (8 rows)
 *   - Hiring Managers           (1 row)
 *   - Form Registry             (5 rows)
 *   - Assessment Registry       (8 rows)
 *
 * Hard rules (same as Config seeding):
 *   - NEVER overwrites an existing row with the same primary key.
 *   - NEVER deletes or reorders existing rows.
 *   - Idempotent — running twice produces zero new rows the second time.
 *   - Throws nothing on a per-row skip; logs a row in Setup Registry.
 *
 * Functions exposed:
 *   seedAllTemplates()      — runs all seven seeders
 *   SEED_selfTest()         — read-only summary of what each sheet currently has
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEED DATA — captured verbatim from the prior tracker for fidelity.
// Edit these in the spreadsheet, not here. Re-running seed will not overwrite.
// ─────────────────────────────────────────────────────────────────────────────

var SEED_EMAIL_TEMPLATES = [
  {
    'Template Key': 'application_confirmation',
    'Subject':      'Your {{RoleName}} application — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Your application for the {{RoleName}} role is in. A real person on our team will review it — usually within {{SLADays}} business days.\n\n' +
'A bit about who we are while you wait:\n\n' +
'{{ShopMission}}\n\n' +
'We specialize in {{ShopSpecialties}} and we take that work seriously. {{ShopWhyWeHire}}\n\n' +
'Take a look at {{ShopWebsite}} if you want to learn more before we connect.\n\n' +
'Talk soon,\n{{CompanySignatureName}}\n{{CompanyAddress}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,ShopMission,ShopSpecialties,ShopWhyWeHire,ShopWebsite,SLADays,CompanySignatureName,CompanyAddress,CompanyPhone',
    'Notes': 'First touchpoint — establishes mission, sets expectations, builds trust before first interaction.'
  },
  {
    'Template Key': 'prescreen_invite',
    'Subject':      'Next step for {{RoleName}} at {{ShopName}} — 5-minute pre-screen',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Thanks for your interest in the {{RoleName}} role at {{ShopName}}. To move your application forward, please take about 5 minutes to complete this short pre-screen:\n\n' +
'{{PrescreenFormLink}}\n\n' +
'Why we ask first: {{ShopWhyWeHire}} The pre-screen helps both of us — it gives us context on your experience, schedule, and goals so we can have a real conversation rather than a generic one. And it gives you a chance to tell us what you are actually looking for, not just what your resume says.\n\n' +
'{{ShopTeamMessage}}\n\n' +
'Once you submit, our team will review it and reach back out with the next step.\n\n' +
'Looking forward to hearing from you,\n{{CompanySignatureName}}\n{{ShopName}} · {{ShopWebsite}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,PrescreenFormLink,ShopWhyWeHire,ShopTeamMessage,CompanySignatureName,ShopWebsite',
    'Notes': 'Most important first message — explains the why behind the process, not just the ask.'
  },
  {
    'Template Key': 'phone_screen_booking',
    'Subject':      'Let\'s talk about the {{RoleName}} role — pick a time',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Based on your pre-screen, we would like to set up a short phone call with {{HiringManagerName}} for the {{RoleName}} role.\n\n' +
'Pick a time here:\n{{BookingLink}}\n\n' +
'What to expect: 15–20 minutes. We want to hear about you as a person — where you have been, what you are looking for, how you work, and what matters to you in a workplace. We will also answer any questions you have about the role, the team, and what day-to-day actually looks like here.\n\n' +
'No tricks. No pressure. Just a real conversation.\n\n' +
'{{ShopCustomerPromise}} The team behind that promise is who you would be joining — and that context matters when you are deciding where to work next.\n\n' +
'Looking forward to talking,\n{{HiringManagerName}}\n{{HiringManagerTitle}} · {{ShopName}}\n{{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,BookingLink,HiringManagerName,HiringManagerTitle,ShopName,ShopCustomerPromise,CompanyPhone',
    'Notes': 'Candidate as a whole person, not just qualifications. Connects the role to the customer mission.'
  },
  {
    'Template Key': 'phone_screen_confirmation',
    'Subject':      'Phone screen confirmed — {{InterviewDate}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'You are confirmed for {{InterviewDate}} with {{HiringManagerName}}.\n\n' +
'Meeting link: {{MeetLink}}\n\n' +
'A few things that help: find a quiet spot, give yourself a few minutes on either side, and come with questions. This call goes both directions — we want you to leave knowing whether this is a place you genuinely want to work.\n\n' +
'Need to reschedule? Just reply and we will take care of it.\n\n' +
'Talk soon,\n{{HiringManagerName}}\n{{ShopName}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,InterviewDate,MeetLink,HiringManagerName,ShopName,CompanyPhone',
    'Notes': ''
  },
  {
    'Template Key': 'full_interview_booking',
    'Subject':      'Next step — in-person interview at {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'We enjoyed our conversation and would like to invite you in for a full interview.\n\n' +
'Pick a time:\n{{FullInterviewLink}}\n\n' +
'Where: {{InterviewLocation}}\nPlan for 45–60 minutes. You will meet {{HiringManagerName}}, walk the shop, and see the work firsthand — {{ShopSpecialties}}.\n\n' +
'One thing worth saying plainly: {{ShopWhyWeHire}} This visit is as much about you evaluating us as it is about us evaluating you. Come with questions about the work, the team, the culture, the expectations, and what we offer in return. Long-term fit matters more to us than filling a seat quickly — and we want you making this decision with clear information.\n\n' +
'Looking forward to having you in,\n{{HiringManagerName}}\n{{ShopName}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,FullInterviewLink,InterviewLocation,HiringManagerName,ShopName,ShopSpecialties,ShopWhyWeHire,CompanyPhone',
    'Notes': 'Mutual evaluation framing. Long-term fit over speed.'
  },
  {
    'Template Key': 'reference_request_candidate',
    'Subject':      'A quick ask — references for your {{RoleName}} application',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'You are progressing well in our process for the {{RoleName}} role. The next step is references.\n\n' +
'Please share up to 3 — a former manager and two coworkers is ideal — using this form:\n{{CandRefFormLink}}\n\n' +
'We keep these conversations short and respectful, typically 5–10 minutes each. We always tell your references upfront that this is a standard step, not a sign of concern.\n\n' +
'{{ShopWhyWeHire}} References are one part of how we make sure the fit is real for both sides.\n\n' +
'Thanks for trusting us with this part of the process,\n{{HiringManagerName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,CandRefFormLink,HiringManagerName,ShopName,ShopWhyWeHire',
    'Notes': ''
  },
  {
    'Template Key': 'reference_check_reference',
    'Subject':      'Reference request from {{ShopName}} — {{CandidateName}}',
    'Body':
'Hi {{ReferenceName}},\n\n' +
'{{CandidateName}} is being considered for the {{RoleName}} role at {{ShopName}} and listed you as a reference. We would appreciate 5–10 minutes of your honest perspective.\n\n' +
'Please complete this short form:\n{{RefCheckFormLink}}\n\n' +
'About us: {{ShopMission}} We are an independent European auto shop in {{ShopCityState}} and we hold ourselves to a high standard — which is exactly why we check references carefully. Your candid feedback helps us hire well, both for {{CandidateName}} and for the teammates they would be working alongside.\n\n' +
'Thank you for taking the time,\n{{CompanySignatureName}}\n{{ShopName}} · {{ShopWebsite}}',
    'Required Merge Fields': 'ReferenceName,CandidateName,RoleName,RefCheckFormLink,CompanySignatureName,ShopName,ShopCityState,ShopMission,ShopWebsite',
    'Notes': ''
  },
  {
    'Template Key': 'culture_fit_invite',
    'Subject':      'One more step before the final decision — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'You are close. Before we wrap up, we ask every finalist to complete a short culture fit assessment:\n\n' +
'{{CultureFormLink}}\n\n' +
'Why this matters: {{ShopCustomerPromise}} Every person on our team either reinforces or undermines that promise in their day-to-day interactions — with customers, with teammates, and with us. {{ShopWhyWeHire}}\n\n' +
'The questions are straightforward — about how you handle accountability, how you work with others, what you expect from leadership, and what you bring to a team. Answer honestly. We are not looking for the right answers. We are looking for the real ones.\n\n' +
'{{ShopTeamMessage}}\n\n' +
'Thanks for the time,\n{{HiringManagerName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,CultureFormLink,HiringManagerName,ShopName,ShopCustomerPromise,ShopWhyWeHire,ShopTeamMessage',
    'Notes': 'Connects culture assessment to customer experience, not just internal fit. NOTE: by default this is sent COMBINED with the reference ask via reference_and_culture_invite — this standalone template is the fallback when REFERENCE_CULTURE_COMBINED_EMAIL_ENABLED=FALSE.'
  },
  {
    'Template Key': 'reference_and_culture_invite',
    'Subject':      'Two quick steps for your {{RoleName}} application — due {{ResponseDeadline}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Your live interview went well and you are now in the final stage of our process for the {{RoleName}} role. There are just two short steps left, and you can knock both out in about 15 minutes.\n\n' +
'Please complete BOTH of the following by {{ResponseDeadline}} (within the next 48–72 hours):\n\n' +
'1) References — share up to 3 (a former manager and two coworkers is ideal):\n   {{CandRefFormLink}}\n\n' +
'2) Culture Fit assessment — a few honest questions about how you work:\n   {{CultureFormLink}}\n\n' +
'A little context so neither step feels like a black box:\n\n' +
'• On references: we keep these conversations short and respectful, typically 5–10 minutes each, and we always tell your references upfront that this is a standard step, not a sign of concern. {{ShopWhyWeHire}}\n\n' +
'• On the culture fit: {{ShopCustomerPromise}} The questions are about accountability, how you work with others, and what you expect from leadership. Answer honestly — we are not looking for the right answers, we are looking for the real ones.\n\n' +
'Completing both by {{ResponseDeadline}} keeps your application moving without delay. As soon as we have them, we make our final decision quickly — no long waits at the finish line.\n\n' +
'{{ShopTeamMessage}}\n\n' +
'Thanks for trusting us with this part of the process,\n{{HiringManagerName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,CandRefFormLink,CultureFormLink,ResponseDeadline,HiringManagerName,ShopName,ShopWhyWeHire,ShopCustomerPromise,ShopTeamMessage',
    'Notes': 'COMBINED references + culture-fit ask sent when the manager picks "Request References". One email, both forms, one 48–72h deadline. Sent by 16_Dropdown_Actions.gs _dispatchRequestReferences_.'
  },
  {
    'Template Key': 'reference_culture_reminder',
    'Subject':      'Friendly reminder — 2 quick steps for your {{RoleName}} application (due {{ResponseDeadline}})',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Just a quick, friendly nudge — we have not seen your two final steps come through yet, and the window closes {{ResponseDeadline}}.\n\n' +
'It only takes about 15 minutes total:\n\n' +
'1) References — share up to 3:\n   {{CandRefFormLink}}\n\n' +
'2) Culture Fit assessment:\n   {{CultureFormLink}}\n\n' +
'If you have already submitted one of these, thank you — just complete the other and you are all set. Finishing both keeps your application on track for a fast final decision.\n\n' +
'If something has changed or you have questions, just reply to this email — a real person will read it.\n\n' +
'Thanks,\n{{HiringManagerName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,CandRefFormLink,CultureFormLink,ResponseDeadline,HiringManagerName,ShopName',
    'Notes': 'Single gentle reminder sent ~REFERENCE_REMINDER_HOURS_BEFORE the references/culture deadline when the candidate has not submitted. Sent by 38_Reference_Reminders.gs.'
  },
  {
    'Template Key': 'working_interview_invitation',
    'Subject':      'Working interview invitation — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'We would like to invite you to a paid working interview at {{InterviewLocation}}.\n\n' +
'You will be paid at your current rate for the hours worked. Bring your hand tools — we provide lifts, specialty equipment, and everything else.\n\n' +
'Here is the honest reason we do this step: {{ShopMission}} The only way to know whether someone truly fits that standard is to work alongside them. And the only way for you to know whether this is a shop you want to be part of is to actually work in it.\n\n' +
'This step goes both directions. You are evaluating us just as much as we are evaluating you. Come ready to do real work on {{ShopSpecialties}}, ask whatever you want about how the shop runs, and be yourself. That is all we ask.\n\n' +
'Reply with a couple of days and times that work for you over the next week and we will lock it in.\n\n' +
'{{HiringManagerName}}\n{{ShopName}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,InterviewLocation,ShopSpecialties,HiringManagerName,ShopName,ShopMission,CompanyPhone',
    'Notes': 'Explicitly frames the working interview as mutual evaluation — candidate assesses Frank\'s too.'
  },
  {
    'Template Key': 'hold_email',
    'Subject':      'Update on your {{RoleName}} application — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'A quick, honest update: we are still reviewing applicants for the {{RoleName}} role and have not made a final decision yet. We expect to follow up within {{SLADays}} business days.\n\n' +
'{{ShopWhyWeHire}} That means we take the time to make this decision carefully — not because we are indifferent to your time, but because the people who join this team deserve to be set up for success from day one.\n\n' +
'You will hear from us either way.\n\n' +
'Thank you for your patience,\n{{CompanySignatureName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,SLADays,ShopName,ShopWhyWeHire,CompanySignatureName',
    'Notes': 'Transparency and respect. Deliberate hiring explained, not just apologized for.'
  },
  {
    'Template Key': 'gracious_decline',
    'Subject':      'Your {{RoleName}} application — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Thank you for the time and thought you put into your application for the {{RoleName}} role at {{ShopName}}. The pre-screen, the conversations, the time you invested — it genuinely matters to us, and we do not take it for granted.\n\n' +
'After careful review, we have decided to move forward with another candidate at this time.\n\n' +
'This is not a judgment of your ability or your character. Hiring decisions come down to the specific needs of a team at a specific moment, and those variables are rarely visible from the outside.\n\n' +
'We keep applications on file for {{KeepDoorOpenMonths}} months. If something opens up and the match looks strong, we may reach back out. You are always welcome to reapply as well.\n\n' +
'We wish you the very best,\n{{CompanySignatureName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,KeepDoorOpenMonths,CompanySignatureName',
    'Notes': 'Dignity, appreciation, relationship preservation. No platitudes, no corporate language.'
  },
  {
    'Template Key': 'we_are_reviewing',
    'Subject':      'Your application is in front of us — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Quick note to confirm: your application is in front of us and being reviewed. You will hear back within {{SLADays}} business days.\n\n' +
'While you wait, here is a bit about who we are:\n\n' +
'{{ShopMission}}\n\n' +
'You can learn more about the shop and the team at {{ShopWebsite}}.\n\n' +
'Talk soon,\n{{CompanySignatureName}}',
    'Required Merge Fields': 'CandidateFirstName,SLADays,ShopMission,ShopWebsite,CompanySignatureName',
    'Notes': 'Uses mission statement — every touchpoint reinforces who Frank\'s is.'
  },
  {
    'Template Key': 'offer_pending_followup',
    'Subject':      'Your offer for {{RoleName}} — next steps',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'We are finalizing your offer for the {{RoleName}} role. {{HiringManagerName}} will reach out within the next day or two with the details — compensation, start date, and what your first few days will look like.\n\n' +
'We are looking forward to having you on the team.\n\n' +
'{{HiringManagerName}}\n{{ShopName}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,HiringManagerName,ShopName,CompanyPhone',
    'Notes': ''
  },
  {
    'Template Key': 'hired_congratulations',
    'Subject':      'Welcome to {{ShopName}}, {{CandidateFirstName}}',
    'Body':
'{{CandidateFirstName}},\n\n' +
'You are in. Welcome to {{ShopName}}.\n\n' +
'{{ShopMission}} That is what you are joining — and it takes real commitment from every person on the team to hold that standard every day.\n\n' +
'{{ShopTeamMessage}} We intend to hold up our end of that with you.\n\n' +
'{{HiringManagerName}} will follow up shortly with your start date, what to expect on day one, and where to park at {{InterviewLocation}}. If anything comes up between now and then, reply here or call {{CompanyPhone}}.\n\n' +
'Welcome aboard,\n{{HiringManagerName}}\n{{HiringManagerTitle}} · {{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,ShopMission,ShopTeamMessage,HiringManagerName,HiringManagerTitle,InterviewLocation,CompanyPhone',
    'Notes': 'Sets the tone for day one. Mission-forward, not just congratulatory.'
  },
  {
    'Template Key': 'technician_post_prescreen',
    'Subject':      'Two steps to move forward — {{RoleName}} at {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Thanks for completing the pre-screen. To move your Technician application forward, please complete BOTH of the following before your phone screen:\n\n' +
'1) Book your phone screen with {{HiringManagerName}}:\n   {{BookingLink}}\n\n' +
'2) Complete the Technician Skill Level Test (~20 minutes):\n   {{SkillsTestLink}}\n\n' +
'Why both: the skill test helps us understand your real-world experience — the systems you know, the tools you use, the work you have actually done. That way we can use the phone screen to talk about the role, the shop, and what you are looking for, not spend it on basics we could have learned beforehand.\n\n' +
'Please complete the test on your own. We are not looking for perfect answers — we are looking for honest ones. That standard reflects how we operate across everything we do here.\n\n' +
'We specialize in {{ShopSpecialties}}. {{ShopPerksLine}}\n\n' +
'Looking forward to talking,\n{{HiringManagerName}}\n{{HiringManagerTitle}} · {{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,HiringManagerName,HiringManagerTitle,BookingLink,SkillsTestLink,ShopSpecialties,ShopPerksLine',
    'Notes': 'Explains the why behind both steps. Honesty standard mirrors shop values.'
  },
  {
    'Template Key': 'interview_worksheet_dayof',
    'Subject':      'Interview today — {{CandidateName}} ({{RoleName}}) at {{InterviewDate}}',
    'Body':         '{{WorksheetBody}}',
    'Required Merge Fields': 'CandidateName,RoleName,InterviewDate,WorksheetBody',
    'Notes':        'Day-of interview cheat sheet emailed to hiring manager. Body is AI-generated.'
  },
  {
    'Template Key': 'post_interview_thankyou',
    'Subject':      'Thank you for your time — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Thank you for taking the time to connect with us. We appreciate the honesty and effort you brought to the conversation.\n\n' +
'Our team will be reviewing everything carefully and you will hear back within {{SLADays}} business days with a clear next step or final decision.\n\n' +
'{{ShopMission}}\n\n' +
'Whatever the outcome, we take this process seriously and we will not leave you hanging.\n\n' +
'Talk soon,\n{{CompanySignatureName}}\n{{ShopName}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,SLADays,ShopMission,ShopName,CompanyPhone,CompanySignatureName',
    'Notes': 'Sent after phone screen or full interview transcript is graded. Sets SLA expectation; reinforces mission. Disable via POST_INTERVIEW_THANKYOU_ENABLED=FALSE.'
  },
  {
    'Template Key': 'reference_received_confirmation',
    'Subject':      'Got your references — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'We received your references — thank you for getting those to us.\n\n' +
'We will be reaching out to each of your references directly. That process typically takes a few days. You do not need to do anything else on your end.\n\n' +
'Once we have heard back, we will be in touch with next steps. You should hear from us within {{SLADays}} business days.\n\n' +
'Thank you for your patience,\n{{CompanySignatureName}}\n{{ShopName}}',
    'Required Merge Fields': 'CandidateFirstName,SLADays,ShopName,CompanySignatureName',
    'Notes': 'Sent when candidate submits references (REFS_PENDING). Brief acknowledgment that sets timeline expectations.'
  },
  {
    'Template Key': 'not_currently_hiring',
    'Subject':      'Your {{RoleName}} application — {{ShopName}}',
    'Body':
'Hi {{CandidateFirstName}},\n\n' +
'Thank you for completing our pre-screen for the {{RoleName}} role at {{ShopName}}. We appreciate the time and honesty you put into it.\n\n' +
'We want to be straightforward with you: we are not actively moving forward with new hires for this position right now. That has nothing to do with your application — it is simply where things stand for us at the moment.\n\n' +
'We will keep your information on file. If something opens up and we think you would be a strong fit, we will be in touch. You are also welcome to check back at {{ShopWebsite}} anytime.\n\n' +
'{{ShopMission}} If that resonates with you, we hope our paths cross again.\n\n' +
'Thank you again for your interest,\n{{CompanySignatureName}}\n{{CompanyAddress}} · {{CompanyPhone}}',
    'Required Merge Fields': 'CandidateFirstName,RoleName,ShopName,ShopMission,ShopWebsite,CompanySignatureName,CompanyAddress,CompanyPhone',
    'Notes': 'Sent when HIRING_PAUSE_MODE is TRUE. Honest, warm, mission-connected. No score threshold.'
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// OTTER INTERVIEW SUMMARY TEMPLATE — single source of truth
// These section labels are what the Otter "Candidate Interview" template should
// output, and what the interview_summary AI prompt grades against. They mirror
// the PhoneScreen rubric categories so summary grading stays consistent.
// ─────────────────────────────────────────────────────────────────────────────
var OTTER_SUMMARY_SECTIONS = [
  'Candidate & Role',
  'Relevant Experience & Credibility',
  'Schedule / Availability',
  'Pay Expectations',
  'Ownership & Accountability Examples',
  'Coachability',
  'Role Understanding',
  'Culture Fit Signals',
  'Communication Quality',
  'Red Flags / Inconsistencies',
  'Overall Recommendation & Next Step'
];

// The exact template text to paste into Otter (Settings → Meeting Templates /
// Summary template) for candidate interviews. printOtterSummaryTemplate() logs it.
var OTTER_INTERVIEW_SUMMARY_TEMPLATE = [
  "Frank's European Service — Candidate Interview Summary",
  'Instructions to the notetaker/AI: fill each numbered section with concrete,',
  'specific evidence from the conversation. If a topic did not come up, write',
  '"Not discussed" — do not infer or assume.',
  ''
].concat(OTTER_SUMMARY_SECTIONS.map(function (s, i) {
  return (i + 1) + ') ' + s + ': ';
})).join('\n');

/** Build the interview_summary prompt body from the canonical sections (no drift). */
function _buildInterviewSummaryPromptBody_() {
  return 'You are evaluating a STRUCTURED INTERVIEW SUMMARY produced from a recorded candidate ' +
    'interview using a fixed template, NOT a raw transcript. The summary is organized into these sections:\n' +
    OTTER_SUMMARY_SECTIONS.map(function (s) { return '  • ' + s; }).join('\n') + '\n\n' +
    'Score ONLY on evidence explicitly present in each section. A section marked "Not discussed" or left ' +
    'blank MUST lower confidence and count against credibility for that dimension — never assume the best. ' +
    'Do NOT reward length or confident tone; reward concrete, verifiable behavioral evidence. ' +
    'Apply the AI Grading Rubrics (PhoneScreen) weights, mapping each rubric category to the matching section ' +
    'above. Treat anything in "Red Flags / Inconsistencies" as a concern and raise ai_risk_score accordingly.\n\n' +
    'ROLE: {{RoleName}}\nINTERVIEW DATE: {{InterviewDate}}\n\n' +
    'INTERVIEW SUMMARY:\n{{TranscriptText}}\n\n' +
    'Return STRICT JSON only. No prose outside JSON. Fields: ai_score (0-100), ai_risk_score (0-10), summary, ' +
    'strengths (array of 3), concerns (array of 3), credibility_score (0-10), possible_misrepresentation (boolean), ' +
    'recommended_next_step (string from the candidate status list), confidence_level (High|Medium|Low).';
}

/**
 * Install/refresh the interview_summary prompt in AI Prompt Templates. Unlike
 * seedAllTemplates (insert-only), this OVERWRITES the body so the canonical
 * template wiring always lands. Safe to re-run.
 */
function installOtterSummaryPrompt() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.AI_PROMPTS);
    var rowObj = {
      'Prompt Key':  'interview_summary',
      'Phase':       'InterviewSummary',
      'Provider':    '{{Provider}}',
      'Model':       '{{Model}}',
      'Temperature': 0.2,
      'Prompt Body': _buildInterviewSummaryPromptBody_(),
      'Notes':       'Evidence-based grading for Otter structured interview summaries. Used when AI_INTERVIEW_INPUT_MODE=summary.'
    };
    var hits = findRowsByColumnValue_(sh, 'Prompt Key', 'interview_summary');
    if (hits.length) updateRowWhere_(sh, 'Prompt Key', 'interview_summary', rowObj);
    else appendRowByHeader_(sh, rowObj);
    var msg = '[OTTER] interview_summary prompt ' + (hits.length ? 'updated' : 'installed') +
              ' (' + OTTER_SUMMARY_SECTIONS.length + ' sections)';
    Logger.log(msg);
    toast_(msg, 'Recruiting OS', 6);
    return msg;
  });
}

/** Print the exact Otter template text to paste into Otter. Returns the text. */
function printOtterSummaryTemplate() {
  var msg = '[OTTER] Paste this into your Otter "Candidate Interview" summary template:\n\n' +
            OTTER_INTERVIEW_SUMMARY_TEMPLATE;
  Logger.log(msg);
  return OTTER_INTERVIEW_SUMMARY_TEMPLATE;
}

/**
 * Install/refresh ALL email templates from SEED_EMAIL_TEMPLATES into the
 * Email Templates sheet. Unlike seedAllTemplates (insert-only), this
 * OVERWRITES Subject + Body + Required Merge Fields for every existing
 * Template Key so brand-voice rewrites take effect. Safe to re-run.
 */
function installAllEmailTemplates() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.EMAIL_TEMPLATES);
    var updated = 0, added = 0;
    SEED_EMAIL_TEMPLATES.forEach(function (row) {
      var hits = findRowsByColumnValue_(sh, 'Template Key', row['Template Key']);
      if (hits.length) { updateRowWhere_(sh, 'Template Key', row['Template Key'], row); updated++; }
      else            { appendRowByHeader_(sh, row); added++; }
    });
    var msg = '[EMAIL] installAllEmailTemplates — updated=' + updated + ' added=' + added +
              ' (total ' + SEED_EMAIL_TEMPLATES.length + ')';
    Logger.log(msg);
    toast_(msg, 'Recruiting OS', 6);
    logEvent_('EMAIL_TEMPLATES_INSTALLED', '', { updated: updated, added: added });
    return msg;
  });
}

/**
 * Install/refresh ALL AI prompts from SEED_AI_PROMPTS into the AI Prompt
 * Templates sheet. Unlike seedAllTemplates (insert-only), this OVERWRITES
 * the prompt body for every existing Prompt Key so prompt tuning takes effect.
 * Safe to re-run.
 */
function installAllAiPrompts() {
  return withLock_(function () {
    var sh = getSheet_(SHEETS.AI_PROMPTS);
    var updated = 0, added = 0;
    SEED_AI_PROMPTS.forEach(function (row) {
      var hits = findRowsByColumnValue_(sh, 'Prompt Key', row['Prompt Key']);
      if (hits.length) { updateRowWhere_(sh, 'Prompt Key', row['Prompt Key'], row); updated++; }
      else            { appendRowByHeader_(sh, row); added++; }
    });
    var msg = '[AI] installAllAiPrompts — updated=' + updated + ' added=' + added +
              ' (total ' + SEED_AI_PROMPTS.length + ')';
    Logger.log(msg);
    toast_(msg, 'Recruiting OS', 6);
    logEvent_('AI_PROMPTS_INSTALLED', '', { updated: updated, added: added });
    return msg;
  });
}

var SEED_AI_PROMPTS = [
  {
    'Prompt Key': 'prescreen',
    'Phase':       'PreScreen',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You evaluate a job pre-screen submission for an auto repair shop. Apply the rubric weights listed in AI Grading Rubrics. Penalize blame language and over-polished AI-style answers. Reward specificity, ownership, and realism.\n\n' +
'CANDIDATE PAYLOAD:\n{{Payload}}\n\n' +
'ROLE: {{RoleName}}\nROLE REQUIREMENTS: {{RoleRequirements}}\n\n' +
'ADDITIONALLY assess the LIKELIHOOD the answers were AI-generated (e.g., ChatGPT/Claude/Gemini paste) rather than written by the candidate. Score 0-100. Signals to weigh:\n' +
'  • Overly polished prose with generic platitudes ("passionate about quality", "leverage", "synergy", "moreover", "in conclusion")\n' +
'  • Uniform sentence cadence and paragraph structure across distinct questions (humans vary their length and tone)\n' +
'  • Lack of concrete specifics — no proper names, dates, dollar amounts, vehicle makes/models, shop names, coworkers\n' +
'  • Vocabulary register that doesn\'t match the role (e.g., a Valet/Porter applicant writing like a corporate consultant)\n' +
'  • Markdown-like formatting (numbered lists, dashes used as bullets) where free-form was asked\n' +
'  • Answers that read as definitions of the concept rather than personal stories ("Ownership means taking responsibility for…")\n' +
'  • Identical or near-identical openings across multiple answers\n' +
'Conversely, REDUCE the score for: typos, sentence fragments, idiom and slang, vivid concrete detail, specific names/places/years, personal voice, emotion, and admissions of imperfection.\n\n' +
'Return STRICT JSON only. No prose outside JSON. Fields: ai_score (0-100), ai_risk_score (0-10), summary, strengths (array of 3), concerns (array of 3), credibility_score (0-10), possible_misrepresentation (boolean), recommended_next_step (string from the candidate status list), confidence_level (High|Medium|Low), ai_authored_likelihood (0-100), ai_authored_reasoning (short string — the 1-2 sentences that justify the ai_authored_likelihood score).',
    'Notes': 'Pre-screen written review prompt. Also scores AI-authored likelihood.'
  },
  {
    'Prompt Key': 'resume_review',
    'Phase':       'Resume',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You screen a candidate RESUME for a hiring manager at an auto repair shop (Frank\'s European Service). Decide whether this person is plausibly QUALIFIED for the role, based only on the resume text. Be practical, not academic — relevant hands-on auto experience matters more than formatting or buzzwords.\n\n' +
'ROLE: {{RoleName}}\nROLE REQUIREMENTS: {{RoleRequirements}}\n\n' +
'RESUME TEXT (may be raw OCR — ignore garbled characters):\n{{ResumeText}}\n\n' +
'Judge: relevant years and recency of experience for THIS role, specific skills/tools/vehicle makes, job stability vs. frequent short stints, and any disqualifiers. Do not penalize for an imperfect resume or OCR noise.\n\n' +
'Return STRICT JSON only. No prose outside JSON. Fields: resume_score (0-100, fit for THIS role), qualified (boolean — would you spend time interviewing this person), summary (2-3 sentences for the manager), key_strengths (array of up to 4 short strings), gaps (array of up to 4 short strings — missing requirements or concerns), years_relevant_experience (number, best estimate).',
    'Notes': 'Resume screen: scores fit for the role and flags qualified/unqualified to weed out up front.'
  },
  {
    'Prompt Key': 'phone_screen',
    'Phase':       'PhoneScreen',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You are evaluating a phone screen transcript. Apply rubric weights from AI Grading Rubrics (PhoneScreen). Look for red flags, schedule/pay alignment, and overall recommendation.\n\n' +
'ROLE: {{RoleName}}\nINTERVIEW DATE: {{InterviewDate}}\n\n' +
'TRANSCRIPT:\n{{TranscriptText}}\n\n' +
'Return STRICT JSON only. No prose outside JSON. Fields: ai_score (0-100), ai_risk_score (0-10), summary, strengths (array of 3), concerns (array of 3), credibility_score (0-10), possible_misrepresentation (boolean), recommended_next_step (string from the candidate status list), confidence_level (High|Medium|Low).',
    'Notes': 'Phone screen grading prompt.'
  },
  {
    'Prompt Key': 'full_interview',
    'Phase':       'FullInterview',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You are evaluating a full interview transcript. Apply rubric weights from AI Grading Rubrics (FullInterview). Provide holistic hiring confidence.\n\n' +
'ROLE: {{RoleName}}\nINTERVIEW DATE: {{InterviewDate}}\n\n' +
'TRANSCRIPT:\n{{TranscriptText}}\n\n' +
'Return STRICT JSON only. No prose outside JSON. Fields: ai_score (0-100), ai_risk_score (0-10), summary, strengths (array of 3), concerns (array of 3), credibility_score (0-10), possible_misrepresentation (boolean), recommended_next_step (string from the candidate status list), confidence_level (High|Medium|Low).',
    'Notes': 'Full interview grading prompt.'
  },
  {
    'Prompt Key': 'interview_summary',
    'Phase':       'InterviewSummary',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body': _buildInterviewSummaryPromptBody_(),
    'Notes': 'Evidence-based grading for Otter structured interview summaries. Used when AI_INTERVIEW_INPUT_MODE=summary.'
  },
  {
    'Prompt Key': 'reference_summary',
    'Phase':       'References',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You are summarizing reference check responses for a candidate. Compute an average reference score (0-100), and list strengths, concerns, and a confidence level.\n\n' +
'REFERENCE RESPONSES:\n{{ReferencesPayload}}\n\n' +
'Return STRICT JSON: { reference_average_score, summary, strengths (3), concerns (3), confidence_level }.',
    'Notes': 'Reference summarization prompt.'
  },
  {
    'Prompt Key': 'culture_fit',
    'Phase':       'CultureFit',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.2,
    'Prompt Body':
'You are scoring an internal culture fit assessment. Evaluate ownership, coachability, customer service, communication, work ethic, team alignment, problem solving, integrity. Penalize blame and bias toward concrete behavioral signals.\n\n' +
'RESPONSES:\n{{CulturePayload}}\n\n' +
'Return STRICT JSON: { ai_score (0-100), summary, strengths (3), concerns (3), confidence_level }.',
    'Notes': 'Culture fit grading prompt.'
  },
  {
    'Prompt Key': 'interview_prep',
    'Phase':       'InterviewPrep',
    'Provider':    '{{Provider}}',
    'Model':       '{{Model}}',
    'Temperature': 0.3,
    'Prompt Body': _buildInterviewPrepPromptBody_(),
    'Notes': 'Interview prep: generates tailored questions from pre-screen answers for the hiring manager worksheet.'
  }
];

var SEED_AI_RUBRICS = [
  // ── prescreen (9 categories)
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Answer Specificity',       'Weight': 15, 'Criteria': 'Concrete examples, names, metrics, dates.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Realism',                  'Weight': 10, 'Criteria': 'Plausible scenarios without exaggeration.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Consistency',              'Weight': 15, 'Criteria': 'Cross-question coherence; no contradictions.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Ownership Language',       'Weight': 15, 'Criteria': 'I-statements; responsibility taken.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Blame Language',           'Weight': 10, 'Criteria': 'Penalize blame of customers/management.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Communication Quality',    'Weight': 10, 'Criteria': 'Grammar, clarity, professionalism.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Role Understanding',       'Weight': 10, 'Criteria': 'Correct terminology and expectations.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'AI-Generated Risk',        'Weight':  5, 'Criteria': 'Detect AI-style polish without voice.', 'Notes': '' },
  { 'Rubric Key': 'prescreen',      'Phase': 'PreScreen',     'Category': 'Experience Credibility',   'Weight': 10, 'Criteria': 'Resume vs claimed alignment.', 'Notes': '' },

  // ── phone_screen (10 categories)
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Communication',            'Weight': 12, 'Criteria': 'Clarity, professionalism, listening.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Experience Credibility',   'Weight': 12, 'Criteria': 'Stories match resume.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Schedule Alignment',       'Weight': 10, 'Criteria': 'Confirms required schedule.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Pay Alignment',            'Weight': 10, 'Criteria': 'Pay expectations within range.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Ownership Mindset',        'Weight': 12, 'Criteria': 'Takes responsibility for outcomes.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Coachability',             'Weight': 10, 'Criteria': 'Open to feedback and growth.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Role Understanding',       'Weight': 10, 'Criteria': 'Familiar with day-to-day expectations.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Culture Fit',              'Weight': 12, 'Criteria': 'Alignment with shop values.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Red Flags',                'Weight':  6, 'Criteria': 'Inconsistencies, blame, evasiveness.', 'Notes': '' },
  { 'Rubric Key': 'phone_screen',   'Phase': 'PhoneScreen',   'Category': 'Overall Recommendation',   'Weight':  6, 'Criteria': 'Holistic next-step recommendation.', 'Notes': '' },

  // ── full_interview (10 categories)
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Professional Maturity',    'Weight': 12, 'Criteria': 'Composure, judgment, self-awareness.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Communication Depth',      'Weight': 10, 'Criteria': 'Nuance, structure, storytelling.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Specificity of Examples',  'Weight': 10, 'Criteria': 'Detailed, verifiable examples.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Technical / Role Fit',     'Weight': 12, 'Criteria': 'Job-specific competence.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Culture Alignment',        'Weight': 10, 'Criteria': 'Values alignment.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Accountability',           'Weight': 10, 'Criteria': 'Owns mistakes; learns from them.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Coachability',             'Weight':  8, 'Criteria': 'Receptive to direction.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Long-Term Fit',            'Weight': 10, 'Criteria': 'Tenure indicators.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Leadership Concerns',      'Weight':  8, 'Criteria': 'Conflict, ego, control issues.', 'Notes': '' },
  { 'Rubric Key': 'full_interview', 'Phase': 'FullInterview', 'Category': 'Overall Hiring Confidence','Weight': 10, 'Criteria': 'Holistic confidence in hire.', 'Notes': '' }
];

var SEED_ROLE_RULES = (function () {
  // Common values across roles
  var COMMON = {
    'Hiring Manager':                  'Travis Burd',
    'Required Availability':           'Mon-Fri',
    'Valid Drivers License Required':  'TRUE',
    'Background Check Required':       'TRUE',
    'Phone Screen Booking Link':       'https://koalendar.com/e/candidate-phone-screen-2',
    'Full Interview Booking Link':     'https://koalendar.com/e/fes-full-interview',
    'Culture Fit Form Link':           'https://docs.google.com/forms/d/e/1FAIpQLSdTWzz6nCwVd_9whYw_fItrFhrr_0R2z5PwQ3bTeKzpTFbubw/viewform',
    'Reference Form Link':             'https://docs.google.com/forms/d/e/1FAIpQLSflp92JKb7Z8aezNab_Cg7zQmaroqVH0WuQ_UjNUHYvz4AUhQ/viewform',
    'Auto Send Booking':               'TRUE',
    'Active':                          'TRUE'
  };
  function row(role, minScore, autoMin, manRange, hardReject, maxRisk, minExp, payRange, notes) {
    return Object.assign({}, COMMON, {
      'Role':                            role,
      'Minimum Score':                   minScore,
      'Auto Booking Minimum Score':      autoMin,
      'Manual Review Score Range':       manRange,
      'Hard Reject Score':               hardReject,
      'Max Risk Score For Auto Booking': maxRisk,
      'Minimum Experience Years':        minExp,
      'Pay Range':                       payRange,
      'Notes':                           notes || ''
    });
  }
  return [
    row('Service Advisor',          70, 80, '55-69', 40, 4, 2, '$60k-$110k', 'Fill in booking links and pay range.'),
    row('Technician',               70, 80, '55-69', 40, 4, 3, '$30-$60/hr', ''),
    row('Lube Tech',                60, 75, '50-59', 35, 5, 0, '$16-$20/hr', ''),
    row('Valet / Porter',           60, 75, '50-59', 35, 5, 0, '$16-$20/hr', ''),
    row('Parts',                    65, 78, '55-64', 40, 4, 1, '$22-$32/hr', ''),
    row('CX / Customer Experience', 60, 75, '50-59', 35, 5, 0, '$16-$20/hr', ''),
    row('Admin',                    72, 82, '58-71', 45, 4, 2, '$60k-$110k', ''),
    row('Shop Foreman',             82, 90, '65-81', 55, 3, 5, '$60k-$110k', '')
  ];
})();

var SEED_HIRING_MANAGERS = [
  {
    'Active':                        'TRUE',
    'Hiring Manager Name':           'Travis Burd',
    'Hiring Manager Email':          'travis.burd@frankseuropeanservice.com',
    'Phone':                         '702-365-9100',
    'Location':                      '1931 N Rainbow Blvd | Las Vegas, NV | 89108',
    'Roles Owned':                   'Service Advisor, Technician, Lube Tech, Valet / Porter, Parts, CX / Customer Experience, Admin, Shop Foreman',
    'Phone Screen Booking Link':     'https://koalendar.com/e/candidate-phone-screen-2',
    'Full Interview Booking Link':   'https://koalendar.com/e/fes-full-interview',
    'Google Calendar ID':            'c_d4d80850bcd6ce5c5f150dd6427b56ea0aa3e4cca64b055c9e1492907ab761f8@group.calendar.google.com',
    'Backup Manager Name':           '',
    'Backup Manager Email':          '',
    'Signature Name':                "Frank's Recruiting Team",
    'Notes':                         ''
  }
];

var SEED_FORM_REGISTRY = [
  {
    'Form Key':            'CULTURE_FIT',
    'Form Name':           "Frank's European Service — Culture & Style",
    'Active':              'TRUE',
    'Approved Form ID':    '1FAIpQLSd6f7HWVQ1gLoZiChOraRXu2eDZgkEGeRKxAtZLtfY1bJGW1g',
    'Approved Form URL':   'https://docs.google.com/forms/d/e/1FAIpQLSd6f7HWVQ1gLoZiChOraRXu2eDZgkEGeRKxAtZLtfY1bJGW1g/viewform',
    'Edit ID':             '1oh8pnTnXFuixrUSa2mcj2KgQmZYYMWSDrhHzDAP_woI',
    'Response Tab':        'Form Responses 1',
    'Expected Header Key': 'CULTURE_FIT',
    'Last Verified':       '5/24/2026',
    'Notes':               'Culture & Style. Ingested by onCultureSubmit.'
  },
  {
    'Form Key':            'REFERENCE_SUBMISSION',
    'Form Name':           "Frank's European Service — Provide Your References",
    'Active':              'TRUE',
    'Approved Form ID':    '1FAIpQLSctvLXIQCBUWESPxfB7UieLf_KG99hF6TYtcNjBYX-zRf_HIg',
    'Approved Form URL':   'https://docs.google.com/forms/d/e/1FAIpQLSctvLXIQCBUWESPxfB7UieLf_KG99hF6TYtcNjBYX-zRf_HIg/viewform',
    'Edit ID':             '1nI78FM4g67p7rMoG_Eim5fqDpZcvn7vRKmwF6AurLDU',
    'Response Tab':        'Form Responses 2',
    'Expected Header Key': 'REFERENCE_REQUESTS',
    'Last Verified':       '5/24/2026',
    'Notes':               'Candidate-submitted references.'
  },
  {
    'Form Key':            'REFERENCE_CHECK',
    'Form Name':           "Frank's European Service — Professional Reference Form",
    'Active':              'TRUE',
    'Approved Form ID':    '1FAIpQLSc49qRz4DJBXvspcOPy4Q_YGnvo-6sA6Rdew8KuL61sgjQacw',
    'Approved Form URL':   'https://docs.google.com/forms/d/e/1FAIpQLSc49qRz4DJBXvspcOPy4Q_YGnvo-6sA6Rdew8KuL61sgjQacw/viewform',
    'Edit ID':             '1NAkGh7wCrIODS_tZiGGh4DJ9t7XSkCjcasJrLcyW9KU',
    'Response Tab':        'Form Responses 3',
    'Expected Header Key': 'REFERENCE_CHECKS',
    'Last Verified':       '5/24/2026',
    'Notes':               'Reference-completed check.'
  },
  {
    'Form Key':            'SKILLS_TEST',
    'Form Name':           "Frank's European Service — Technician Skill Level Test",
    'Active':              'TRUE',
    'Approved Form ID':    '1FAIpQLSfXywxsA82l3KyDblkRdvF8DTS-5y8Xcw3Vo7saL6ChqDJ2EQ',
    'Approved Form URL':   'https://docs.google.com/forms/d/e/1FAIpQLSfXywxsA82l3KyDblkRdvF8DTS-5y8Xcw3Vo7saL6ChqDJ2EQ/viewform',
    'Edit ID':             '1wRz__uO-d-jJfHU0ectDEAcX9h3VT-75B-KwP1XsXzs',
    'Response Tab':        'Form Responses 4',
    'Expected Header Key': 'SKILLS_TEST_RESPONSES',
    'Last Verified':       '5/24/2026',
    'Notes':               'Technician Skill Level Test. Auto-sent post-Pre-Screen.'
  },
  {
    'Form Key':            'PRESCREEN',
    'Form Name':           "Frank's European Service — Candidate Pre-Screen",
    'Active':              'TRUE',
    'Approved Form ID':    '1FAIpQLSfU21ujxpQHLAIJjEJD0r1lmkgWoy5oQV7l8t2ZQf6RFvgNKA',
    'Approved Form URL':   'https://docs.google.com/forms/d/e/1FAIpQLSfU21ujxpQHLAIJjEJD0r1lmkgWoy5oQV7l8t2ZQf6RFvgNKA/viewform',
    'Edit ID':             '198l2NOQbGPW0WAuyuMBjUO2ALKtQmWoWbzWfuzBdpmY',
    'Response Tab':        'Form Responses 5',
    'Expected Header Key': 'RAW_PRESCREEN',
    'Last Verified':       '5/24/2026',
    'Notes':               'Approved Pre-Screen Form — the entry point of all automation. Submissions ingested by onPreScreenSubmit.'
  }
];

var SEED_ASSESSMENT_REGISTRY = [
  { 'Active': 'TRUE', 'Role': 'Service Advisor',          'Assessment Section Key': 'ASSESS_SERVICE_ADVISOR', 'Header Key': 'HEADERS_ASSESS_SERVICE_ADVISOR', 'Rubric Key': 'RUBRIC_SERVICE_ADVISOR', 'Culture Min': 80, 'Skill Min': 75, 'Overall Min': 78, 'Auto Decline Below': 55, 'Manual Review Band': '56-77', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Service Advisor candidates must show strong communication, customer trust-building, ownership, pace, and ability to explain diagnostics, timelines, and estimates without pressure.' },
  { 'Active': 'TRUE', 'Role': 'Technician',               'Assessment Section Key': 'ASSESS_TECHNICIAN',      'Header Key': 'HEADERS_ASSESS_TECHNICIAN',      'Rubric Key': 'RUBRIC_TECHNICIAN',      'Culture Min': 75, 'Skill Min': 78, 'Overall Min': 78, 'Auto Decline Below': 55, 'Manual Review Band': '56-77', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Technician candidates must show diagnostic discipline, testing-before-replacing mindset, documentation ability, European vehicle experience, and comeback prevention thinking.' },
  { 'Active': 'TRUE', 'Role': 'Lube Tech',                'Assessment Section Key': 'ASSESS_LUBE_TECH',       'Header Key': 'HEADERS_ASSESS_LUBE_TECH',       'Rubric Key': 'RUBRIC_LUBE_TECH',       'Culture Min': 75, 'Skill Min': 65, 'Overall Min': 70, 'Auto Decline Below': 50, 'Manual Review Band': '51-69', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Lube Tech candidates must show coachability, safety awareness, basic inspection ability, attention to detail, and readiness to grow into higher-level technical work.' },
  { 'Active': 'TRUE', 'Role': 'Valet / Porter',           'Assessment Section Key': 'ASSESS_VALET_PORTER',    'Header Key': 'HEADERS_ASSESS_VALET_PORTER',    'Rubric Key': 'RUBRIC_VALET_PORTER',    'Culture Min': 80, 'Skill Min': 65, 'Overall Min': 72, 'Auto Decline Below': 50, 'Manual Review Band': '51-71', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Valet / Porter candidates must show dependability, professionalism, safe vehicle handling, attention to customer property, and ability to follow process consistently.' },
  { 'Active': 'TRUE', 'Role': 'Parts',                    'Assessment Section Key': 'ASSESS_PARTS',           'Header Key': 'HEADERS_ASSESS_PARTS',           'Rubric Key': 'RUBRIC_PARTS',           'Culture Min': 75, 'Skill Min': 72, 'Overall Min': 74, 'Auto Decline Below': 52, 'Manual Review Band': '53-73', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Parts candidates must show accuracy, urgency, vendor communication, part matching discipline, ETA communication, and documentation ability.' },
  { 'Active': 'TRUE', 'Role': 'CX / Customer Experience', 'Assessment Section Key': 'ASSESS_CX',              'Header Key': 'HEADERS_ASSESS_CX',              'Rubric Key': 'RUBRIC_CX',              'Culture Min': 82, 'Skill Min': 68, 'Overall Min': 74, 'Auto Decline Below': 52, 'Manual Review Band': '53-73', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': "CX candidates must show hospitality, emotional control, professional communication, follow-through, customer empathy, and ability to protect the Frank's experience." },
  { 'Active': 'TRUE', 'Role': 'Admin',                    'Assessment Section Key': 'ASSESS_ADMIN',           'Header Key': 'HEADERS_ASSESS_ADMIN',           'Rubric Key': 'RUBRIC_ADMIN',           'Culture Min': 78, 'Skill Min': 70, 'Overall Min': 74, 'Auto Decline Below': 52, 'Manual Review Band': '53-73', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Admin candidates must show organization, accuracy, confidentiality, follow-through, communication, and ability to support operations without creating confusion.' },
  { 'Active': 'TRUE', 'Role': 'Shop Foreman',             'Assessment Section Key': 'ASSESS_SHOP_FOREMAN',    'Header Key': 'HEADERS_ASSESS_SHOP_FOREMAN',    'Rubric Key': 'RUBRIC_SHOP_FOREMAN',    'Culture Min': 85, 'Skill Min': 82, 'Overall Min': 84, 'Auto Decline Below': 60, 'Manual Review Band': '61-83', 'Auto Booking': 'TRUE', 'Booking Eligible': 'TRUE', 'Notes': 'Shop Foreman candidates must show leadership, diagnostic judgment, technician coaching ability, workflow control, quality standards, accountability, and calm decision-making.' }
];

// ─────────────────────────────────────────────────────────────────────────────
// Pull-based transcript sources (34_Transcript_Sources.gs). Seeded INACTIVE —
// the operator reviews each query/folder and flips Active=TRUE to enable. The
// Zapier→Otter sheet remains the primary live/in-person path.
// ─────────────────────────────────────────────────────────────────────────────
var SEED_TRANSCRIPT_SOURCES = [
  { 'Source Name': 'Fathom Emails', 'Active': 'FALSE', 'Type': 'gmail',
    'Gmail Query': 'from:(fathom.video) has:attachment newer_than:14d', 'Drive Folder ID': '',
    'Default Interview Type': 'FullInterview', 'Notes': 'Fathom recap emails. Review query, then set Active=TRUE.' },
  { 'Source Name': 'Otter Emails', 'Active': 'FALSE', 'Type': 'gmail',
    'Gmail Query': 'from:(otter.ai) newer_than:14d', 'Drive Folder ID': '',
    'Default Interview Type': 'PhoneScreen', 'Notes': 'Optional Gmail fallback — primary Otter path is the Zapier sheet.' },
  { 'Source Name': 'Drive Transcripts', 'Active': 'FALSE', 'Type': 'drive',
    'Gmail Query': '', 'Drive Folder ID': '',
    'Default Interview Type': 'FullInterview', 'Notes': 'Paste a Drive folder ID, then set Active=TRUE.' }
];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: seed all template sheets (idempotent)
// ─────────────────────────────────────────────────────────────────────────────
function seedAllTemplates() {
  var summary = { byTable: {} };
  return withLock_(function () {
    _clearUtilCaches_();
    var reg = getSheetOrNull_(SHEETS.SETUP_REGISTRY);
    function note(table, added, skipped) {
      summary.byTable[table] = { added: added, skipped: skipped };
      if (reg) {
        appendRowByHeader_(reg, {
          'Timestamp':       shopDateTime_(),
          'Item':            table + ' seed',
          'Category':        'Seed',
          'Status':          added > 0 ? 'SEEDED' : 'OK',
          'Auto-Created':    'FALSE',
          'Action Required': '',
          'Notes':           added + ' new rows added, ' + skipped + ' already present'
        });
      }
    }

    var r;
    r = _seedRows_(SHEETS.EMAIL_TEMPLATES,      function (x) { return x['Template Key']; },                                 SEED_EMAIL_TEMPLATES);       note('Email Templates',      r.added, r.skipped);
    r = _seedRows_(SHEETS.AI_PROMPTS,           function (x) { return x['Prompt Key']; },                                   SEED_AI_PROMPTS);            note('AI Prompt Templates',  r.added, r.skipped);
    r = _seedRows_(SHEETS.AI_RUBRICS,           function (x) { return String(x['Rubric Key']) + '|' + String(x['Category']); }, SEED_AI_RUBRICS);         note('AI Grading Rubrics',   r.added, r.skipped);
    r = _seedRows_(SHEETS.ROLE_RULES,           function (x) { return x['Role']; },                                         SEED_ROLE_RULES);            note('Role Rules',           r.added, r.skipped);
    r = _seedRows_(SHEETS.HIRING_MANAGERS,      function (x) { return normalizeEmail_(x['Hiring Manager Email']); },        SEED_HIRING_MANAGERS);       note('Hiring Managers',      r.added, r.skipped);
    r = _seedRows_(SHEETS.FORM_REGISTRY,        function (x) { return x['Form Key']; },                                     SEED_FORM_REGISTRY);         note('Form Registry',        r.added, r.skipped);
    r = _seedRows_(SHEETS.ASSESSMENT_REGISTRY,  function (x) { return x['Role']; },                                         SEED_ASSESSMENT_REGISTRY);   note('Assessment Registry',  r.added, r.skipped);
    r = _seedRows_(SHEETS.TRANSCRIPT_SOURCES,   function (x) { return x['Source Name']; },                                  SEED_TRANSCRIPT_SOURCES);    note('Transcript Sources',   r.added, r.skipped);

    // Role-based AI assessment framework (Question Bank + Rubrics + role_assessment
    // prompt). Lives in 35_Assessments.gs; idempotent. Registry is seeded above.
    safeRun_('seedAssessmentFramework', function () {
      if (typeof seedAssessmentFramework_ === 'function') {
        seedAssessmentFramework_();
        note('Assessment Framework', 0, 0);
      }
    });

    var msg = '[SEED] complete — ' + JSON.stringify(summary);
    Logger.log(msg);
    toast_('Templates seeded. See Setup Registry.', 'Recruiting OS', 5);
    return msg;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: idempotent row seeder
// ─────────────────────────────────────────────────────────────────────────────
function _seedRows_(sheetName, keyFn, rows) {
  var sh = getSheetOrNull_(sheetName);
  if (!sh) {
    Logger.log('_seedRows_: sheet missing: ' + sheetName + ' — run bootstrapSystem() first.');
    return { added: 0, skipped: 0 };
  }

  // Build set of existing keys
  var existing = {};
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow > 1 && lastCol > 0) {
    var headers = getHeaderRow_(sh);
    var data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var i = 0; i < data.length; i++) {
      var obj = {};
      headers.forEach(function (h, j) { if (h) obj[String(h).trim()] = data[i][j]; });
      var k = '';
      try { k = String(keyFn(obj) || '').trim(); } catch (e) { k = ''; }
      if (k) existing[k] = true;
    }
  }

  var added = 0, skipped = 0;
  rows.forEach(function (row) {
    var k = '';
    try { k = String(keyFn(row) || '').trim(); } catch (e) { k = ''; }
    if (k && existing[k]) { skipped++; return; }
    appendRowByHeader_(sh, row);
    if (k) existing[k] = true;
    added++;
  });
  return { added: added, skipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — read-only summary of what each sheet currently has
// ─────────────────────────────────────────────────────────────────────────────
function SEED_selfTest() {
  var out = ['[SEED] selfTest (read-only)…'];
  var sources = [
    { sheet: SHEETS.EMAIL_TEMPLATES,     seed: SEED_EMAIL_TEMPLATES,     label: 'Email Templates' },
    { sheet: SHEETS.AI_PROMPTS,          seed: SEED_AI_PROMPTS,          label: 'AI Prompt Templates' },
    { sheet: SHEETS.AI_RUBRICS,          seed: SEED_AI_RUBRICS,          label: 'AI Grading Rubrics' },
    { sheet: SHEETS.ROLE_RULES,          seed: SEED_ROLE_RULES,          label: 'Role Rules' },
    { sheet: SHEETS.HIRING_MANAGERS,     seed: SEED_HIRING_MANAGERS,     label: 'Hiring Managers' },
    { sheet: SHEETS.FORM_REGISTRY,       seed: SEED_FORM_REGISTRY,       label: 'Form Registry' },
    { sheet: SHEETS.ASSESSMENT_REGISTRY, seed: SEED_ASSESSMENT_REGISTRY, label: 'Assessment Registry' }
  ];
  sources.forEach(function (s) {
    var sh = getSheetOrNull_(s.sheet);
    var have = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    out.push('  ─ ' + s.label.padEnd(22, ' ') + ' sheet=' + (sh ? 'OK' : 'MISSING') +
             '  rowsNow=' + have + '  seedAvailable=' + s.seed.length);
  });
  out.push('[SEED] selfTest done. Run seedAllTemplates() to populate.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
