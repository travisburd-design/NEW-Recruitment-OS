/**
 * 99_Export_Source.gs
 * Frank's European Service — Recruiting OS
 *
 * Utility: snapshot every source file in this Apps Script project (.gs, .html,
 * .json) into a new Google Doc, one section per file, monospace-formatted.
 * Returns the Doc URL.
 *
 * One-time setup:
 *   1) Turn ON "Google Apps Script API" at
 *      https://script.google.com/home/usersettings
 *   2) The appsscript.json manifest must include the scope
 *      https://www.googleapis.com/auth/script.projects.readonly
 *      (already added by this PR).
 *
 * Public functions:
 *   exportProjectToGoogleDoc()  — create the snapshot Doc
 */

function exportProjectToGoogleDoc() {
  var scriptId = ScriptApp.getScriptId();
  var token    = ScriptApp.getOAuthToken();

  var resp = UrlFetchApp.fetch(
    'https://script.googleapis.com/v1/projects/' + scriptId + '/content',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
  );
  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Apps Script API HTTP ' + code + ' — ' + resp.getContentText() +
      '\n\nIf this is your first time: enable "Google Apps Script API" at ' +
      'https://script.google.com/home/usersettings and re-run.');
  }
  var files = (JSON.parse(resp.getContentText()).files || [])
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

  var extOf = function (t) {
    if (t === 'SERVER_JS') return 'gs';
    if (t === 'HTML')      return 'html';
    if (t === 'JSON')      return 'json';
    return String(t || '').toLowerCase();
  };

  // Project title via the Apps Script API (no Drive dependency — DriveApp would
  // require Drive API to be enabled on the default GCP project, which isn't).
  var projectTitle = 'Apps Script project';
  try {
    var metaResp = UrlFetchApp.fetch(
      'https://script.googleapis.com/v1/projects/' + scriptId,
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (metaResp.getResponseCode() === 200) {
      projectTitle = JSON.parse(metaResp.getContentText()).title || projectTitle;
    }
  } catch (e) { /* fall back to default title */ }

  var tz       = Session.getScriptTimeZone();
  var stamp    = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  var docName  = 'Apps Script Source Snapshot — ' + projectTitle + ' — ' + stamp;
  var doc      = DocumentApp.create(docName);
  var body     = doc.getBody();
  body.clear();

  body.appendParagraph(docName).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('Script ID: ' + scriptId).setItalic(true);
  body.appendParagraph('Files: ' + files.length + '   ·   Exported: ' + stamp).setItalic(true);

  body.appendParagraph('Contents').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  files.forEach(function (f) { body.appendListItem(f.name + '.' + extOf(f.type)); });

  files.forEach(function (f) {
    body.appendPageBreak();
    body.appendParagraph(f.name + '.' + extOf(f.type))
        .setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph('Length: ' + String(f.source || '').length + ' chars').setItalic(true);
    var p = body.appendParagraph(String(f.source || ''));
    p.editAsText().setFontFamily('Courier New').setFontSize(9);
  });

  doc.saveAndClose();
  var url = doc.getUrl();
  Logger.log('Doc URL: ' + url);
  return url;
}
