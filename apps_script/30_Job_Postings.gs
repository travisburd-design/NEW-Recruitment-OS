/**
 * 30_Job_Postings.gs
 * Frank's European Service — Recruiting OS
 *
 * Generates job-posting copy (Posting Title + Posting Body) for each ACTIVE
 * role in the Role Rules tab and UPSERTS it into the Job Postings tab, keyed
 * by Role. Posting copy is assembled from Config (shop identity, website,
 * location, pre-screen URL) plus per-role facts from Role Rules (pay range,
 * minimum experience, required availability, license / background needs).
 *
 * Ported from the retiring build's 22_job_postings.gs, rewritten to A's
 * conventions: CFG.get(...) accessor, A's row helpers (getSheet_,
 * getHeaderRow_, appendRowByHeader_, updateRowWhere_, findRowsByColumnValue_),
 * withLock_, safeRun_, and toast_. Writes A's real column names — "Posting
 * Title", "Posting Body", "Last Updated", "Updated By" — never B's
 * "Headline" / "Last Generated".
 *
 * Config keys referenced (all present in CFG_DEFAULTS):
 *   SHOP_NAME, SHOP_WEBSITE, SHOP_CITY_STATE, INTERVIEW_LOCATION,
 *   PRESCREEN_FORM_URL, COMPANY_SIGNATURE_NAME.
 *
 * Sheets: JOB_POSTINGS (upsert target), ROLE_RULES (source).
 *
 * Public Functions:
 *   writeJobPostings()                 — upsert postings for all active roles
 *   generateRolePosting_(roleRuleObj)  — build {title, body} for one role
 *   JOBPOSTINGS_selfTest()             — dry-run validation, writes nothing
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: writeJobPostings
// Iterates active Role Rules, generates posting copy, and upserts one row per
// role into the Job Postings tab. Wrapped in withLock_ around the mutation.
// Returns the number of postings written (created or updated).
// ─────────────────────────────────────────────────────────────────────────────
function writeJobPostings() {
  return safeRun_('writeJobPostings', function () {
    var rrSheet = getSheetOrNull_(SHEETS.ROLE_RULES);
    if (!rrSheet) { toast_('Role Rules sheet missing.', 'Job Postings', 4); return 0; }

    var jpSheet = getSheetOrNull_(SHEETS.JOB_POSTINGS);
    if (!jpSheet) { toast_('Job Postings sheet missing.', 'Job Postings', 4); return 0; }

    // Collect ACTIVE roles from Role Rules.
    var activeRoles = findRowsByColumnValue_(rrSheet, 'Active', 'TRUE')
      .map(function (hit) { return hit.data; })
      .filter(function (r) { return !isEmpty_(r['Role']); });

    if (!activeRoles.length) { toast_('No active roles in Role Rules.', 'Job Postings', 4); return 0; }

    var updatedBy = '';
    try { updatedBy = Session.getActiveUser().getEmail() || ''; } catch (e) { updatedBy = ''; }
    var nowLocal = shopDateTime_();

    var n = withLock_(function () {
      var count = 0;
      activeRoles.forEach(function (role) {
        var posting = generateRolePosting_(role);
        var fields = {
          'Posting Title': posting.title,
          'Posting Body':  posting.body,
          'Last Updated':  nowLocal,
          'Updated By':    updatedBy
        };
        // Upsert BY ROLE.
        var existing = findRowsByColumnValue_(jpSheet, 'Role', role['Role']);
        if (existing.length) {
          updateRowWhere_(jpSheet, 'Role', role['Role'], fields);
        } else {
          fields['Role'] = role['Role'];
          appendRowByHeader_(jpSheet, fields);
        }
        count++;
      });
      return count;
    });

    toast_('Job postings written: ' + n, 'Job Postings', 4);
    return n;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateRolePosting_(roleRuleObj)
// Builds posting copy for a single role from Config + the role's Role Rules row.
// Returns { title, body }. Pure — no sheet writes.
// ─────────────────────────────────────────────────────────────────────────────
function generateRolePosting_(role) {
  role = role || {};
  var roleName = String(role['Role'] || '').trim() || 'Team Member';

  var shop     = CFG.get('SHOP_NAME', "Frank's European Service");
  var site     = CFG.get('SHOP_WEBSITE', '');
  var cityState = CFG.get('SHOP_CITY_STATE', '');
  // INTERVIEW_LOCATION is a shop name in A's defaults; prefer city/state for the
  // posting headline locale, falling back to the location string.
  var locale   = cityState || CFG.get('INTERVIEW_LOCATION', '');
  var formUrl  = CFG.get('PRESCREEN_FORM_URL', '');
  var signature = CFG.get('COMPANY_SIGNATURE_NAME', "Frank's Recruiting Team");

  var pay    = !isEmpty_(role['Pay Range']) ? String(role['Pay Range']) : 'Competitive';
  var minExp = !isEmpty_(role['Minimum Experience Years']) ? String(role['Minimum Experience Years']) : '0';
  var avail  = !isEmpty_(role['Required Availability']) ? String(role['Required Availability']) : 'See application';

  var licenseRequired    = _jpTruthy_(role['Valid Drivers License Required']);
  var backgroundRequired = _jpTruthy_(role['Background Check Required']);

  var title = roleName + ' — ' + shop + (locale ? ' (' + locale + ')' : '');

  var body = [
    title,
    '',
    'About us: ' + shop + ' is a values-driven service shop.' +
      (site ? ' Learn more at ' + site + '.' : ''),
    '',
    'What you will do as a ' + roleName + ':',
    '  • Deliver excellent customer service and craftsmanship',
    '  • Work the required schedule: ' + avail,
    '',
    'What we require:',
    '  • ' + minExp + '+ year(s) of relevant experience',
    licenseRequired
      ? '  • Valid driver\'s license'
      : '  • Driver\'s license not required',
    backgroundRequired
      ? '  • Willingness to complete a background and driving-record check'
      : '  • Background check not required',
    '',
    'What we offer:',
    '  • Pay: ' + pay,
    '  • A team that respects ownership, coachability, and integrity',
    '',
    'Apply here: ' + (formUrl || '(pre-screen link will be added once forms are created)'),
    '',
    '— ' + signature
  ].join('\n');

  return { title: title, body: body };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local truthy helper for Role Rules TRUE/FALSE cells (booleans or strings).
// Kept module-local so this file leans only on A's shared helpers.
// ─────────────────────────────────────────────────────────────────────────────
function _jpTruthy_(v) {
  if (v === true) return true;
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === '1';
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST — dry run. Generates posting copy for active roles and validates
// the Job Postings tab schema. Writes NOTHING to any sheet.
// ─────────────────────────────────────────────────────────────────────────────
function JOBPOSTINGS_selfTest() {
  var out = ['[JOBPOSTINGS] selfTest (dry run — no sheet writes)…'];

  var jpSheet = getSheetOrNull_(SHEETS.JOB_POSTINGS);
  if (!jpSheet) {
    out.push('  ⚠ Job Postings sheet missing — run bootstrapSystem() first.');
  } else {
    var hdrs = getHeaderRow_(jpSheet);
    var need = ['Role', 'Posting Title', 'Posting Body', 'Last Updated', 'Updated By'];
    var missing = need.filter(function (h) { return getColIndex_(jpSheet, h) === 0; });
    out.push((missing.length ? '  ✗' : '  ✓') +
             ' Job Postings columns present: ' + JSON.stringify(hdrs) +
             (missing.length ? ' — MISSING: ' + missing.join(', ') : ''));
  }

  var rrSheet = getSheetOrNull_(SHEETS.ROLE_RULES);
  if (!rrSheet) {
    out.push('  ⚠ Role Rules sheet missing — no roles to generate.');
    out.push('[JOBPOSTINGS] selfTest done.');
    var msgEarly = out.join('\n');
    Logger.log(msgEarly);
    return msgEarly;
  }

  var activeRoles = findRowsByColumnValue_(rrSheet, 'Active', 'TRUE')
    .map(function (hit) { return hit.data; })
    .filter(function (r) { return !isEmpty_(r['Role']); });
  out.push('  ─ Active roles found: ' + activeRoles.length);

  // Generate copy for the first active role (or a synthetic sample) and confirm
  // the title/body come out non-empty and use A's expected structure.
  var sample = activeRoles.length ? activeRoles[0] : {
    'Role': 'Technician',
    'Pay Range': '$25–$40/hr',
    'Minimum Experience Years': '3',
    'Required Availability': 'Mon–Fri, 8a–5p',
    'Valid Drivers License Required': 'TRUE',
    'Background Check Required': 'FALSE'
  };
  var posting = generateRolePosting_(sample);
  out.push((posting.title ? '  ✓' : '  ✗') + ' generateRolePosting_ title: "' + posting.title + '"');
  out.push((posting.body && posting.body.indexOf('Apply here:') !== -1 ? '  ✓' : '  ✗') +
           ' generateRolePosting_ body length: ' + (posting.body ? posting.body.length : 0));

  // Confirm referenced Config keys resolve (non-fatal — defaults exist).
  ['SHOP_NAME', 'SHOP_WEBSITE', 'SHOP_CITY_STATE', 'PRESCREEN_FORM_URL', 'COMPANY_SIGNATURE_NAME']
    .forEach(function (k) {
      out.push('  ─ CFG ' + k + ' = "' + CFG.get(k) + '"');
    });

  out.push('[JOBPOSTINGS] selfTest done.');
  var msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
